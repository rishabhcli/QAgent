import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  Artifact,
  Diagnosis,
  Patch,
  Project,
  Provenance,
  ProviderCall,
  QAgentConfig,
  Run,
  RunEvent,
  RunRequest,
  RunStage,
  TestCase,
  Verification,
} from '@qagent/contracts';
import {
  detectBrowser,
  detectProject,
  GitHubPublisher,
  GitRepository,
  type ModelCredentials,
  type ModelProvider,
  parseGitHubRemote,
  inspectPatch,
  ProcessRunner,
  type CommandResult,
  createModelProvider,
  StagehandBrowser,
  type TraceSink,
  LocalTraceSink,
  type Worktree,
} from '@qagent/adapters';
import { ArtifactStore, type NewRunEvent, QAgentStorage } from '@qagent/storage';
import { z } from 'zod';
import { AsyncQueue } from './async-queue.js';
import { errorMessage, PolicyBlockedError, RunCancelledError } from './errors.js';
import { evaluatePublicationPolicy } from './policies.js';
import {
  DiagnosisOutputSchema,
  diagnosisPrompt,
  PATCH_SYSTEM_PROMPT,
  PatchOutputSchema,
  patchPrompt,
  TRIAGE_SYSTEM_PROMPT,
} from './prompts.js';
import { ActiveRunHandle, type RunHandle } from './run-handle.js';

export interface QAgentEngineOptions {
  storage: QAgentStorage;
  artifactStore: ArtifactStore;
  qagentHome: string;
  modelCredentials?: ModelCredentials;
  githubToken?: string;
  traceSink?: TraceSink;
  processRunner?: ProcessRunner;
  gitRepository?: GitRepository;
  browser?: StagehandBrowser;
  modelProviderFactory?: (config: QAgentConfig['model']) => ModelProvider;
  githubPublisherFactory?: (token: string) => GitHubPublisher;
  browserDetector?: typeof detectBrowser;
}

interface ExecutionContext {
  run: Run;
  project: Project;
  config: QAgentConfig;
  repository: Awaited<ReturnType<GitRepository['inspect']>>;
  worktree: Worktree;
  model: ModelProvider;
  signal: AbortSignal;
}

interface CheckOutcome {
  passed: boolean;
  output: string;
  artifacts: Artifact[];
  commandResults: Array<{ result: CommandResult; artifact: Artifact }>;
}

interface RepairOutcome {
  inspection: { files: string[]; highRisk: boolean };
  diagnosis: Diagnosis;
  patch: Patch;
  verification: Verification;
}

interface BrowserCheckOutcome {
  passed: boolean;
  output: string;
  artifacts: Artifact[];
}

const localProvenance = (): Provenance => ({
  source: 'local',
  capturedAt: new Date().toISOString(),
});

export class QAgentEngine {
  private readonly storage: QAgentStorage;
  private readonly artifactStore: ArtifactStore;
  private readonly qagentHome: string;
  private readonly traceSink: TraceSink;
  private readonly processRunner: ProcessRunner;
  private readonly gitRepository: GitRepository;
  private readonly browser: StagehandBrowser;
  private readonly modelProviderFactory: (config: QAgentConfig['model']) => ModelProvider;
  private readonly githubPublisherFactory: (token: string) => GitHubPublisher;
  private readonly browserDetector: typeof detectBrowser;
  private readonly githubToken?: string;
  private readonly active = new Map<
    string,
    { controller: AbortController; queue: AsyncQueue<RunEvent> }
  >();

  constructor(options: QAgentEngineOptions) {
    this.storage = options.storage;
    this.artifactStore = options.artifactStore;
    this.qagentHome = options.qagentHome;
    this.traceSink = options.traceSink ?? new LocalTraceSink();
    this.processRunner = options.processRunner ?? new ProcessRunner();
    this.gitRepository = options.gitRepository ?? new GitRepository();
    this.browser = options.browser ?? new StagehandBrowser();
    this.browserDetector = options.browserDetector ?? detectBrowser;
    this.githubToken = options.githubToken ?? process.env.GITHUB_TOKEN;
    this.modelProviderFactory =
      options.modelProviderFactory ??
      ((config) => createModelProvider(config, options.modelCredentials ?? {}));
    this.githubPublisherFactory =
      options.githubPublisherFactory ?? ((token) => new GitHubPublisher(token, this.gitRepository));
  }

  async addProject(projectPath: string, trusted = false): Promise<Project> {
    const detected = await detectProject(projectPath);
    const existing = this.storage.getProjectByPath(detected.path);
    if (existing) return trusted ? this.storage.setProjectTrust(existing.id, true) : existing;
    return this.storage.createProject({
      name: detected.name,
      path: detected.path,
      trusted,
      configPath: detected.configPath,
    });
  }

  trustProject(projectId: string, trusted = true): Project {
    return this.storage.setProjectTrust(projectId, trusted);
  }

  listProjects(): Project[] {
    return this.storage.listProjects();
  }

  listRuns(projectId?: string): Run[] {
    return this.storage.listRuns(projectId);
  }

  getRun(runId: string): Run | null {
    return this.storage.getRun(runId);
  }

  getRunEvents(runId: string, afterSequence = 0): RunEvent[] {
    return this.storage.listEvents(runId, afterSequence);
  }

  async startRun(request: RunRequest): Promise<RunHandle> {
    const project = this.storage.getProject(request.projectId);
    if (!project) throw new Error(`Project ${request.projectId} was not found`);
    const run = request.resumeRunId
      ? this.storage.getRun(request.resumeRunId)
      : this.storage.createRun({ projectId: request.projectId, requestedBy: request.requestedBy });
    if (!run) throw new Error(`Run ${request.resumeRunId} was not found`);
    if (run.projectId !== request.projectId) throw new Error('Run does not belong to this project');
    return this.activateRun(run, Boolean(request.resumeRunId));
  }

  async resumeInterruptedRuns(): Promise<RunHandle[]> {
    const handles: RunHandle[] = [];
    for (const run of this.storage.listInterruptedRuns()) {
      if (!this.active.has(run.id)) handles.push(this.activateRun(run, true));
    }
    return handles;
  }

  async cancelRun(runId: string, reason = 'Cancelled by user'): Promise<void> {
    const existing = this.storage.getRun(runId);
    if (existing?.status === 'queued' || existing?.status === 'running') {
      this.storage.requestRunCancellation(runId);
    }
    const active = this.active.get(runId);
    if (!active) {
      if (existing?.status === 'queued') {
        await this.finishRun(runId, 'cancelled', 'run.cancelled', reason);
      }
      return;
    }
    active.controller.abort(new RunCancelledError(reason));
  }

  private activateRun(run: Run, resume: boolean): RunHandle {
    if (this.active.has(run.id)) throw new Error(`Run ${run.id} is already active`);
    const controller = new AbortController();
    const queue = new AsyncQueue<RunEvent>();
    this.active.set(run.id, { controller, queue });
    const completion = this.executeRun(run, controller.signal, resume)
      .catch((error: unknown) => this.finishUnexpected(run.id, error))
      .finally(() => {
        queue.close();
        this.active.delete(run.id);
      });
    return new ActiveRunHandle(run.id, this.storage, queue, completion, (reason) =>
      this.cancelRun(run.id, reason)
    );
  }

  private async executeRun(run: Run, signal: AbortSignal, resume: boolean): Promise<Run> {
    let project: Project | null = null;
    let leaseTimer: NodeJS.Timeout | null = null;
    try {
      this.throwIfCancelled(signal);
      project = this.storage.getProject(run.projectId);
      if (!project) throw new Error(`Project ${run.projectId} was not found`);
      if (!project.trusted)
        throw new PolicyBlockedError('Trust this workspace before running commands');
      if (!this.storage.acquireLease(project.id, run.id)) {
        throw new PolicyBlockedError('Another QAgent process is already mutating this project');
      }
      const leasedProjectId = project.id;
      let leaseTicks = 0;
      leaseTimer = setInterval(() => {
        leaseTicks += 1;
        if (leaseTicks % 20 === 0) this.storage.renewLease(leasedProjectId, run.id);
        const durableRun = this.storage.getRun(run.id);
        if (durableRun?.cancelRequestedAt) {
          this.active
            .get(run.id)
            ?.controller.abort(new RunCancelledError('Cancellation requested by another client'));
        }
      }, 1_000);
      leaseTimer.unref();

      this.storage.updateRun(run.id, {
        status: 'running',
        error: null,
        completedAt: null,
        cancelRequestedAt: null,
      });
      await this.emit(run.id, {
        kind: 'run.created',
        stage: 'preflight',
        payload: { message: resume ? 'Resuming durable run' : 'Run created' },
        provenance: localProvenance(),
        artifactIds: [],
      });
      await this.startStage(
        run.id,
        'preflight',
        'Checking trust, configuration, Git, and isolation'
      );
      const detected = await detectProject(project.path);
      if (!detected.config) {
        throw new PolicyBlockedError('Project needs a valid .qagent.yml before QAgent can run');
      }
      const repository = await this.gitRepository.inspect(project.path);
      const worktree = await this.prepareWorktree(run, repository, project.name, resume);
      const model = this.modelProviderFactory(detected.config.model);
      const runTimeout = AbortSignal.timeout(detected.config.limits.maxRunMinutes * 60_000);
      const context: ExecutionContext = {
        run: this.storage.getRun(run.id) ?? run,
        project,
        config: detected.config,
        repository,
        worktree,
        model,
        signal: AbortSignal.any([signal, runTimeout]),
      };
      await this.completeStage(run.id, 'preflight', `Isolated on ${worktree.branch}`);

      await this.discoverTests(context);
      const testOutcome = await this.runTests(context, 'test');
      if (testOutcome.passed) {
        const changed = await this.gitRepository.changedFiles(worktree);
        if (changed.length === 0) {
          return this.completeRun(run.id, 'No defects found; every configured check passed.');
        }
        const resumedRepair = await this.verifyResumedRepair(context);
        return this.publishVerifiedRepair(context, resumedRepair);
      }

      const repair = await this.repairUntilVerified(
        context,
        testOutcome.output,
        testOutcome.artifacts
      );
      return await this.publishVerifiedRepair(context, repair);
    } catch (error) {
      if (signal.aborted || error instanceof RunCancelledError) {
        return this.finishRun(
          run.id,
          'cancelled',
          'run.cancelled',
          errorMessage(signal.reason ?? error)
        );
      }
      if (error instanceof PolicyBlockedError) {
        return this.finishRun(run.id, 'policy_blocked', 'run.policy_blocked', error.message);
      }
      return this.finishRun(run.id, 'failed', 'run.failed', errorMessage(error));
    } finally {
      if (leaseTimer) clearInterval(leaseTimer);
      if (project) this.storage.releaseLease(project.id, run.id);
    }
  }

  private async prepareWorktree(
    run: Run,
    repository: Awaited<ReturnType<GitRepository['inspect']>>,
    projectName: string,
    resume: boolean
  ): Promise<Worktree> {
    if (resume && run.worktreePath && run.branch && run.baseSha) {
      return this.gitRepository.restoreWorktree(run.worktreePath, run.branch, run.baseSha);
    }
    const worktree = await this.gitRepository.createWorktree(
      repository,
      join(this.qagentHome, 'worktrees'),
      run.id,
      projectName
    );
    this.storage.updateRun(run.id, {
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseSha: worktree.baseSha,
    });
    return worktree;
  }

  private async discoverTests(context: ExecutionContext): Promise<void> {
    await this.startStage(
      context.run.id,
      'discover',
      'Recording executable checks and browser flows'
    );
    const timestamp = new Date().toISOString();
    const provenance = localProvenance();
    const cases: TestCase[] = [
      ...context.config.test.commands.map((definition, index) => ({
        id: randomUUID(),
        projectId: context.project.id,
        name: `Command ${index + 1}: ${definition.executable} ${definition.args.join(' ')}`,
        kind: 'command' as const,
        definition,
        provenance,
        createdAt: timestamp,
      })),
      ...context.config.test.browserFlows.map((definition) => ({
        id: randomUUID(),
        projectId: context.project.id,
        name: definition.name,
        kind: 'browser' as const,
        definition,
        provenance,
        createdAt: timestamp,
      })),
    ];
    this.storage.replaceTestCases(context.project.id, cases);
    await this.completeStage(
      context.run.id,
      'discover',
      `Grounded ${cases.length} checks in .qagent.yml`
    );
  }

  private async runTests(
    context: ExecutionContext,
    stage: 'test' | 'postverify'
  ): Promise<CheckOutcome> {
    await this.startStage(
      context.run.id,
      stage,
      stage === 'test' ? 'Running checks' : 'Rechecking merged repair'
    );
    const commandOutcome = await this.runCommands(context, context.config.test.commands, stage);
    const browserOutcome = await this.runBrowserFlows(context, stage);
    const passed = commandOutcome.passed && browserOutcome.passed;
    await this.completeStage(
      context.run.id,
      stage,
      passed ? 'Every configured check passed' : 'One or more configured checks failed'
    );
    return {
      ...commandOutcome,
      passed,
      output: [commandOutcome.output, browserOutcome.output].filter(Boolean).join('\n\n'),
      artifacts: [...commandOutcome.artifacts, ...browserOutcome.artifacts],
    };
  }

  private async runBrowserFlows(
    context: ExecutionContext,
    stage: RunStage
  ): Promise<BrowserCheckOutcome> {
    if (context.config.test.browserFlows.length === 0) {
      return { passed: true, output: '', artifacts: [] };
    }
    if (!context.config.target.url) throw new Error('Browser flows require target.url');
    const browser = await this.browserDetector(
      context.config.browser.executablePath ?? process.env.QAGENT_BROWSER_PATH,
      join(this.qagentHome, 'browsers')
    );
    if (!browser) throw new PolicyBlockedError('No Chrome-compatible browser is available');
    const service = context.config.target.start
      ? await this.processRunner.start(
          context.worktree.path,
          context.config.target.start,
          context.signal
        )
      : null;
    const artifacts: Artifact[] = [];
    const output: string[] = [];
    try {
      const healthUrl = new URL(
        context.config.target.healthPath,
        context.config.target.url
      ).toString();
      await waitForUrl(healthUrl, context.signal);
      const evidence = await this.browser.runFlows({
        config: context.config,
        browser,
        targetUrl: context.config.target.url,
        flows: context.config.test.browserFlows,
        signal: context.signal,
      });
      for (const item of evidence) {
        const provenance: Provenance = {
          source: 'local',
          provider: browser.name,
          capturedAt: new Date().toISOString(),
        };
        const name = slug(item.flow);
        const screenshot = await this.artifactStore.save({
          runId: context.run.id,
          kind: 'screenshot',
          name: `${name}.png`,
          mimeType: 'image/png',
          data: item.screenshot,
          provenance,
        });
        const dom = await this.artifactStore.save({
          runId: context.run.id,
          kind: 'dom',
          name: `${name}.html`,
          mimeType: 'text/html',
          data: item.dom,
          provenance,
        });
        const report = await this.artifactStore.save({
          runId: context.run.id,
          kind: 'report',
          name: `${name}.json`,
          mimeType: 'application/json',
          data: `${JSON.stringify(
            { flow: item.flow, url: item.url, title: item.title, console: item.logs },
            null,
            2
          )}\n`,
          provenance,
        });
        artifacts.push(screenshot, dom, report);
        output.push(`${item.flow}: ${item.title} (${item.url})`);
        await this.emit(context.run.id, {
          kind: 'evidence.captured',
          stage,
          payload: { name: item.flow, kind: 'browser' },
          provenance,
          artifactIds: [screenshot.id, dom.id, report.id],
        });
      }
      return { passed: true, output: output.join('\n'), artifacts };
    } catch (error) {
      if (context.signal.aborted) throw error;
      const message = `Browser flow failed: ${errorMessage(error)}`;
      const artifact = await this.artifactStore.save({
        runId: context.run.id,
        kind: 'log',
        name: `${stage}-browser-error.log`,
        mimeType: 'text/plain',
        data: message,
        provenance: localProvenance(),
      });
      artifacts.push(artifact);
      await this.emit(context.run.id, {
        kind: 'evidence.captured',
        stage,
        payload: { name: 'Browser failure', kind: 'log' },
        provenance: artifact.provenance,
        artifactIds: [artifact.id],
      });
      return { passed: false, output: message, artifacts };
    } finally {
      await service?.stop();
    }
  }

  private async runCommands(
    context: ExecutionContext,
    commands: QAgentConfig['test']['commands'],
    stage: RunStage
  ): Promise<CheckOutcome> {
    const artifacts: Artifact[] = [];
    const commandResults: CheckOutcome['commandResults'] = [];
    const output: string[] = [];
    for (const command of commands) {
      this.throwIfCancelled(context.signal);
      await this.emit(context.run.id, {
        kind: 'command.started',
        stage,
        payload: { executable: command.executable, args: command.args },
        provenance: localProvenance(),
        artifactIds: [],
      });
      const result = await this.processRunner.run(context.worktree.path, command, context.signal);
      const log = formatCommandLog(result);
      const artifact = await this.artifactStore.save({
        runId: context.run.id,
        kind: 'log',
        name: `${stage}-${artifacts.length + 1}.log`,
        mimeType: 'text/plain',
        data: log,
        provenance: localProvenance(),
      });
      artifacts.push(artifact);
      commandResults.push({ result, artifact });
      output.push(log);
      await this.emit(context.run.id, {
        kind: 'command.completed',
        stage,
        payload: {
          executable: command.executable,
          args: command.args,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        },
        provenance: artifact.provenance,
        artifactIds: [artifact.id],
      });
    }
    return {
      passed: commandResults.every(({ result }) => result.exitCode === 0),
      output: output.join('\n\n'),
      artifacts,
      commandResults,
    };
  }

  private async verifyResumedRepair(context: ExecutionContext): Promise<RepairOutcome> {
    const diagnosis = this.storage.getDiagnosis(context.run.id);
    const patch = this.storage.getPatch(context.run.id);
    if (!diagnosis || !patch) {
      throw new Error(
        'Interrupted worktree has changes but no durable diagnosis and patch records'
      );
    }
    const verification = await this.verify(context);
    if (!verification.passed) throw new Error('The resumed repair no longer passes verification');
    const diff = await this.gitRepository.diff(context.worktree);
    return { inspection: inspectPatch(diff), diagnosis, patch, verification };
  }

  private async repairUntilVerified(
    context: ExecutionContext,
    initialFailure: string,
    evidence: Artifact[]
  ): Promise<RepairOutcome> {
    let failure = initialFailure;
    let previousAttempt: string | undefined;
    const changedFiles = new Set<string>();
    let highRisk = false;

    for (let iteration = 1; iteration <= context.config.limits.maxIterations; iteration += 1) {
      this.throwIfCancelled(context.signal);
      await this.startStage(
        context.run.id,
        'triage',
        `Diagnosing grounded failure (${iteration}/${context.config.limits.maxIterations})`
      );
      const diagnosisCompletion = await this.callModel(
        context,
        'triage',
        TRIAGE_SYSTEM_PROMPT,
        diagnosisPrompt(failure),
        'qagent_diagnosis',
        DiagnosisOutputSchema
      );
      const latestDiagnosis = this.storage.createDiagnosis({
        id: randomUUID(),
        runId: context.run.id,
        summary: diagnosisCompletion.summary,
        rootCause: diagnosisCompletion.rootCause,
        confidence: diagnosisCompletion.confidence,
        evidenceArtifactIds: evidence.map((artifact) => artifact.id),
        provenance: {
          source: 'provider',
          provider: `${context.model.provider}/${context.model.model}`,
          capturedAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      });
      await this.emit(context.run.id, {
        kind: 'diagnosis.created',
        stage: 'triage',
        payload: {
          diagnosisId: latestDiagnosis.id,
          summary: latestDiagnosis.summary,
          confidence: latestDiagnosis.confidence,
        },
        provenance: latestDiagnosis.provenance,
        artifactIds: latestDiagnosis.evidenceArtifactIds,
      });
      await this.completeStage(context.run.id, 'triage', latestDiagnosis.summary);

      await this.startStage(context.run.id, 'patch', 'Generating and validating a minimal patch');
      const repositoryContext = await this.gitRepository.gatherContext(
        context.worktree.path,
        failure
      );
      const patchCompletion = await this.callModel(
        context,
        'patch',
        PATCH_SYSTEM_PROMPT,
        patchPrompt({
          failure,
          diagnosis: latestDiagnosis.rootCause,
          context: repositoryContext,
          previousAttempt,
        }),
        'qagent_patch',
        PatchOutputSchema
      );
      const patchArtifact = await this.artifactStore.save({
        runId: context.run.id,
        kind: 'patch',
        name: `repair-${iteration}.diff`,
        mimeType: 'text/x-diff',
        data: patchCompletion.unifiedDiff,
        provenance: {
          source: 'provider',
          provider: `${context.model.provider}/${context.model.model}`,
          capturedAt: new Date().toISOString(),
        },
      });

      let latestPatch: Patch;
      try {
        const inspection = await this.gitRepository.applyPatch(
          context.worktree,
          patchCompletion.unifiedDiff,
          context.config.limits.maxPatchBytes
        );
        inspection.files.forEach((file) => changedFiles.add(file));
        highRisk ||= inspection.highRisk;
        latestPatch = this.storage.createPatch({
          id: randomUUID(),
          runId: context.run.id,
          diagnosisId: latestDiagnosis.id,
          artifactId: patchArtifact.id,
          summary: patchCompletion.summary,
          files: inspection.files,
          risk: inspection.highRisk ? 'high' : 'normal',
          applied: true,
          createdAt: new Date().toISOString(),
        });
        await this.emit(context.run.id, {
          kind: 'patch.created',
          stage: 'patch',
          payload: {
            patchId: latestPatch.id,
            summary: latestPatch.summary,
            files: latestPatch.files,
          },
          provenance: patchArtifact.provenance,
          artifactIds: [patchArtifact.id],
        });
        await this.completeStage(context.run.id, 'patch', latestPatch.summary);
      } catch (error) {
        this.storage.createPatch({
          id: randomUUID(),
          runId: context.run.id,
          diagnosisId: latestDiagnosis.id,
          artifactId: patchArtifact.id,
          summary: patchCompletion.summary,
          files: [],
          risk: 'normal',
          applied: false,
          createdAt: new Date().toISOString(),
        });
        previousAttempt = `Patch validation failed: ${errorMessage(error)}`;
        await this.completeStage(context.run.id, 'patch', previousAttempt);
        continue;
      }

      const latestVerification = await this.verify(context);
      if (latestVerification.passed) {
        return {
          inspection: { files: [...changedFiles], highRisk },
          diagnosis: latestDiagnosis,
          patch: latestPatch,
          verification: latestVerification,
        };
      }
      const failedLogs = latestVerification.artifactIds
        .map((artifactId) => this.storage.getArtifact(artifactId))
        .filter((artifact): artifact is Artifact => Boolean(artifact));
      evidence = failedLogs;
      failure = `Verification failed after repair attempt ${iteration}. See captured command artifacts.`;
      previousAttempt = failure;
    }
    throw new Error(
      `No verified repair was found after ${context.config.limits.maxIterations} attempts`
    );
  }

  private async verify(context: ExecutionContext): Promise<Verification> {
    await this.startStage(context.run.id, 'verify', 'Running configured verification commands');
    const commands =
      context.config.verify.commands.length > 0
        ? context.config.verify.commands
        : context.config.test.commands;
    const outcome = await this.runCommands(context, commands, 'verify');
    const browserOutcome = await this.runBrowserFlows(context, 'verify');
    const verification = this.storage.createVerification({
      id: randomUUID(),
      runId: context.run.id,
      passed: outcome.passed && browserOutcome.passed,
      commands: outcome.commandResults.map(({ result, artifact }) => ({
        executable: result.executable,
        args: result.args,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        artifactId: artifact.id,
      })),
      artifactIds: [
        ...outcome.artifacts.map((artifact) => artifact.id),
        ...browserOutcome.artifacts.map((artifact) => artifact.id),
      ],
      createdAt: new Date().toISOString(),
    });
    await this.emit(context.run.id, {
      kind: 'verification.completed',
      stage: 'verify',
      payload: { verificationId: verification.id, passed: verification.passed },
      provenance: localProvenance(),
      artifactIds: verification.artifactIds,
    });
    await this.completeStage(
      context.run.id,
      'verify',
      verification.passed ? 'Repair passed verification' : 'Repair failed verification'
    );
    return verification;
  }

  private async publishVerifiedRepair(
    context: ExecutionContext,
    repair: RepairOutcome
  ): Promise<Run> {
    const changedFiles = await this.gitRepository.changedFiles(context.worktree);
    if (changedFiles.length === 0)
      throw new Error('Verified repair did not leave any changed files');
    await this.gitRepository.commit(
      context.worktree,
      changedFiles,
      `fix: ${repair.patch.summary.slice(0, 72)}`
    );

    const policy = evaluatePublicationPolicy({
      originalCheckoutDirty: context.repository.dirty,
      patch: { files: changedFiles, highRisk: repair.inspection.highRisk },
      configuredAutoMerge: context.config.publish.autoMerge,
    });
    await this.startStage(context.run.id, 'publish', 'Publishing the verified repair');
    if (!policy.mayPublish) {
      await this.completeStage(context.run.id, 'publish', policy.reason ?? 'Publication blocked');
      throw new PolicyBlockedError(policy.reason ?? 'Publication blocked by policy');
    }

    const remote = context.repository.origin ? parseGitHubRemote(context.repository.origin) : null;
    if (context.config.publish.provider === 'local' || !remote) {
      await this.completeStage(
        context.run.id,
        'publish',
        `Verified branch ${context.worktree.branch} is available locally`
      );
      await this.learn(context, repair);
      return this.completeRun(
        context.run.id,
        `Repair verified on local branch ${context.worktree.branch}.`
      );
    }
    if (!this.githubToken) {
      await this.completeStage(
        context.run.id,
        'publish',
        'Verified locally; GitHub credential is unavailable'
      );
      throw new PolicyBlockedError(
        `Repair is verified on ${context.worktree.branch}, but GITHUB_TOKEN is not configured`
      );
    }

    try {
      const rebased = await this.gitRepository.rebaseOnce(
        context.worktree,
        context.config.publish.baseBranch
      );
      if (rebased) await this.reverifyRebasedRepair(context);
    } catch (error) {
      throw new PolicyBlockedError(`The branch conflicted with its base: ${errorMessage(error)}`);
    }
    const publisher = this.githubPublisherFactory(this.githubToken);
    let publication = await publisher.publish({
      repository: remote,
      worktree: context.worktree,
      baseBranch: context.config.publish.baseBranch,
      title: `QAgent: ${repair.patch.summary}`,
      body: publicationBody(context, repair),
      autoMerge: policy.mayAutoMerge,
      highRisk: repair.inspection.highRisk,
      mergeMethod: context.config.publish.mergeMethod,
      signal: context.signal,
    });
    await this.emit(context.run.id, {
      kind: 'publication.created',
      stage: 'publish',
      payload: {
        url: publication.url,
        number: publication.number,
        autoMerge: publication.autoMergeEnabled,
      },
      provenance: {
        source: 'github',
        provider: `${remote.owner}/${remote.repo}`,
        capturedAt: new Date().toISOString(),
      },
      artifactIds: [repair.patch.artifactId],
    });

    if (publication.state === 'conflict') {
      await this.emit(context.run.id, {
        kind: 'publication.updated',
        stage: 'publish',
        payload: { state: 'conflict', detail: publication.detail },
        provenance: {
          source: 'github',
          provider: `${remote.owner}/${remote.repo}`,
          capturedAt: new Date().toISOString(),
        },
        artifactIds: [],
      });
      try {
        await this.gitRepository.rebaseOnce(context.worktree, context.config.publish.baseBranch);
        await this.reverifyRebasedRepair(context);
        await this.gitRepository.push(context.worktree);
      } catch (error) {
        throw new PolicyBlockedError(
          `The pull request still conflicts after one rebase attempt: ${errorMessage(error)}`
        );
      }
      const refreshed = await publisher.waitForPull(remote, publication.number, context.signal);
      publication = {
        ...publication,
        ...refreshed,
        detail:
          refreshed.state === 'merged'
            ? 'GitHub merged the reverified pull request after repository requirements passed.'
            : refreshed.state === 'conflict'
              ? 'The pull request still conflicts after one rebase and reverify attempt.'
              : 'The reverified pull request remains open for repository requirements.',
      };
    }
    await this.completeStage(
      context.run.id,
      'publish',
      `Pull request #${publication.number} created`
    );

    await this.startStage(context.run.id, 'wait_checks', 'Waiting for repository requirements');
    const publicationDetail = publication.detail ?? `Pull request is ${publication.state}`;
    await this.emit(context.run.id, {
      kind: 'publication.updated',
      stage: 'wait_checks',
      payload: { state: publication.state, detail: publicationDetail },
      provenance: {
        source: 'github',
        provider: `${remote.owner}/${remote.repo}`,
        capturedAt: new Date().toISOString(),
      },
      artifactIds: [],
    });
    await this.completeStage(context.run.id, 'wait_checks', publicationDetail);

    if (publication.state !== 'merged') {
      throw new PolicyBlockedError(
        publication.detail ?? 'Pull request remains open and requires repository action'
      );
    }
    await this.startStage(context.run.id, 'merge', 'Recording the repository-controlled merge');
    await this.completeStage(context.run.id, 'merge', 'GitHub merged the verified repair');

    if (!publication.mergeCommitSha) {
      throw new PolicyBlockedError(
        'GitHub did not report the merged commit; exact post-merge verification was not started'
      );
    }
    await this.gitRepository.checkoutMergedCommit(
      context.worktree,
      context.config.publish.baseBranch,
      publication.mergeCommitSha
    );

    const postverify = await this.runTests(context, 'postverify');
    if (!postverify.passed) {
      throw new Error('Post-merge verification failed in the isolated worktree');
    }
    await this.learn(context, repair);
    return this.completeRun(context.run.id, `Repair merged in ${publication.url}.`);
  }

  private async reverifyRebasedRepair(context: ExecutionContext): Promise<void> {
    const verification = await this.verify(context);
    if (!verification.passed) {
      throw new PolicyBlockedError('The repair failed verification after rebasing onto the base');
    }
  }

  private async learn(context: ExecutionContext, repair: RepairOutcome): Promise<void> {
    await this.startStage(context.run.id, 'learn', 'Persisting the verified local repair pattern');
    const importedAt = new Date().toISOString();
    const artifact = this.storage.getArtifact(repair.patch.artifactId);
    const diff = artifact ? (await this.artifactStore.read(artifact)).toString('utf8') : null;
    this.storage.importKnowledgeEntries([
      {
        id: randomUUID(),
        failureSummary: repair.diagnosis.summary,
        failureType: 'VERIFIED_REPAIR',
        file: repair.patch.files[0] ?? null,
        fixSummary: repair.patch.summary,
        fixPatch: diff,
        successful: true,
        provenance: localProvenance(),
        importedAt,
      },
    ]);
    await this.completeStage(context.run.id, 'learn', 'Verified repair stored locally');
  }

  private async callModel<T>(
    context: ExecutionContext,
    purpose: 'triage' | 'patch',
    system: string,
    prompt: string,
    schemaName: string,
    schema: z.ZodType<T>
  ): Promise<T> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    try {
      const completion = await context.model.complete({
        purpose,
        system,
        prompt,
        schemaName,
        schema,
        signal: context.signal,
      });
      const call: ProviderCall = {
        id,
        runId: context.run.id,
        provider: context.model.provider,
        model: context.model.model,
        purpose,
        status: 'succeeded',
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        costUsd: null,
        error: null,
        createdAt,
      };
      this.storage.recordProviderCall(call);
      return completion.value;
    } catch (error) {
      this.storage.recordProviderCall({
        id,
        runId: context.run.id,
        provider: context.model.provider,
        model: context.model.model,
        purpose,
        status: 'failed',
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        error: errorMessage(error),
        createdAt,
      });
      throw error;
    }
  }

  private async startStage(runId: string, stage: RunStage, message: string): Promise<void> {
    this.storage.updateRun(runId, { stage, status: 'running' });
    await this.emit(runId, {
      kind: 'stage.started',
      stage,
      payload: { message },
      provenance: localProvenance(),
      artifactIds: [],
    });
  }

  private async completeStage(runId: string, stage: RunStage, message: string): Promise<void> {
    await this.emit(runId, {
      kind: 'stage.completed',
      stage,
      payload: { message },
      provenance: localProvenance(),
      artifactIds: [],
    });
  }

  private async emit(runId: string, input: NewRunEvent): Promise<RunEvent> {
    const event = this.storage.appendEvent(runId, input);
    this.active.get(runId)?.queue.push(event);
    void this.traceSink.send(event).catch(() => 'failed');
    return event;
  }

  private async completeRun(runId: string, summary: string): Promise<Run> {
    this.storage.updateRun(runId, { stage: 'complete' });
    return this.finishRun(runId, 'succeeded', 'run.completed', summary);
  }

  private async finishRun(
    runId: string,
    status: 'succeeded' | 'failed' | 'cancelled' | 'policy_blocked',
    kind: 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.policy_blocked',
    message: string
  ): Promise<Run> {
    const existing = this.storage.getRun(runId);
    if (!existing) throw new Error(`Run ${runId} was not found`);
    const run = this.storage.updateRun(runId, {
      status,
      summary: status === 'succeeded' ? message : existing.summary,
      error: status === 'succeeded' ? null : message,
      completedAt: new Date().toISOString(),
    });
    await this.emit(runId, {
      kind,
      stage: run.stage,
      payload: { message },
      provenance: localProvenance(),
      artifactIds: [],
    });
    return run;
  }

  private finishUnexpected(runId: string, error: unknown): Promise<Run> {
    return this.finishRun(runId, 'failed', 'run.failed', errorMessage(error));
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason ?? new RunCancelledError('Run cancelled');
  }
}

function formatCommandLog(result: CommandResult): string {
  return [
    `$ ${[result.executable, ...result.args].join(' ')}`,
    `exit=${result.exitCode ?? 'signal'} durationMs=${result.durationMs} timedOut=${result.timedOut}`,
    result.combined,
  ].join('\n');
}

async function waitForUrl(url: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 30_000;
  let latest = 'No response';
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      latest = `HTTP ${response.status}`;
    } catch (error) {
      latest = errorMessage(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Target did not become healthy at ${url}: ${latest}`);
}

function publicationBody(context: ExecutionContext, repair: RepairOutcome): string {
  return [
    '## QAgent repair',
    '',
    repair.diagnosis.summary,
    '',
    `- Root cause: ${repair.diagnosis.rootCause}`,
    `- Confidence: ${Math.round(repair.diagnosis.confidence * 100)}%`,
    `- Files: ${repair.patch.files.map((file) => `\`${file}\``).join(', ')}`,
    `- Risk: ${repair.patch.risk}`,
    `- Verification commands: ${repair.verification.commands.length}`,
    `- Run: ${context.run.id}`,
    '',
    'Generated and verified in an isolated Git worktree. Repository checks and branch protection remain authoritative.',
  ].join('\n');
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'flow'
  );
}
