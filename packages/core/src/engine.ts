import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Artifact,
  BoundedOutput,
  CorrectiveAction,
  Diagnosis,
  EvidenceLink,
  Integration,
  IntegrationVerifyRequest,
  IntegrationVerifyResult,
  Patch,
  Project,
  PublicationState,
  Provenance,
  ProviderCall,
  QAgentConfig,
  ReplayEventsRequest,
  Run,
  RunActionRequest,
  RunActionResult,
  RunAttentionReason,
  RunDetail,
  RunEvent,
  RunEventReplayPage,
  RunIntervention,
  RunIsolation,
  RunLaunch,
  RunPolicyBoundary,
  RunRequest,
  RunStage,
  SpecialistActivity,
  SpecialistRole,
  SpecialistSource,
  TestCase,
  TerminalEvidence,
  Verification,
} from '@qagent/contracts';
import {
  IntegrationVerifyResultSchema,
  RunActionRequestSchema,
  RunActionResultSchema,
  RunDetailSchema,
  RunLaunchSchema,
} from '@qagent/contracts';
import {
  BrowserFlowError,
  BrowserModelOutputError,
  BrowserModelProviderError,
  type BrowserEvidence,
  type BrowserSessionMetadata,
  detectBrowser,
  detectProject,
  GitHubPublisher,
  type GitHubRepositoryProbe,
  GitRepository,
  type ModelCredentials,
  type ModelProvider,
  parseGitHubRemote,
  inspectPatch,
  ProcessRunner,
  type CommandResult,
  type ManagedProcess,
  createModelProvider,
  StagehandBrowser,
  type TraceSink,
  type TraceState,
  LocalTraceSink,
  WeaveTraceSink,
  type Worktree,
  runCredentialBackedSmoke,
} from '@qagent/adapters';
import {
  ArtifactStore,
  type NewRunEvent,
  QAgentStorage,
  type RunCheckpoint,
  type TerminalRunEvent,
} from '@qagent/storage';
import { z } from 'zod';
import { AsyncQueue } from './async-queue.js';
import {
  errorMessage,
  LeaseLostError,
  PolicyBlockedError,
  RunAttentionError,
  RunCancelledError,
  RuntimeShutdownError,
} from './errors.js';
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
  githubApiBaseUrl?: string;
  allowInsecureGitHubApiEndpoint?: boolean;
  browserDetector?: typeof detectBrowser;
}

interface ExecutionContext {
  run: Run;
  project: Project;
  config: QAgentConfig;
  repository: Awaited<ReturnType<GitRepository['inspect']>>;
  worktree: Worktree;
  model: ModelProvider | null;
  signal: AbortSignal;
  assertLease: () => void;
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

type ActivationMode = 'start' | 'resume' | 'retry' | 'reconnect';

export interface RunActionExecution {
  result: RunActionResult;
  handle: RunHandle | null;
}

class TargetStartupError extends Error {
  override readonly name = 'TargetStartupError';
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
  private readonly traceStates = new Map<string, TraceState>();
  private readonly settlingRuns = new Set<string>();
  private readonly activeStageAttempts = new Map<string, { id: string; stage: RunStage }>();
  private shuttingDown = false;
  private readonly active = new Map<
    string,
    {
      controller: AbortController;
      queue: AsyncQueue<RunEvent>;
      completion: Promise<Run> | null;
    }
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
      options.githubPublisherFactory ??
      ((token) =>
        new GitHubPublisher(token, this.gitRepository, {
          apiBaseUrl: options.githubApiBaseUrl,
          allowInsecureLoopback: options.allowInsecureGitHubApiEndpoint,
        }));
    this.storage.subscribeEvents((event) => this.dispatchPersistedEvent(event));
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

  replayEvents(request: ReplayEventsRequest): RunEventReplayPage {
    return this.storage.replayEvents(request);
  }

  getRunDetail(runId: string, afterSequence = 0): RunDetail {
    const run = this.storage.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found`);
    const events = this.storage.listEvents(runId, afterSequence);
    const allEvents = afterSequence === 0 ? events : this.storage.listEvents(runId);
    const latestSequence = allEvents.at(-1)?.sequence ?? 0;
    const specialistActivities = this.storage.listSpecialistActivities(runId);
    const specialistCritiques = this.storage.listSpecialistCritiques(runId);
    const specialistDecisions = this.storage.listSpecialistDecisions(runId);
    const specialistObjections = allEvents.flatMap((event) =>
      event.kind === 'specialist.objection' ? [event.payload.objection] : []
    );
    const specialistHandoffs = allEvents.flatMap((event) =>
      event.kind === 'specialist.handoff' ? [event.payload.handoff] : []
    );
    const terminalEvidence =
      allEvents.findLast((event) => event.kind === 'terminal.evidence')?.payload.evidence ?? null;
    const publication = this.publicationFromEvents(run, allEvents);
    const evidenceLinks: EvidenceLink[] = dedupeEvidenceLinks([
      ...specialistActivities.flatMap((activity) =>
        activity.evidenceIds.map((artifactId) => ({
          artifactId,
          label: activity.summary,
          relationship: 'produced' as const,
        }))
      ),
      ...specialistDecisions.flatMap((decision) =>
        decision.evidenceIds.map((artifactId) => ({
          artifactId,
          label: decision.summary,
          relationship: 'supports' as const,
        }))
      ),
      ...specialistObjections.flatMap((objection) =>
        objection.evidenceIds.map((artifactId) => ({
          artifactId,
          label: objection.summary,
          relationship: 'contradicts' as const,
        }))
      ),
      ...(terminalEvidence?.evidenceLinks ?? []),
    ]);
    return RunDetailSchema.parse({
      run,
      events,
      artifacts: this.storage.listArtifacts(runId),
      diagnosis: this.storage.getDiagnosis(runId),
      patch: this.storage.getPatch(runId),
      verification: this.storage.getVerification(runId),
      providerCalls: this.storage.listProviderCalls(runId),
      specialistActivities,
      specialistCritiques,
      specialistDecisions,
      specialistObjections,
      specialistHandoffs,
      stageAttempts: this.storage.listStageAttempts(runId),
      projection: this.storage.getRunProjection(runId),
      manifest: this.storage.getRunManifest(runId),
      terminalEvidence,
      publication,
      cursor: {
        runId,
        afterSequence,
        latestSequence,
        hasMore: false,
      },
      evidenceLinks,
    });
  }

  async waitForRunLaunch(runId: string, timeoutMs = 30_000): Promise<RunLaunch> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = this.storage
        .listEvents(runId)
        .findLast((candidate) => candidate.kind === 'run.isolation_ready');
      if (event?.kind === 'run.isolation_ready') return this.buildRunLaunch(runId, event.payload);
      const run = this.storage.getRun(runId);
      if (!run) throw new Error(`Run ${runId} was not found`);
      if (!['queued', 'running'].includes(run.status)) return this.buildRunLaunch(runId);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.buildRunLaunch(runId);
  }

  private async buildRunLaunch(
    runId: string,
    payload?: { isolation: RunIsolation; policyBoundary: RunPolicyBoundary }
  ): Promise<RunLaunch> {
    const run = this.storage.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found`);
    const project = this.storage.getProject(run.projectId);
    if (!project) throw new Error(`Project ${run.projectId} was not found`);
    const detected = await detectProject(project.path, { configPath: project.configPath });
    const config = detected.config;
    const isolation: RunIsolation =
      payload?.isolation ??
      ({
        state:
          run.worktreePath && run.branch && run.baseSha
            ? 'ready'
            : ['queued', 'running', 'interrupted'].includes(run.status)
              ? 'pending'
              : 'unavailable',
        canonicalProjectPath: project.path,
        worktreePath: run.worktreePath,
        branch: run.branch,
        baseSha: run.baseSha,
      } satisfies RunIsolation);
    const policyBoundary: RunPolicyBoundary =
      payload?.policyBoundary ??
      ({
        mutationMode: 'dedicated-worktree',
        activeCheckoutMutationAllowed: false,
        dirtyCheckoutPublicationAllowed: false,
        highRiskAutoMergeAllowed: false,
        originalCheckoutDirty: true,
        publishProvider: config?.publish.provider ?? 'local',
        baseBranch: config?.publish.baseBranch ?? 'unknown',
        autoMergeRequested: config?.publish.autoMerge ?? false,
        publicationAllowed: false,
        autoMergeAllowed: false,
        blockedReasons: ['Isolation and source-checkout state have not been durably observed.'],
      } satisfies RunPolicyBoundary);
    return RunLaunchSchema.parse({
      run,
      project,
      isolation,
      policyBoundary,
      commands: {
        test: config?.test.commands ?? [],
        verify: config?.verify.commands ?? [],
        start: config?.target.start ?? null,
      },
    });
  }

  private publicationFromEvents(run: Run, events: RunEvent[]): PublicationState | null {
    const created = events.findLast((event) => event.kind === 'publication.created');
    if (!created || created.kind !== 'publication.created') return null;
    const isolation = events.findLast((event) => event.kind === 'run.isolation_ready');
    const updated = events.findLast((event) => event.kind === 'publication.updated');
    const observedState =
      updated?.kind === 'publication.updated' ? updated.payload.state.toLowerCase() : 'open';
    const state: PublicationState['state'] =
      observedState === 'merged'
        ? 'merged'
        : observedState === 'conflict'
          ? 'merge_conflict'
          : observedState === 'closed' || observedState === 'blocked'
            ? 'closed'
            : observedState.includes('queue')
              ? 'merge_queue'
              : observedState.includes('review')
                ? 'waiting_for_review'
                : 'waiting_for_checks';
    const capturedAt =
      updated?.kind === 'publication.updated' ? updated.occurredAt : created.occurredAt;
    return {
      provider: 'github',
      repository: created.provenance.provider ?? 'unknown',
      number: created.payload.number,
      url: created.payload.url,
      headBranch: run.branch ?? 'unknown',
      baseBranch:
        isolation?.kind === 'run.isolation_ready'
          ? isolation.payload.policyBoundary.baseBranch
          : 'unknown',
      state,
      requiredAction:
        state === 'merged'
          ? null
          : applicationAction(
              'review-pull-request',
              'Review pull request',
              'Inspect current repository requirements, then reconnect for a fresh observation.',
              'review_pull_request'
            ),
      capturedAt,
    };
  }

  private async rejectRunAction(
    run: Run,
    action: RunActionRequest['action'],
    reason: string
  ): Promise<RunActionExecution> {
    const event = await this.emit(run.id, {
      kind: 'action.rejected',
      stage: run.stage,
      payload: { action, reason },
      provenance: localProvenance(),
      artifactIds: [],
    });
    return {
      result: RunActionResultSchema.parse({
        action,
        requestedRunId: run.id,
        runId: run.id,
        accepted: false,
        eventIds: [event.id],
        reason,
        occurredAt: event.occurredAt,
      }),
      handle: null,
    };
  }

  private async emitIsolationReady(context: ExecutionContext): Promise<void> {
    const policy = evaluatePublicationPolicy({
      originalCheckoutDirty: context.repository.dirty,
      patch: { files: [], highRisk: false },
      configuredAutoMerge: context.config.publish.autoMerge,
    });
    const isolation: RunIsolation = {
      state: 'ready',
      canonicalProjectPath: context.project.path,
      worktreePath: context.worktree.path,
      branch: context.worktree.branch,
      baseSha: context.worktree.baseSha,
    };
    const policyBoundary: RunPolicyBoundary = {
      mutationMode: 'dedicated-worktree',
      activeCheckoutMutationAllowed: false,
      dirtyCheckoutPublicationAllowed: false,
      highRiskAutoMergeAllowed: false,
      originalCheckoutDirty: context.repository.dirty,
      publishProvider: context.config.publish.provider,
      baseBranch: context.config.publish.baseBranch,
      autoMergeRequested: context.config.publish.autoMerge,
      publicationAllowed: policy.mayPublish,
      autoMergeAllowed: policy.mayAutoMerge,
      blockedReasons: policy.reason ? [policy.reason] : [],
    };
    await this.emit(context.run.id, {
      kind: 'run.isolation_ready',
      stage: 'preflight',
      payload: { isolation, policyBoundary },
      provenance: localProvenance(),
      artifactIds: [],
    });
  }

  private async requireIntervention(runId: string, error: RunAttentionError): Promise<Run> {
    const run = this.storage.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found`);
    if (['succeeded', 'failed', 'cancelled', 'policy_blocked'].includes(run.status)) return run;
    const current = run.intervention;
    if (current && current.resolvedAt === null && current.reason === error.reason) return run;
    const evidenceArtifactIds = error.evidenceArtifactIds.filter((artifactId) => {
      const artifact = this.storage.getArtifact(artifactId);
      return artifact?.runId === runId;
    });
    if (evidenceArtifactIds.length === 0) {
      const artifact = await this.artifactStore.save({
        runId,
        kind: 'report',
        name: `intervention-${error.reason}.json`,
        mimeType: 'application/json',
        data: `${JSON.stringify(
          {
            reason: error.reason,
            summary: this.storage.redactText(error.message),
            requiredAction: error.requiredAction,
            capturedAt: new Date().toISOString(),
          },
          null,
          2
        )}\n`,
        provenance: localProvenance(),
      });
      evidenceArtifactIds.push(artifact.id);
    }
    const intervention: RunIntervention = {
      id: randomUUID(),
      runId,
      reason: error.reason,
      summary: error.message,
      requiredAction: error.requiredAction,
      resolutionOptions: error.resolutionOptions,
      evidenceArtifactIds,
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
      resolution: null,
    };
    this.settleActiveStage(runId, 'failed', error.message, evidenceArtifactIds);
    const committed = this.storage.commitRunEvent({
      runId,
      runUpdate: {
        status: 'waiting_for_intervention',
        error: error.message,
        failureCode: error.reason,
        intervention,
        availableActions: error.availableActions,
        lastHeartbeatAt: new Date().toISOString(),
      },
      event: {
        kind: 'intervention.required',
        stage: run.stage,
        payload: { intervention },
        provenance: localProvenance(),
        artifactIds: evidenceArtifactIds,
      },
    });
    this.recordGateAssessment({
      runId,
      stage: run.stage,
      action: 'block',
      summary: `Gate blocked continuation: ${error.message}`,
      evidenceIds: evidenceArtifactIds,
      actionRequired: error.requiredAction.description,
    });
    return committed.run;
  }

  private async interruptRun(runId: string, message: string): Promise<Run> {
    const run = this.storage.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found`);
    if (['succeeded', 'failed', 'cancelled', 'policy_blocked'].includes(run.status)) return run;
    const recoveryCount = run.recoveryCount + 1;
    this.settleActiveStage(runId, 'interrupted', message, []);
    const committed = this.storage.commitRunEvent({
      runId,
      runUpdate: {
        status: 'interrupted',
        error: message,
        failureCode: 'interrupted_recovery',
        availableActions: ['resume', 'cancel'],
        recoveryCount,
        lastHeartbeatAt: new Date().toISOString(),
      },
      event: {
        kind: 'run.interrupted',
        stage: run.stage,
        payload: { message, recoveryCount },
        provenance: localProvenance(),
        artifactIds: [],
      },
    });
    return committed.run;
  }

  private recordIntegration(
    provider: string,
    status: Integration['status'],
    detail: string,
    source: Provenance['source'],
    sourceUrl?: string,
    provenanceProvider = provider
  ): Integration {
    const updatedAt = new Date().toISOString();
    const existing = this.storage.getIntegration(provider);
    const sanitizedSourceUrl = sourceUrl && isSanitizedHttpsUrl(sourceUrl) ? sourceUrl : undefined;
    const newEvidence =
      sanitizedSourceUrl && (status === 'healthy' || status === 'end-to-end-verified')
        ? {
            sourceUrl: sanitizedSourceUrl,
            capturedAt: updatedAt,
            kind:
              status === 'end-to-end-verified'
                ? ('end-to-end-workflow' as const)
                : ('provider-probe' as const),
            authorization: 'verified' as const,
            summary: detail.slice(0, 2_000),
          }
        : null;
    const evidence = newEvidence
      ? [
          ...(existing?.evidence ?? []).filter(
            (item) => item.sourceUrl !== newEvidence.sourceUrl || item.kind !== newEvidence.kind
          ),
          newEvidence,
        ].slice(-16)
      : (existing?.evidence ?? []);
    return this.storage.upsertIntegration({
      id: existing?.id ?? randomUUID(),
      provider,
      status,
      detail,
      requirements: existing?.requirements ?? [],
      evidence,
      provenance: {
        source,
        provider: provenanceProvider,
        capturedAt: updatedAt,
        ...(sanitizedSourceUrl ? { sourceUrl: sanitizedSourceUrl } : {}),
      },
      updatedAt,
    });
  }

  private recordBrowserIntegrationFailure(
    context: ExecutionContext,
    stage: RunStage,
    kind: 'unconfigured' | 'startup' | 'provider' | 'invalid-output' | 'verification' | 'adapter',
    error: unknown,
    session?: BrowserSessionMetadata,
    fallbackBrowserName?: string
  ): Integration {
    const config = context.config;
    const configuredSession =
      session ??
      ({
        provider: config.browser.provider,
        ...(config.browser.provider === 'local'
          ? {
              browserName: fallbackBrowserName,
              liveViewAvailable: false,
            }
          : { liveViewAvailable: false }),
      } satisfies BrowserSessionMetadata);
    const provenance =
      kind === 'unconfigured'
        ? { ...localProvenance(), provider: 'QAgent browser configuration' }
        : browserProvenance(configuredSession, fallbackBrowserName);
    const nextStep = {
      unconfigured: 'Configure the required browser executable or Browserbase credentials.',
      startup: 'Repair the browser executable or Browserbase configuration, then retry.',
      provider: 'Verify the configured model endpoint and credentials, then retry.',
      'invalid-output':
        'Verify that the configured model returns Stagehand-compatible structured actions, then retry.',
      verification: 'Inspect the captured browser evidence, repair the flow or target, then retry.',
      adapter: 'Inspect the browser failure evidence and runtime diagnostics, then retry.',
    }[kind];
    const label = {
      unconfigured: 'Browser integration is not configured',
      startup: 'Browser startup failed',
      provider: 'Browser model provider failed',
      'invalid-output': 'Browser model output was invalid',
      verification: 'Browser verification failed',
      adapter: 'Browser runtime failed',
    }[kind];
    const status: Integration['status'] =
      kind === 'unconfigured' ? 'unconfigured' : kind === 'verification' ? 'healthy' : 'error';
    return this.recordIntegration(
      'browser',
      status,
      `${label} during run ${context.run.id} at ${stage} using ${config.browser.provider}: ${safeProbeError(error)}. ${nextStep}`,
      provenance.source,
      provenance.sourceUrl,
      provenance.provider
    );
  }

  private storeIntegrationProbe(probe: Integration): Integration {
    const existing = this.storage.getIntegration(probe.provider);
    return this.storage.upsertIntegration({
      ...probe,
      id: existing?.id ?? probe.id,
      requirements: existing?.requirements ?? probe.requirements ?? [],
      evidence: probe.evidence ?? existing?.evidence ?? [],
    });
  }

  async verifyIntegration(request: IntegrationVerifyRequest): Promise<IntegrationVerifyResult> {
    const verifiedAt = new Date().toISOString();
    const project = request.projectId ? this.storage.getProject(request.projectId) : null;
    if (request.projectId && !project) {
      throw new Error(`Project ${request.projectId} was not found`);
    }
    const detected = project
      ? await detectProject(project.path, { configPath: project.configPath })
      : null;
    const config = detected?.config ?? null;
    let integration: Integration | null = null;

    if (request.provider === 'model') {
      if (!config) {
        integration = this.recordIntegration(
          'model',
          'unconfigured',
          'Select a project with a valid model configuration before running a live probe.',
          'local'
        );
      } else {
        const provider = config.model.provider;
        try {
          const model = this.modelProviderFactory(config.model);
          await model.complete({
            purpose: 'other',
            system: 'Return the requested JSON and nothing else.',
            prompt: 'Return {"ok":true}.',
            schemaName: 'qagent_integration_probe',
            schema: z.object({ ok: z.literal(true) }),
            signal: AbortSignal.timeout(60_000),
          });
          integration = this.recordIntegration(
            'model',
            'end-to-end-verified',
            `Authenticated structured-output probe succeeded with ${provider}/${config.model.model}.`,
            'provider'
          );
        } catch (error) {
          integration = this.recordIntegration(
            'model',
            'error',
            `${provider}/${config.model.model} structured-output probe failed: ${safeProbeError(error)}`,
            'provider'
          );
        }
      }
    } else if (request.provider === 'browser') {
      const provider =
        config?.browser.provider ??
        (process.env.BROWSERBASE_API_KEY || process.env.BROWSERBASE_PROJECT_ID
          ? 'browserbase'
          : 'local');
      if (provider === 'local') {
        const browser = await this.browserDetector(
          config?.browser.executablePath ?? process.env.QAGENT_BROWSER_PATH,
          join(this.qagentHome, 'browsers')
        );
        integration = this.recordIntegration(
          'browser',
          browser ? 'configured' : 'unconfigured',
          browser
            ? `Local executable found ${browser.name} (${browser.source}); startup and a configured flow are not yet verified.`
            : 'No configured, system, or QAgent-managed Chromium executable was found.',
          'local'
        );
      } else {
        const smoke = await runCredentialBackedSmoke({
          BROWSERBASE_API_KEY: process.env.BROWSERBASE_API_KEY,
          BROWSERBASE_PROJECT_ID: process.env.BROWSERBASE_PROJECT_ID,
        });
        const probed = smoke.integrations.find((item) => item.provider === 'browserbase');
        if (!probed) throw new Error('Browserbase probe did not return an integration result');
        integration = this.storeIntegrationProbe(probed);
      }
    } else if (request.provider === 'github') {
      const repository = detected ? await this.gitRepository.inspect(detected.path) : null;
      const remote = repository?.origin ? parseGitHubRemote(repository.origin) : null;
      if (!this.githubToken || !remote || !config) {
        const missing = [
          !this.githubToken ? 'a GitHub credential' : null,
          !remote ? 'a GitHub origin' : null,
          !config ? 'a valid project configuration' : null,
        ].filter((item): item is string => Boolean(item));
        integration = this.recordIntegration(
          'github',
          'unconfigured',
          `GitHub verification requires ${missing.join(', ')}.`,
          'local'
        );
      } else {
        const sourceUrl = `https://github.com/${remote.owner}/${remote.repo}`;
        try {
          const probe = await this.githubPublisherFactory(this.githubToken).probeRepository(
            remote,
            config.publish.baseBranch,
            AbortSignal.timeout(30_000)
          );
          const fullyAuthorized =
            !probe.repository.archived &&
            !probe.repository.disabled &&
            probe.permissions.canPull &&
            probe.permissions.canPush &&
            probe.permissions.pullRequests === 'write' &&
            probe.merge.allowedMethods.includes(config.publish.mergeMethod);
          integration = this.recordIntegration(
            'github',
            fullyAuthorized ? 'healthy' : 'configured',
            githubProbeSummary(probe, config.publish.mergeMethod),
            'github',
            sourceUrl
          );
        } catch (error) {
          integration = this.recordIntegration(
            'github',
            'error',
            `Authenticated repository probe failed: ${safeProbeError(error)}`,
            'github',
            sourceUrl
          );
        }
      }
    } else {
      const weaveProject = config?.telemetry.weave.project ?? process.env.WEAVE_PROJECT ?? 'qagent';
      if (!process.env.WANDB_API_KEY) {
        integration = this.recordIntegration(
          'weave',
          'unconfigured',
          'WANDB_API_KEY is not configured; no project probe or trace was sent.',
          'local'
        );
      } else {
        let resolvedProject: string | null = null;
        try {
          resolvedProject = await new WeaveTraceSink(weaveProject, false).probeProject(
            AbortSignal.timeout(30_000)
          );
        } catch (error) {
          integration = this.recordIntegration(
            'weave',
            'error',
            `Exact Weave entity/project probe failed: ${safeProbeError(error)}`,
            'weave'
          );
        }
        if (resolvedProject) {
          if (!request.weaveDisclosureAccepted) {
            integration = this.recordIntegration(
              'weave',
              'configured',
              `Authenticated access to ${resolvedProject} was verified; telemetry disclosure is not accepted, so no trace was sent.`,
              'weave'
            );
          } else {
            const smoke = await runCredentialBackedSmoke({
              WANDB_API_KEY: process.env.WANDB_API_KEY,
              WEAVE_PROJECT: weaveProject,
              QAGENT_SMOKE_WEAVE_DISCLOSURE_ACCEPTED: 'true',
            });
            const probed = smoke.integrations.find((item) => item.provider === 'weave');
            integration = probed
              ? this.storeIntegrationProbe({
                  ...probed,
                  detail:
                    probed.status === 'end-to-end-verified'
                      ? `Authenticated access to ${resolvedProject} was verified, then a redacted probe was delivered and flushed.`
                      : `Authenticated access to ${resolvedProject} was verified, but trace delivery failed: ${probed.detail ?? 'provider error'}`,
                })
              : this.recordIntegration(
                  'weave',
                  'error',
                  `Authenticated access to ${resolvedProject} was verified, but the trace delivery probe returned no result.`,
                  'weave'
                );
          }
        }
      }
    }

    integration ??= this.recordIntegration(
      request.provider,
      'error',
      `${request.provider} verification ended without a conclusive provider result.`,
      request.provider === 'weave' ? 'weave' : 'local'
    );
    const disclosureRequired = request.provider === 'weave' && !request.weaveDisclosureAccepted;
    return IntegrationVerifyResultSchema.parse({
      provider: request.provider,
      integration,
      disclosureRequired,
      correctiveAction: integrationCorrectiveAction(
        request.provider,
        integration,
        disclosureRequired
      ),
      verifiedAt,
    });
  }

  private recordPolicySpecialistOutcome(input: {
    runId: string;
    stage: RunStage;
    role: Extract<SpecialistRole, 'scout' | 'proof'>;
    status: Extract<SpecialistActivity['status'], 'succeeded' | 'blocked'>;
    summary: string;
    evidenceIds: string[];
    handoffTarget?: SpecialistRole;
    actionRequired?: string;
  }): SpecialistActivity | null {
    const run = this.storage.getRun(input.runId);
    if (!run) throw new Error(`Run ${input.runId} was not found`);
    const evidence = [...new Set(input.evidenceIds)]
      .flatMap((artifactId) => {
        const artifact = this.storage.getArtifact(artifactId);
        return artifact?.runId === input.runId ? [artifact] : [];
      })
      .slice(0, 64);
    if (evidence.length === 0) return null;
    const evidenceIds = evidence.map((artifact) => artifact.id);

    const occurredAt = new Date().toISOString();
    const invocationId = randomUUID();
    const worker = `qagent.specialist.${input.role}`;
    const source: SpecialistSource = {
      kind: 'policy_worker',
      worker,
      invocationId,
    };
    const summary = input.summary.slice(0, 2_048);
    this.storage.recordPolicyWorkerCall({
      id: invocationId,
      runId: input.runId,
      worker,
      version: '1',
      attempt: run.attempt,
      status: 'succeeded',
      inputDigest: sha256Text(
        JSON.stringify({
          role: input.role,
          stage: input.stage,
          attempt: run.attempt,
          evidence: evidence.map(({ id, kind, sha256, bytes }) => ({ id, kind, sha256, bytes })),
        })
      ),
      outputDigest: sha256Text(
        JSON.stringify({
          status: input.status,
          summary,
          handoffTarget: input.handoffTarget ?? null,
          actionRequired: input.actionRequired ?? null,
        })
      ),
      error: null,
      startedAt: occurredAt,
      completedAt: occurredAt,
    });

    const activity: SpecialistActivity = {
      id: randomUUID(),
      runId: input.runId,
      role: input.role,
      status: input.status,
      summary,
      source,
      occurredAt,
      attempt: run.attempt,
      evidenceIds,
      handoffTarget: input.handoffTarget ?? null,
    };
    this.storage.recordSpecialistActivity(activity, input.stage, localProvenance());
    if (input.status === 'succeeded' && input.handoffTarget) {
      this.storage.recordSpecialistHandoff(
        {
          id: randomUUID(),
          runId: input.runId,
          from: input.role,
          to: input.handoffTarget,
          summary,
          actionRequired: input.actionRequired?.slice(0, 2_048) ?? null,
          source,
          occurredAt,
          attempt: run.attempt,
          evidenceIds,
        },
        input.stage,
        localProvenance()
      );
    } else if (input.status === 'blocked') {
      this.storage.recordSpecialistObjection(
        {
          id: randomUUID(),
          runId: input.runId,
          activityId: activity.id,
          role: input.role,
          summary,
          reason: summary,
          actionRequired:
            input.actionRequired?.slice(0, 2_048) ??
            'Resolve the recorded blocker before QAgent continues.',
          source,
          occurredAt,
          attempt: run.attempt,
          evidenceIds,
        },
        input.stage,
        localProvenance()
      );
    }
    return activity;
  }

  private recordProviderSpecialistOutcome(input: {
    runId: string;
    stage: RunStage;
    role: Extract<SpecialistRole, 'trace' | 'patch'>;
    providerCallId: string;
    summary: string;
    evidenceIds: string[];
    handoffTarget: SpecialistRole;
    actionRequired: string;
  }): SpecialistActivity | null {
    const run = this.storage.getRun(input.runId);
    if (!run) throw new Error(`Run ${input.runId} was not found`);
    const providerCall = this.storage
      .listProviderCalls(input.runId)
      .find((call) => call.id === input.providerCallId);
    if (
      !providerCall ||
      providerCall.status !== 'succeeded' ||
      providerCall.specialistRole !== input.role
    ) {
      throw new Error(
        `${input.role} activity requires its own successful provider call ${input.providerCallId}`
      );
    }
    const evidenceIds = [...new Set(input.evidenceIds)]
      .filter((artifactId) => this.storage.getArtifact(artifactId)?.runId === input.runId)
      .slice(0, 64);
    if (evidenceIds.length === 0) return null;
    const occurredAt = new Date().toISOString();
    const source: SpecialistSource = {
      kind: 'provider_call',
      providerCallId: providerCall.id,
    };
    const summary = input.summary.slice(0, 2_048);
    const activity: SpecialistActivity = {
      id: randomUUID(),
      runId: input.runId,
      role: input.role,
      status: 'succeeded',
      summary,
      source,
      occurredAt,
      attempt: providerCall.attempt ?? run.attempt,
      evidenceIds,
      handoffTarget: input.handoffTarget,
    };
    this.storage.recordSpecialistActivity(activity, input.stage, localProvenance());
    this.storage.recordSpecialistHandoff(
      {
        id: randomUUID(),
        runId: input.runId,
        from: input.role,
        to: input.handoffTarget,
        summary,
        actionRequired: input.actionRequired.slice(0, 2_048),
        source,
        occurredAt,
        attempt: activity.attempt,
        evidenceIds,
      },
      input.stage,
      localProvenance()
    );
    return activity;
  }

  private recordGateAssessment(input: {
    runId: string;
    stage: RunStage;
    action: 'complete' | 'block';
    summary: string;
    evidenceIds: string[];
    actionRequired?: string;
  }): SpecialistActivity | null {
    const run = this.storage.getRun(input.runId);
    if (!run) throw new Error(`Run ${input.runId} was not found`);
    const evidence = [...new Set(input.evidenceIds)]
      .flatMap((artifactId) => {
        const artifact = this.storage.getArtifact(artifactId);
        return artifact?.runId === input.runId ? [artifact] : [];
      })
      .slice(0, 64);
    if (evidence.length === 0) return null;
    const evidenceIds = evidence.map((artifact) => artifact.id);
    const subject = this.storage
      .listSpecialistActivities(input.runId)
      .findLast((activity) => activity.role !== 'gate');
    const occurredAt = new Date().toISOString();
    const invocationId = randomUUID();
    const worker = 'qagent.specialist.gate';
    const source: SpecialistSource = {
      kind: 'policy_worker',
      worker,
      invocationId,
    };
    const summary = input.summary.slice(0, 2_048);
    const actionRequired =
      input.action === 'block'
        ? (input.actionRequired ?? 'Resolve the evidence-backed blocker before continuing.').slice(
            0,
            2_048
          )
        : null;
    this.storage.recordPolicyWorkerCall({
      id: invocationId,
      runId: input.runId,
      worker,
      version: '1',
      attempt: run.attempt,
      status: 'succeeded',
      inputDigest: sha256Text(
        JSON.stringify({
          stage: input.stage,
          attempt: run.attempt,
          subject: subject
            ? {
                id: subject.id,
                role: subject.role,
                status: subject.status,
                evidenceIds: subject.evidenceIds,
              }
            : null,
          evidence: evidence.map(({ id, kind, sha256, bytes }) => ({ id, kind, sha256, bytes })),
        })
      ),
      outputDigest: sha256Text(JSON.stringify({ action: input.action, summary, actionRequired })),
      error: null,
      startedAt: occurredAt,
      completedAt: occurredAt,
    });
    const activity: SpecialistActivity = {
      id: randomUUID(),
      runId: input.runId,
      role: 'gate',
      status: input.action === 'complete' ? 'succeeded' : 'blocked',
      summary,
      source,
      occurredAt,
      attempt: run.attempt,
      evidenceIds,
      handoffTarget: null,
    };
    this.storage.recordSpecialistActivity(activity, input.stage, localProvenance());
    if (subject) {
      this.storage.recordSpecialistCritique(
        {
          id: randomUUID(),
          runId: input.runId,
          activityId: subject.id,
          role: 'gate',
          verdict: input.action === 'complete' ? 'accepted' : 'rejected',
          summary,
          source,
          occurredAt,
          attempt: run.attempt,
          evidenceIds,
          actionRequired,
        },
        input.stage,
        localProvenance()
      );
    }
    this.storage.recordSpecialistDecision(
      {
        id: randomUUID(),
        runId: input.runId,
        role: 'gate',
        action: input.action,
        summary,
        source,
        occurredAt,
        attempt: run.attempt,
        evidenceIds,
        handoffTarget: null,
      },
      input.stage,
      localProvenance()
    );
    if (input.action === 'block') {
      this.storage.recordSpecialistObjection(
        {
          id: randomUUID(),
          runId: input.runId,
          activityId: activity.id,
          role: 'gate',
          summary,
          reason: summary,
          actionRequired: actionRequired!,
          source,
          occurredAt,
          attempt: run.attempt,
          evidenceIds,
        },
        input.stage,
        localProvenance()
      );
    }
    return activity;
  }

  private dispatchPersistedEvent(event: RunEvent): void {
    this.active.get(event.runId)?.queue.push(event);
    if (event.kind === 'trace.status') return;
    this.recordTraceState(event.runId, event.stage, this.traceSink.state);
    void this.traceSink
      .send(event)
      .then((state) => this.recordTraceState(event.runId, event.stage, state))
      .catch(() => this.recordTraceState(event.runId, event.stage, 'failed'));
  }

  private updateManifestHead(runId: string, headSha: string): void {
    const context = this.storage.getRunManifestContext(runId);
    if (!context) return;
    this.storage.upsertRunManifestContext({
      ...context,
      headSha,
      updatedAt: new Date().toISOString(),
    });
  }

  async startRun(request: RunRequest): Promise<RunHandle> {
    if (this.shuttingDown) throw new Error('QAgent engine is shutting down');
    const project = this.storage.getProject(request.projectId);
    if (!project) throw new Error(`Project ${request.projectId} was not found`);
    const run = request.resumeRunId
      ? this.storage.getRun(request.resumeRunId)
      : this.storage.createRun({ projectId: request.projectId, requestedBy: request.requestedBy });
    if (!run) throw new Error(`Run ${request.resumeRunId} was not found`);
    if (run.projectId !== request.projectId) throw new Error('Run does not belong to this project');
    if (this.active.has(run.id)) throw new Error(`Run ${run.id} is already active`);
    if (request.resumeRunId && run.status !== 'interrupted') {
      throw new Error('Only a durable interrupted run can be resumed');
    }
    return this.activateRun(run, request.resumeRunId ? 'resume' : 'start');
  }

  async executeRunAction(input: RunActionRequest): Promise<RunActionExecution> {
    const request = RunActionRequestSchema.parse(input);
    const run = this.storage.getRun(request.runId);
    if (!run) throw new Error(`Run ${request.runId} was not found`);
    const beforeSequence = this.storage.listEvents(run.id).at(-1)?.sequence ?? 0;
    if (!run.availableActions.includes(request.action)) {
      const reason = `${request.action} is not available while run ${run.id} is ${run.status}`;
      const event = await this.emit(run.id, {
        kind: 'action.rejected',
        stage: run.stage,
        payload: { action: request.action, reason },
        provenance: localProvenance(),
        artifactIds: [],
      });
      return {
        result: RunActionResultSchema.parse({
          action: request.action,
          requestedRunId: run.id,
          runId: run.id,
          accepted: false,
          eventIds: [event.id],
          reason,
          occurredAt: event.occurredAt,
        }),
        handle: null,
      };
    }

    let handle: RunHandle | null = null;
    let resultRunId = run.id;
    if (request.action === 'cancel') {
      await this.cancelRun(run.id, request.reason);
    } else if (request.action === 'retry') {
      const retried = this.storage.createRun({
        projectId: run.projectId,
        requestedBy: requestedByForRunAction(request.requestedBy),
        attempt: run.attempt + 1,
        retryOfRunId: run.id,
      });
      resultRunId = retried.id;
      handle = this.activateRun(retried, 'retry');
    } else if (request.action === 'resume') {
      handle = this.activateRun(run, 'resume');
    } else if (request.action === 'reconnect') {
      handle = this.activateRun(run, 'reconnect');
    } else {
      const intervention = run.intervention;
      if (!intervention || intervention.id !== request.interventionId) {
        return this.rejectRunAction(
          run,
          request.action,
          'The requested intervention is no longer active'
        );
      }
      if (!intervention.resolutionOptions.includes(request.resolution.kind)) {
        return this.rejectRunAction(
          run,
          request.action,
          `${request.resolution.kind} is not valid for this intervention`
        );
      }
      const resolved: RunIntervention = {
        ...intervention,
        resolution: request.resolution,
        resolvedAt: new Date().toISOString(),
      };
      await this.emit(run.id, {
        kind: 'intervention.resolved',
        stage: run.stage,
        payload: {
          interventionId: intervention.id,
          resolution: request.resolution,
          message: 'Resolution recorded; QAgent is rechecking the underlying condition.',
        },
        provenance: localProvenance(),
        artifactIds: request.resolution.evidenceArtifactIds,
      });
      if (intervention.reason === 'merge_waiting') {
        this.storage.updateRun(run.id, {
          status: 'running',
          availableActions: ['cancel'],
          intervention: null,
          failureCode: null,
        });
        handle = this.activateRun(this.storage.getRun(run.id) ?? run, 'reconnect');
      } else if (
        intervention.reason === 'dirty_checkout' ||
        intervention.reason === 'interrupted_recovery' ||
        intervention.reason === 'worktree_recovery_failed'
      ) {
        this.storage.updateRun(run.id, {
          status: 'interrupted',
          availableActions: ['resume', 'cancel'],
          intervention: null,
          failureCode: intervention.reason,
          error: resolved.summary,
        });
        handle = this.activateRun(this.storage.getRun(run.id) ?? run, 'resume');
      } else {
        await this.finishRun(
          run.id,
          intervention.reason === 'policy_blocked' ? 'policy_blocked' : 'failed',
          intervention.reason === 'policy_blocked' ? 'run.policy_blocked' : 'run.failed',
          intervention.summary,
          intervention.reason,
          ['retry']
        );
        const retried = this.storage.createRun({
          projectId: run.projectId,
          requestedBy: requestedByForRunAction(request.requestedBy),
          attempt: run.attempt + 1,
          retryOfRunId: run.id,
        });
        resultRunId = retried.id;
        handle = this.activateRun(retried, 'retry');
      }
    }

    const newEvents = this.storage.listEvents(
      resultRunId,
      resultRunId === run.id ? beforeSequence : 0
    );
    return {
      result: RunActionResultSchema.parse({
        action: request.action,
        requestedRunId: run.id,
        runId: resultRunId,
        accepted: true,
        eventIds: newEvents.map((event) => event.id),
        reason: null,
        occurredAt: new Date().toISOString(),
      }),
      handle,
    };
  }

  async resumeInterruptedRuns(): Promise<RunHandle[]> {
    const handles: RunHandle[] = [];
    const runs = this.storage.listRuns();
    const recoverable = runs.filter((run) =>
      ['queued', 'running', 'interrupted'].includes(run.status)
    );
    for (const run of recoverable) {
      if (!this.active.has(run.id)) handles.push(this.activateRun(run, 'resume'));
    }
    return handles;
  }

  async cancelRun(runId: string, reason = 'Cancelled by user'): Promise<void> {
    const existing = this.storage.getRun(runId);
    if (
      existing &&
      ['queued', 'running', 'interrupted', 'waiting_for_intervention'].includes(existing.status)
    ) {
      this.storage.requestRunCancellation(runId);
    }
    const active = this.active.get(runId);
    if (!active) {
      if (
        existing &&
        ['queued', 'interrupted', 'waiting_for_intervention'].includes(existing.status)
      ) {
        await this.finishRun(runId, 'cancelled', 'run.cancelled', reason);
      }
      return;
    }
    active.controller.abort(new RunCancelledError(reason));
  }

  private activateRun(run: Run, mode: ActivationMode): RunHandle {
    if (this.active.has(run.id)) throw new Error(`Run ${run.id} is already active`);
    const controller = new AbortController();
    const queue = new AsyncQueue<RunEvent>();
    const active = { controller, queue, completion: null as Promise<Run> | null };
    this.active.set(run.id, active);
    const completion = this.executeRun(run, controller.signal, mode)
      .catch((error: unknown) => this.finishUnexpected(run.id, error))
      .finally(() => {
        queue.close();
        this.active.delete(run.id);
      });
    active.completion = completion;
    return new ActiveRunHandle(run.id, this.storage, queue, completion, (reason) =>
      this.cancelRun(run.id, reason)
    );
  }

  async shutdown(
    options: { reason?: string; graceMs?: number } = {}
  ): Promise<{ drained: boolean; interruptedRunIds: string[] }> {
    if (this.shuttingDown && this.active.size === 0) {
      await this.flushTraceSink(options.graceMs ?? 5_000);
      return { drained: true, interruptedRunIds: [] };
    }
    this.shuttingDown = true;
    const reason = options.reason ?? 'QAgent runtime is shutting down';
    const graceMs = options.graceMs ?? 5_000;
    const interruptedRunIds = [...this.active.keys()];
    for (const [runId, active] of this.active) {
      const current = this.storage.getRun(runId);
      if (current && (current.status === 'queued' || current.status === 'running')) {
        const recoveryCount = current.recoveryCount + 1;
        this.storage.updateRun(runId, {
          status: 'interrupted',
          availableActions: ['resume', 'cancel'],
          lastHeartbeatAt: new Date().toISOString(),
          recoveryCount,
        });
        await this.emit(runId, {
          kind: 'run.interrupted',
          stage: current.stage,
          payload: { message: reason, recoveryCount },
          provenance: localProvenance(),
          artifactIds: [],
        });
      }
      active.controller.abort(new RuntimeShutdownError(reason));
    }
    const completions = [...this.active.values()]
      .map((entry) => entry.completion)
      .filter((completion): completion is Promise<Run> => Boolean(completion));
    if (completions.length === 0) {
      await this.flushTraceSink(graceMs);
      return { drained: true, interruptedRunIds };
    }
    let timeout: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      Promise.allSettled(completions).then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), graceMs);
        timeout.unref();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    await this.flushTraceSink(graceMs);
    return { drained, interruptedRunIds };
  }

  private async flushTraceSink(graceMs: number): Promise<void> {
    const timeoutMs = Math.max(1, Math.min(graceMs, 5_000));
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.traceSink.flush(controller.signal).catch(() => 'failed' as const),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            controller.abort(new Error('Trace flush exceeded the shutdown deadline'));
            resolve();
          }, timeoutMs);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async executeRun(run: Run, signal: AbortSignal, mode: ActivationMode): Promise<Run> {
    let project: Project | null = null;
    let leaseTimer: NodeJS.Timeout | null = null;
    const leaseController = new AbortController();
    const resume = mode !== 'start' && mode !== 'retry';
    const recoveryId = resume ? randomUUID() : null;
    let recoverySettled = false;
    try {
      this.throwIfCancelled(signal);
      const durableBeforeStart = this.storage.getRun(run.id);
      if (!durableBeforeStart) throw new Error(`Run ${run.id} was not found`);
      if (durableBeforeStart.cancelRequestedAt) {
        throw new RunCancelledError('Cancellation was requested before recovery started');
      }
      project = this.storage.getProject(run.projectId);
      if (!project) throw new Error(`Project ${run.projectId} was not found`);
      if (!project.trusted) {
        throw new RunAttentionError(
          'Trust this workspace before running commands',
          'policy_blocked',
          applicationAction(
            'trust-project',
            'Trust project',
            'Review the canonical path and exact commands, then explicitly trust this project.',
            'trust_project'
          ),
          ['policy_acknowledged']
        );
      }
      const leaseAcquired =
        this.storage.acquireLease(project.id, run.id) ||
        (resume && this.storage.takeoverLeaseForRecovery(project.id, run.id));
      if (!leaseAcquired) {
        if (resume && recoveryId) {
          const message =
            'Recovery is waiting because another live QAgent process still owns the project mutation lease.';
          const committed = this.storage.commitRunEvent({
            runId: run.id,
            runUpdate: {
              status: 'interrupted',
              error: message,
              failureCode: 'interrupted_recovery',
              availableActions: ['resume', 'cancel'],
              lastHeartbeatAt: new Date().toISOString(),
            },
            event: {
              kind: 'recovery.failed',
              stage: durableBeforeStart.stage,
              payload: {
                recoveryId,
                resumedSequence: this.storage.listEvents(run.id).at(-1)?.sequence ?? 0,
                currentAction: 'Waiting for exclusive project mutation lease',
                error: message,
              },
              provenance: localProvenance(),
              artifactIds: [],
            },
          });
          return committed.run;
        }
        throw new RunAttentionError(
          'Another QAgent process is already mutating this project',
          'policy_blocked',
          applicationAction(
            'wait-for-project-lease',
            'Review active run',
            'Wait for the active project mutation to settle before starting another isolated run.',
            'review_policy'
          ),
          ['policy_acknowledged']
        );
      }
      const leasedProjectId = project.id;
      if (recoveryId) {
        await this.emit(run.id, {
          kind: 'recovery.started',
          stage: durableBeforeStart.stage,
          payload: {
            recoveryId,
            fromSequence: this.storage.listEvents(run.id).at(-1)?.sequence ?? 0,
            previousStage: durableBeforeStart.stage,
            previousStatus: durableBeforeStart.status,
            attempt: run.attempt,
          },
          provenance: localProvenance(),
          artifactIds: [],
        });
      }
      const loseLease = (reason: unknown): void => {
        const error =
          reason instanceof LeaseLostError
            ? reason
            : new LeaseLostError(`Project mutation lease was lost: ${errorMessage(reason)}`);
        if (!leaseController.signal.aborted) leaseController.abort(error);
      };
      const renewLease = (): void => {
        try {
          if (!this.storage.renewLease(leasedProjectId, run.id)) {
            loseLease(new LeaseLostError('Project mutation lease renewal was rejected'));
            return;
          }
          this.storage.updateRun(run.id, { lastHeartbeatAt: new Date().toISOString() });
          this.heartbeatActiveStage(run.id);
        } catch (error) {
          loseLease(error);
        }
      };
      leaseTimer = setInterval(() => {
        renewLease();
        const durableRun = this.storage.getRun(run.id);
        if (durableRun?.cancelRequestedAt) {
          this.active
            .get(run.id)
            ?.controller.abort(new RunCancelledError('Cancellation requested by another client'));
        }
      }, 10_000);
      leaseTimer.unref();

      let recoveryCount = durableBeforeStart.recoveryCount;
      if (resume && durableBeforeStart.status !== 'interrupted') {
        recoveryCount += 1;
        this.storage.updateRun(run.id, {
          status: 'interrupted',
          availableActions: ['resume', 'cancel'],
          failureCode: 'interrupted_recovery',
          recoveryCount,
          error: 'The previous runtime stopped before this run reached a durable outcome.',
        });
        await this.emit(run.id, {
          kind: 'run.interrupted',
          stage: durableBeforeStart.stage,
          payload: {
            message: 'The previous runtime stopped; durable recovery is starting.',
            recoveryCount,
          },
          provenance: localProvenance(),
          artifactIds: [],
        });
      }
      this.storage.updateRun(run.id, {
        status: 'running',
        error: null,
        failureCode: null,
        completedAt: null,
        cancelRequestedAt: null,
        availableActions: ['cancel'],
        intervention: null,
        lastHeartbeatAt: new Date().toISOString(),
        recoveryCount,
      });
      if (mode === 'resume') {
        await this.emit(run.id, {
          kind: 'run.resumed',
          stage: durableBeforeStart.stage,
          payload: { message: 'Resuming durable run', recoveryCount },
          provenance: localProvenance(),
          artifactIds: [],
        });
      } else if (mode === 'reconnect') {
        await this.emit(run.id, {
          kind: 'run.reconnected',
          stage: durableBeforeStart.stage,
          payload: {
            message: 'Reconnected to the existing durable publication.',
            afterSequence: this.storage.listEvents(run.id).at(-1)?.sequence ?? 0,
          },
          provenance: localProvenance(),
          artifactIds: [],
        });
      } else if (mode === 'retry') {
        await this.emit(run.id, {
          kind: 'run.retrying',
          stage: 'preflight',
          payload: {
            message: `Retrying run ${run.retryOfRunId ?? 'unknown'} in a new isolated worktree.`,
            attempt: run.attempt,
          },
          provenance: localProvenance(),
          artifactIds: [],
        });
      } else {
        await this.emit(run.id, {
          kind: 'run.created',
          stage: 'preflight',
          payload: { message: 'Run created' },
          provenance: localProvenance(),
          artifactIds: [],
        });
      }
      await this.startStage(
        run.id,
        'preflight',
        'Checking trust, configuration, Git, and isolation'
      );
      let detected: Awaited<ReturnType<typeof detectProject>>;
      try {
        detected = await detectProject(project.path, { configPath: project.configPath });
      } catch (error) {
        throw new RunAttentionError(
          `Project configuration is invalid: ${errorMessage(error)}`,
          'configuration_invalid',
          applicationAction(
            'repair-project-config',
            'Repair project configuration',
            'Correct the managed QAgent configuration, then retry in a new isolated worktree.',
            'configure_project'
          ),
          ['policy_acknowledged']
        );
      }
      if (!detected.config) {
        throw new RunAttentionError(
          'Project needs a valid .qagent.yml before QAgent can run',
          'configuration_invalid',
          applicationAction(
            'configure-project',
            'Configure project',
            'Review the detected commands and create a valid managed QAgent configuration.',
            'configure_project'
          ),
          ['policy_acknowledged']
        );
      }
      const runTimeout = AbortSignal.timeout(detected.config.limits.maxRunMinutes * 60_000);
      const contextSignal = AbortSignal.any([signal, runTimeout, leaseController.signal]);
      const repository = await this.gitRepository.inspect(project.path, { signal: contextSignal });
      renewLease();
      if (leaseController.signal.aborted) throw leaseController.signal.reason;
      const checkpointBeforeRecovery = resume ? this.storage.getRunCheckpoint(run.id) : null;
      let worktree: Worktree;
      try {
        worktree = await this.prepareWorktree(
          run,
          repository,
          project.name,
          resume,
          checkpointBeforeRecovery,
          contextSignal
        );
      } catch (error) {
        throw new RunAttentionError(
          `The isolated worktree could not be restored: ${errorMessage(error)}`,
          'worktree_recovery_failed',
          applicationAction(
            'review-policy',
            'Review recovery',
            'Inspect or restore the recorded worktree before resuming.',
            'review_policy'
          ),
          ['recovery_confirmed']
        );
      }
      if (!checkpointBeforeRecovery) {
        this.storage.saveRunCheckpoint(run.id, 'worktree_created', {
          worktreePath: worktree.path,
          branch: worktree.branch,
          baseSha: worktree.baseSha,
        });
      }
      const context: ExecutionContext = {
        run: this.storage.getRun(run.id) ?? run,
        project,
        config: detected.config,
        repository,
        worktree,
        model: null,
        signal: contextSignal,
        assertLease: () => {
          this.throwIfCancelled(contextSignal);
          renewLease();
          if (leaseController.signal.aborted) throw leaseController.signal.reason;
        },
      };
      await this.completeStage(run.id, 'preflight', `Isolated on ${worktree.branch}`);
      await this.emitIsolationReady(context);
      const configSource = detected.configPath
        ? await readFile(detected.configPath)
        : Buffer.from(JSON.stringify(detected.config));
      this.storage.upsertRunManifestContext({
        runId: run.id,
        configDigest: createHash('sha256').update(configSource).digest('hex'),
        configPath: detected.configPath,
        baseSha: worktree.baseSha,
        headSha: worktree.baseSha,
        branch: worktree.branch,
        worktreePath: worktree.path,
        commands: [
          ...detected.config.test.commands,
          ...detected.config.verify.commands,
          ...(detected.config.target.start ? [detected.config.target.start] : []),
        ],
        browserChecks: detected.config.test.browserFlows.map((flow) => ({
          name: flow.name,
          steps: flow.steps,
        })),
        updatedAt: new Date().toISOString(),
      });

      if (resume) {
        await this.recoverPendingPatch(context);
      }
      const recoveryCheckpoint = resume ? this.storage.getRunCheckpoint(run.id) : null;
      if (recoveryId) {
        await this.emit(run.id, {
          kind: 'recovery.completed',
          stage: context.run.stage,
          payload: {
            recoveryId,
            resumedSequence: this.storage.listEvents(run.id).at(-1)?.sequence ?? 0,
            currentAction: recoveryCheckpoint
              ? `Reconciled durable ${recoveryCheckpoint.kind} checkpoint`
              : 'Reconciled durable worktree and run records',
            error: null,
          },
          provenance: localProvenance(),
          artifactIds: [],
        });
        recoverySettled = true;
      }
      if (resume && recoveryCheckpoint) {
        const recovered = await this.resumeFromCheckpoint(context, recoveryCheckpoint);
        if (recovered) return recovered;
      }

      await this.discoverTests(context);
      const testOutcome = await this.runTests(context, 'test');
      if (testOutcome.passed) {
        const changed = await this.gitRepository.changedFiles(worktree, { signal: contextSignal });
        if (changed.length === 0) {
          return this.completeRun(run.id, 'No defects found; every configured check passed.');
        }
        const resumedRepair = await this.verifyResumedRepair(context);
        return this.publishVerifiedRepair(context, resumedRepair);
      }

      this.recordPolicySpecialistOutcome({
        runId: run.id,
        stage: 'test',
        role: 'scout',
        status: 'succeeded',
        summary: `Scout grounded the repair request in ${testOutcome.artifacts.length} failing check artifact(s).`,
        evidenceIds: testOutcome.artifacts.map((artifact) => artifact.id),
        handoffTarget: 'trace',
        actionRequired: 'Trace the failing checks to a specific, evidence-backed root cause.',
      });
      const repair = await this.repairUntilVerified(
        context,
        testOutcome.output,
        testOutcome.artifacts
      );
      return await this.publishVerifiedRepair(context, repair);
    } catch (error) {
      if (recoveryId && !recoverySettled) {
        const durable = this.storage.getRun(run.id);
        await this.emit(run.id, {
          kind: 'recovery.failed',
          stage: durable?.stage ?? run.stage,
          payload: {
            recoveryId,
            resumedSequence: this.storage.listEvents(run.id).at(-1)?.sequence ?? 0,
            currentAction: 'Reconciling durable run state',
            error: errorMessage(error),
          },
          provenance: localProvenance(),
          artifactIds: [],
        });
      }
      const abortReason = signal.aborted ? signal.reason : null;
      if (abortReason instanceof RuntimeShutdownError || error instanceof RuntimeShutdownError) {
        const interrupted = this.storage.getRun(run.id);
        if (!interrupted) {
          throw new Error(`Run ${run.id} was not found`, { cause: error });
        }
        return interrupted;
      }
      if (abortReason instanceof RunCancelledError || error instanceof RunCancelledError) {
        return this.finishRun(
          run.id,
          'cancelled',
          'run.cancelled',
          errorMessage(abortReason ?? error),
          null,
          []
        );
      }
      if (error instanceof RunAttentionError) {
        return this.requireIntervention(run.id, error);
      }
      const leaseError =
        abortReason instanceof LeaseLostError
          ? abortReason
          : error instanceof LeaseLostError
            ? error
            : null;
      if (leaseError) {
        return this.interruptRun(
          run.id,
          `Execution paused because the project mutation lease was lost: ${leaseError.message}`
        );
      }
      if (error instanceof PolicyBlockedError) {
        const checkpoint = this.storage.getRunCheckpoint(run.id);
        if (!checkpoint || checkpoint.kind === 'worktree_created') {
          return this.requireIntervention(run.id, policyIntervention(error.message, []));
        }
        return this.finishRun(
          run.id,
          'policy_blocked',
          'run.policy_blocked',
          error.message,
          'policy_blocked',
          ['retry']
        );
      }
      const classified = classifyUnexpectedFailure(error, this.storage.getRun(run.id)?.stage);
      return this.finishRun(
        run.id,
        'failed',
        'run.failed',
        errorMessage(error),
        classified.code,
        classified.retryable ? ['retry'] : []
      );
    } finally {
      if (leaseTimer) clearInterval(leaseTimer);
      if (project) this.storage.releaseLease(project.id, run.id);
    }
  }

  private async prepareWorktree(
    run: Run,
    repository: Awaited<ReturnType<GitRepository['inspect']>>,
    projectName: string,
    resume: boolean,
    checkpoint: RunCheckpoint | null,
    signal: AbortSignal
  ): Promise<Worktree> {
    const recordedWorktree =
      checkpoint?.kind === 'worktree_created'
        ? checkpoint.data
        : run.worktreePath && run.branch && run.baseSha
          ? {
              worktreePath: run.worktreePath,
              branch: run.branch,
              baseSha: run.baseSha,
            }
          : null;
    if (resume && recordedWorktree) {
      const expectedHeadSha =
        checkpoint?.kind === 'merge_observed' || checkpoint?.kind === 'postverify_passed'
          ? checkpoint.data.mergeCommitSha
          : undefined;
      const restored = await this.gitRepository.restoreWorktree(
        recordedWorktree.worktreePath,
        recordedWorktree.branch,
        recordedWorktree.baseSha,
        {
          signal,
          allowDetached: Boolean(expectedHeadSha),
          expectedHeadSha,
        }
      );
      this.storage.updateRun(run.id, {
        worktreePath: restored.path,
        branch: restored.branch,
        baseSha: restored.baseSha,
      });
      return restored;
    }
    const reconciliation = await this.gitRepository.reconcileWorktree(
      repository,
      join(this.qagentHome, 'worktrees'),
      run.id,
      projectName,
      { signal }
    );
    const worktree = reconciliation.worktree;
    this.storage.updateRun(run.id, {
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseSha: worktree.baseSha,
    });
    return worktree;
  }

  private async recoverPendingPatch(context: ExecutionContext): Promise<void> {
    const patches = this.storage.listPatches(context.run.id);
    const pendingPatch = patches.findLast((patch) => !patch.applied);
    if (!pendingPatch) {
      const latestApplied = patches.findLast((patch) => patch.applied);
      const checkpoint = this.storage.getRunCheckpoint(context.run.id);
      if (latestApplied && checkpoint?.kind === 'worktree_created') {
        const changed = await this.gitRepository.changedFiles(context.worktree, {
          signal: context.signal,
        });
        if (changed.length > 0) {
          this.storage.saveRunCheckpoint(context.run.id, 'patch_applied', {
            patchId: latestApplied.id,
            artifactId: latestApplied.artifactId,
          });
        }
      }
      return;
    }
    const artifact = this.storage.getArtifact(pendingPatch.artifactId);
    if (!artifact) {
      throw new RunAttentionError(
        `Pending patch ${pendingPatch.id} has no durable artifact`,
        'interrupted_recovery',
        applicationAction(
          'review-recovery-records',
          'Review recovery evidence',
          'Inspect the preserved worktree and durable patch records.',
          'review_policy'
        ),
        ['recovery_confirmed'],
        ['retry'],
        []
      );
    }
    const diff = (await this.artifactStore.read(artifact)).toString('utf8');
    const reconciliation = await this.gitRepository.reconcilePatch(
      context.worktree,
      diff,
      context.config.limits.maxPatchBytes,
      { signal: context.signal }
    );
    if (reconciliation.state === 'conflict') {
      throw new RunAttentionError(
        `Pending patch ${pendingPatch.id} could not be reconciled: ${reconciliation.detail ?? 'conflict'}`,
        'interrupted_recovery',
        applicationAction(
          'review-interrupted-patch',
          'Review interrupted patch',
          'Inspect the preserved worktree and patch evidence before retrying.',
          'review_policy'
        ),
        ['recovery_confirmed'],
        ['retry'],
        [artifact.id]
      );
    }
    context.assertLease();
    const inspection =
      reconciliation.state === 'applicable'
        ? await this.gitRepository.applyPatch(
            context.worktree,
            diff,
            context.config.limits.maxPatchBytes,
            { signal: context.signal }
          )
        : reconciliation.inspection;
    const applied = this.storage.markPatchApplied(pendingPatch.id, inspection);
    this.storage.saveRunCheckpoint(context.run.id, 'patch_applied', {
      patchId: applied.id,
      artifactId: artifact.id,
    });
    const alreadyEmitted = this.storage
      .listEvents(context.run.id)
      .some((event) => event.kind === 'patch.created' && event.payload.patchId === applied.id);
    if (!alreadyEmitted) {
      await this.emit(context.run.id, {
        kind: 'patch.created',
        stage: 'patch',
        payload: {
          patchId: applied.id,
          summary: applied.summary,
          files: applied.files,
        },
        provenance: artifact.provenance,
        artifactIds: [artifact.id],
      });
    }
  }

  private async resumeFromCheckpoint(
    context: ExecutionContext,
    checkpoint: RunCheckpoint
  ): Promise<Run | null> {
    if (checkpoint.kind === 'worktree_created') {
      const changedFiles = await this.gitRepository.changedFiles(context.worktree, {
        signal: context.signal,
      });
      const pendingPatch = this.storage
        .listPatches(context.run.id)
        .findLast((patch) => !patch.applied);
      if (changedFiles.length > 0 && pendingPatch) {
        throw new RunAttentionError(
          'The runtime stopped after the worktree changed but before patch application was durably confirmed.',
          'interrupted_recovery',
          applicationAction(
            'review-interrupted-patch',
            'Review interrupted patch',
            'Inspect the preserved worktree and patch evidence before resuming.',
            'review_policy'
          ),
          ['recovery_confirmed'],
          ['resolve_intervention', 'cancel'],
          [pendingPatch.artifactId]
        );
      }
      return null;
    }

    if (checkpoint.kind === 'patch_applied') {
      const repair = await this.repairFromRecords(context, false);
      const verification = await this.verify(context);
      if (!verification.passed) {
        throw new Error('The recovered repair no longer passes verification');
      }
      return this.publishVerifiedRepair(context, { ...repair, verification });
    }

    if (
      checkpoint.kind === 'verification_passed' ||
      checkpoint.kind === 'commit_created' ||
      checkpoint.kind === 'branch_pushed'
    ) {
      const repair = await this.repairFromRecords(context, true);
      return this.publishVerifiedRepair(context, repair);
    }

    if (checkpoint.kind === 'pull_request_created') {
      return this.reconnectPublication(context, checkpoint);
    }

    if (checkpoint.kind === 'merge_observed') {
      const repair = await this.repairFromRecords(context, true);
      return this.finishMergedPublication(
        context,
        repair,
        checkpoint.data.number,
        checkpoint.data.mergeCommitSha,
        this.publicationFromEvents(context.run, this.storage.listEvents(context.run.id))?.url ??
          null
      );
    }

    if (checkpoint.kind === 'postverify_passed') {
      const repair = await this.repairFromRecords(context, true);
      await this.learn(context, repair);
      const publication = this.publicationFromEvents(
        context.run,
        this.storage.listEvents(context.run.id)
      );
      return this.completeRun(
        context.run.id,
        publication
          ? `Repair merged in ${publication.url}.`
          : 'Merged repair passed post-merge verification.'
      );
    }

    return null;
  }

  private async repairFromRecords(
    context: ExecutionContext,
    requireVerification: boolean
  ): Promise<RepairOutcome> {
    const diagnosis = this.storage.getDiagnosis(context.run.id);
    const patch = this.storage.getPatch(context.run.id);
    const verification = this.storage.getVerification(context.run.id);
    if (!diagnosis || !patch?.applied || (requireVerification && !verification?.passed)) {
      throw new RunAttentionError(
        'Durable repair records are incomplete for safe recovery.',
        'interrupted_recovery',
        applicationAction(
          'review-recovery-records',
          'Review recovery evidence',
          'Inspect the preserved worktree and durable evidence before resuming.',
          'review_policy'
        ),
        ['recovery_confirmed'],
        ['resolve_intervention', 'cancel'],
        [patch?.artifactId, ...(verification?.artifactIds ?? [])].filter((id): id is string =>
          Boolean(id)
        )
      );
    }
    const diff = await this.gitRepository.diff(context.worktree, { signal: context.signal });
    const patchArtifact = this.storage.getArtifact(patch.artifactId);
    const inspectionSource =
      diff.trim().length > 0
        ? diff
        : patchArtifact
          ? (await this.artifactStore.read(patchArtifact)).toString('utf8')
          : '';
    const inspection = inspectPatch(inspectionSource);
    return {
      inspection,
      diagnosis,
      patch,
      verification:
        verification ??
        ({
          id: randomUUID(),
          runId: context.run.id,
          passed: false,
          commands: [],
          artifactIds: [],
          createdAt: new Date().toISOString(),
        } satisfies Verification),
    };
  }

  private async reconnectPublication(
    context: ExecutionContext,
    checkpoint: Extract<RunCheckpoint, { kind: 'pull_request_created' }>
  ): Promise<Run> {
    const repair = await this.repairFromRecords(context, true);
    const remote = context.repository.origin ? parseGitHubRemote(context.repository.origin) : null;
    if (!remote || !this.githubToken) {
      throw new RunAttentionError(
        'The existing pull request cannot be rechecked without GitHub repository credentials.',
        'github_auth_required',
        applicationAction(
          'configure-github',
          'Reconnect GitHub',
          'Restore GitHub access, then reconnect to the recorded pull request.',
          'configure_provider'
        ),
        ['provider_reconfigured'],
        ['resolve_intervention', 'cancel'],
        [repair.patch.artifactId]
      );
    }
    const publisher = this.githubPublisherFactory(this.githubToken);
    const refreshed = await publisher.waitForPull(remote, checkpoint.data.number, context.signal);
    const detail = refreshed.detail ?? `Pull request is ${refreshed.state}`;
    await this.emit(context.run.id, {
      kind: 'publication.updated',
      stage: 'wait_checks',
      payload: { state: refreshed.state, detail },
      provenance: {
        source: 'github',
        provider: `${remote.owner}/${remote.repo}`,
        capturedAt: new Date().toISOString(),
      },
      artifactIds: [],
    });
    if (refreshed.state !== 'merged' || !refreshed.mergeCommitSha) {
      throw new RunAttentionError(
        detail,
        refreshed.state === 'conflict' ? 'merge_conflict' : 'merge_waiting',
        externalAction(
          'review-pull-request',
          'Review pull request',
          'Complete repository requirements, then reconnect to this same pull request.',
          checkpoint.data.url
        ),
        ['github_requirements_recheck_requested'],
        ['reconnect', 'resolve_intervention', 'cancel'],
        [repair.patch.artifactId, ...repair.verification.artifactIds]
      );
    }
    this.storage.saveRunCheckpoint(context.run.id, 'merge_observed', {
      number: checkpoint.data.number,
      mergeCommitSha: refreshed.mergeCommitSha,
    });
    this.updateManifestHead(context.run.id, refreshed.mergeCommitSha);
    return this.finishMergedPublication(
      context,
      repair,
      checkpoint.data.number,
      refreshed.mergeCommitSha,
      checkpoint.data.url
    );
  }

  private async finishMergedPublication(
    context: ExecutionContext,
    repair: RepairOutcome,
    number: number,
    mergeCommitSha: string,
    publicationUrl: string | null
  ): Promise<Run> {
    await this.startStage(context.run.id, 'merge', `Recording merged pull request #${number}`);
    context.assertLease();
    await this.gitRepository.checkoutMergedCommit(
      context.worktree,
      context.config.publish.baseBranch,
      mergeCommitSha,
      { signal: context.signal }
    );
    const postverify = await this.runTests(context, 'postverify');
    if (!postverify.passed)
      throw new Error('Post-merge verification failed in the isolated worktree');
    this.storage.saveRunCheckpoint(context.run.id, 'postverify_passed', { mergeCommitSha });
    await this.learn(context, repair);
    return this.completeRun(
      context.run.id,
      publicationUrl ? `Repair merged in ${publicationUrl}.` : 'Merged repair verified.'
    );
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
      passed ? 'Every configured check passed' : 'One or more configured checks failed',
      passed ? 'succeeded' : 'failed',
      [...commandOutcome.artifacts, ...browserOutcome.artifacts].map((artifact) => artifact.id)
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
    if (!context.config.target.url) {
      throw new RunAttentionError(
        'Browser flows require target.url in .qagent.yml',
        'configuration_invalid',
        applicationAction(
          'configure-target',
          'Configure target',
          'Add the target URL before running browser flows.',
          'configure_project'
        ),
        ['policy_acknowledged']
      );
    }
    if (
      context.config.browser.provider === 'browserbase' &&
      (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID)
    ) {
      this.recordBrowserIntegrationFailure(
        context,
        stage,
        'unconfigured',
        'Browserbase requires both BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID'
      );
      throw new RunAttentionError(
        'Browserbase requires both BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID',
        'browser_startup_failure',
        applicationAction(
          'configure-browserbase',
          'Configure Browserbase',
          'Store the Browserbase API key and project ID, then verify the connection.',
          'configure_provider'
        ),
        ['browser_installed']
      );
    }
    let browser: Awaited<ReturnType<typeof detectBrowser>> | undefined;
    try {
      browser =
        context.config.browser.provider === 'local'
          ? await this.browserDetector(
              context.config.browser.executablePath ?? process.env.QAGENT_BROWSER_PATH,
              join(this.qagentHome, 'browsers')
            )
          : undefined;
    } catch (error) {
      this.recordBrowserIntegrationFailure(context, stage, 'startup', error);
      throw new RunAttentionError(
        `Browser discovery failed: ${errorMessage(error)}`,
        'browser_startup_failure',
        applicationAction(
          'repair-browser',
          'Repair browser connection',
          'Verify the configured executable or install QAgent managed Chrome before retrying.',
          'configure_provider'
        ),
        ['browser_installed']
      );
    }
    const browserInstallation = browser ?? undefined;
    if (context.config.browser.provider === 'local' && !browser) {
      this.recordBrowserIntegrationFailure(
        context,
        stage,
        'unconfigured',
        'No Chrome-compatible browser is available'
      );
      throw new RunAttentionError(
        'No Chrome-compatible browser is available',
        'browser_startup_failure',
        applicationAction(
          'install-browser',
          'Install browser',
          'Install QAgent managed Chrome or configure an executable path.',
          'install_browser'
        ),
        ['browser_installed']
      );
    }
    let service: ManagedProcess | null = null;
    const healthUrl = new URL(
      context.config.target.healthPath,
      context.config.target.url
    ).toString();
    const healthWasReadyBeforeStart = context.config.target.start
      ? await urlRespondsOk(healthUrl, context.signal)
      : false;
    const serviceId = randomUUID();
    const serviceCommandId = randomUUID();
    const serviceOutputEvents: Array<Promise<unknown>> = [];
    const serviceStartedAt = Date.now();
    let serviceReady = false;
    if (context.config.target.start) {
      try {
        service = await this.processRunner.start(
          context.worktree.path,
          context.config.target.start,
          context.signal,
          {
            onOutput: (chunk) => {
              const output = this.boundedOutput(chunk.text, chunk.droppedBytes);
              serviceOutputEvents.push(
                this.emit(context.run.id, {
                  kind: 'command.output',
                  stage,
                  payload: {
                    commandId: serviceCommandId,
                    attempt: context.run.attempt,
                    stream: chunk.stream,
                    chunkIndex: chunk.sequence,
                    output,
                  },
                  provenance: localProvenance(),
                  artifactIds: [],
                }),
                this.emitOutputBounds(
                  context.run.id,
                  stage,
                  serviceCommandId,
                  output,
                  chunk.droppedBytes
                )
              );
            },
          }
        );
        await this.emit(context.run.id, {
          kind: 'target.service_started',
          stage,
          payload: {
            serviceId,
            commandId: serviceCommandId,
            attempt: context.run.attempt,
            executable: context.config.target.start.executable,
            args: context.config.target.start.args,
          },
          provenance: localProvenance(),
          artifactIds: [],
        });
      } catch (error) {
        await Promise.all(serviceOutputEvents);
        await this.emit(context.run.id, {
          kind: 'target.service_failed',
          stage,
          payload: {
            serviceId,
            attempt: context.run.attempt,
            error: `The configured target process did not start: ${errorMessage(error)}`,
          },
          provenance: localProvenance(),
          artifactIds: [],
        });
        throw new RunAttentionError(
          `The configured target process did not start: ${errorMessage(error)}`,
          'target_startup_failure',
          applicationAction(
            'configure-start',
            'Repair start command',
            'Review the configured target start command and retry.',
            'configure_project'
          ),
          ['policy_acknowledged']
        );
      }
    }
    const artifacts: Artifact[] = [];
    const output: string[] = [];
    const browserSessionId = randomUUID();
    const navigationId = randomUUID();
    const browserActionIds = new Map(
      context.config.test.browserFlows.map((flow) => [flow.name, randomUUID()])
    );
    const browserStartedAt = Date.now();
    let browserSessionStarted = false;
    let browserSessionClosed = false;
    let browserAttempted = false;
    try {
      this.heartbeatActiveStage(context.run.id, 'Waiting for target service readiness', healthUrl);
      const healthStatus = await waitForUrl(
        healthUrl,
        context.signal,
        service,
        healthWasReadyBeforeStart
      );
      this.heartbeatActiveStage(context.run.id, 'Running configured browser flows', null);
      serviceReady = true;
      if (service) {
        await this.emit(context.run.id, {
          kind: 'target.service_ready',
          stage,
          payload: {
            serviceId,
            attempt: context.run.attempt,
            healthUrl,
            statusCode: healthStatus,
            durationMs: Date.now() - serviceStartedAt,
          },
          provenance: localProvenance(),
          artifactIds: [],
        });
      }
      await this.emit(context.run.id, {
        kind: 'browser.session_started',
        stage,
        payload: {
          sessionId: browserSessionId,
          provider: context.config.browser.provider,
          browserName:
            browserInstallation?.name ??
            (context.config.browser.provider === 'browserbase'
              ? 'Browserbase Chromium'
              : 'Chromium'),
          attempt: context.run.attempt,
        },
        provenance: localProvenance(),
        artifactIds: [],
      });
      browserSessionStarted = true;
      await this.emit(context.run.id, {
        kind: 'browser.navigation_started',
        stage,
        payload: {
          sessionId: browserSessionId,
          navigationId,
          url: context.config.target.url,
          attempt: context.run.attempt,
        },
        provenance: localProvenance(),
        artifactIds: [],
      });
      for (const flow of context.config.test.browserFlows) {
        await this.emit(context.run.id, {
          kind: 'browser.action_started',
          stage,
          payload: {
            sessionId: browserSessionId,
            actionId: browserActionIds.get(flow.name)!,
            flow: flow.name,
            stepIndex: 0,
            attempt: context.run.attempt,
            summary: `Execute configured flow with ${flow.steps.length} step(s)`,
          },
          provenance: localProvenance(),
          artifactIds: [],
        });
      }
      browserAttempted = true;
      const evidence = await this.browser.runFlows({
        config: context.config,
        browser: browserInstallation,
        targetUrl: context.config.target.url,
        flows: context.config.test.browserFlows,
        signal: context.signal,
        timeoutMs: 120_000,
      });
      await this.emit(context.run.id, {
        kind: 'browser.navigation_completed',
        stage,
        payload: {
          sessionId: browserSessionId,
          navigationId,
          finalUrl: evidence[0]?.url ?? context.config.target.url,
          statusCode: null,
          durationMs: Date.now() - browserStartedAt,
        },
        provenance: localProvenance(),
        artifactIds: [],
      });
      for (const item of evidence) {
        const provenance = browserProvenance(item.session, browserInstallation?.name);
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
            {
              flow: item.flow,
              url: item.url,
              title: item.title,
              console: item.logs,
              session: item.session,
            },
            null,
            2
          )}\n`,
          provenance,
        });
        artifacts.push(screenshot, dom, report);
        output.push(`${item.flow}: ${item.title} (${item.url})`);
        const actionId = browserActionIds.get(item.flow);
        if (actionId) {
          await this.emit(context.run.id, {
            kind: 'browser.action_completed',
            stage,
            payload: {
              sessionId: browserSessionId,
              actionId,
              durationMs: Date.now() - browserStartedAt,
              summary: `Configured flow completed at ${item.url}`,
            },
            provenance,
            artifactIds: [screenshot.id, dom.id, report.id],
          });
        }
        await this.emit(context.run.id, {
          kind: 'browser.checkpoint',
          stage,
          payload: {
            sessionId: browserSessionId,
            checkpointId: randomUUID(),
            flow: item.flow,
            url: item.url,
            title: item.title,
            attempt: context.run.attempt,
          },
          provenance,
          artifactIds: [screenshot.id, dom.id, report.id],
        });
        await this.emit(context.run.id, {
          kind: 'evidence.captured',
          stage,
          payload: { name: item.flow, kind: 'browser' },
          provenance,
          artifactIds: [screenshot.id, dom.id, report.id],
        });
      }
      const integrationProvenance = browserProvenance(
        evidence[0]?.session,
        browserInstallation?.name
      );
      this.recordIntegration(
        'browser',
        'end-to-end-verified',
        `${evidence.length} configured ${context.config.browser.provider} browser flow(s) completed with captured evidence.`,
        integrationProvenance.source,
        context.config.browser.provider === 'browserbase'
          ? browserbaseEvidenceSourceUrl(evidence)
          : undefined,
        integrationProvenance.provider
      );
      await this.emit(context.run.id, {
        kind: 'browser.session_closed',
        stage,
        payload: {
          sessionId: browserSessionId,
          attempt: context.run.attempt,
          status: 'succeeded',
          durationMs: Date.now() - browserStartedAt,
        },
        provenance: localProvenance(),
        artifactIds: artifacts.map((artifact) => artifact.id),
      });
      browserSessionClosed = true;
      return { passed: true, output: output.join('\n'), artifacts };
    } catch (error) {
      const failureEvidence = error instanceof BrowserFlowError ? error.evidence : null;
      if (!context.signal.aborted && !(error instanceof TargetStartupError) && browserAttempted) {
        const kind =
          error instanceof BrowserModelOutputError
            ? 'invalid-output'
            : error instanceof BrowserModelProviderError
              ? 'provider'
              : isBrowserStartupFailure(error)
                ? 'startup'
                : error instanceof BrowserFlowError &&
                    error.evidence.flow !== 'cleanup' &&
                    error.evidence.flow !== 'initialization'
                  ? 'verification'
                  : 'adapter';
        this.recordBrowserIntegrationFailure(
          context,
          stage,
          kind,
          error,
          failureEvidence?.session,
          browserInstallation?.name
        );
      }
      const message =
        error instanceof TargetStartupError
          ? error.message
          : `Browser flow failed: ${errorMessage(error)}`;
      const startupOutput =
        error instanceof TargetStartupError && service
          ? formatStartupOutput(service.snapshot())
          : '';
      const provenance = failureEvidence
        ? browserProvenance(failureEvidence.session, browserInstallation?.name)
        : localProvenance();
      const failureArtifacts: Artifact[] = [];
      const failureName = slug(failureEvidence?.flow ?? 'browser-failure');
      if (failureEvidence?.screenshot) {
        failureArtifacts.push(
          await this.artifactStore.save({
            runId: context.run.id,
            kind: 'screenshot',
            name: `${stage}-${failureName}-failure.png`,
            mimeType: 'image/png',
            data: failureEvidence.screenshot,
            provenance,
          })
        );
      }
      if (failureEvidence?.dom) {
        failureArtifacts.push(
          await this.artifactStore.save({
            runId: context.run.id,
            kind: 'dom',
            name: `${stage}-${failureName}-failure.html`,
            mimeType: 'text/html',
            data: failureEvidence.dom,
            provenance,
          })
        );
      }
      if (failureEvidence) {
        failureArtifacts.push(
          await this.artifactStore.save({
            runId: context.run.id,
            kind: 'report',
            name: `${stage}-${failureName}-failure.json`,
            mimeType: 'application/json',
            data: `${JSON.stringify(
              {
                flow: failureEvidence.flow,
                url: failureEvidence.url,
                title: failureEvidence.title,
                console: failureEvidence.logs,
                error: failureEvidence.error,
                session: failureEvidence.session,
              },
              null,
              2
            )}\n`,
            provenance,
          })
        );
      }
      const logArtifact = await this.artifactStore.save({
        runId: context.run.id,
        kind: 'log',
        name: `${stage}-browser-error.log`,
        mimeType: 'text/plain',
        data: [message, startupOutput, failureEvidence?.logs.join('\n')]
          .filter(Boolean)
          .join('\n\n'),
        provenance,
      });
      failureArtifacts.push(logArtifact);
      artifacts.push(...failureArtifacts);
      await this.emit(context.run.id, {
        kind: 'evidence.captured',
        stage,
        payload: { name: 'Browser failure', kind: 'log' },
        provenance,
        artifactIds: failureArtifacts.map((artifact) => artifact.id),
      });
      if (browserSessionStarted) {
        await this.emit(context.run.id, {
          kind: 'browser.failed',
          stage,
          payload: {
            sessionId: browserSessionId,
            operation: failureEvidence?.flow ?? 'browser-flow',
            attempt: context.run.attempt,
            error: message,
          },
          provenance,
          artifactIds: failureArtifacts.map((artifact) => artifact.id),
        });
        await this.emit(context.run.id, {
          kind: 'browser.session_closed',
          stage,
          payload: {
            sessionId: browserSessionId,
            attempt: context.run.attempt,
            status: context.signal.aborted ? 'cancelled' : 'failed',
            durationMs: Date.now() - browserStartedAt,
          },
          provenance,
          artifactIds: failureArtifacts.map((artifact) => artifact.id),
        });
        browserSessionClosed = true;
      }
      if (service && !serviceReady) {
        await this.emit(context.run.id, {
          kind: 'target.service_failed',
          stage,
          payload: {
            serviceId,
            attempt: context.run.attempt,
            error: message,
          },
          provenance,
          artifactIds: [logArtifact.id],
        });
      }
      if (context.signal.aborted) throw error;
      if (error instanceof TargetStartupError) {
        throw new RunAttentionError(
          error.message,
          'target_startup_failure',
          applicationAction(
            'repair-target-health',
            'Repair target health',
            'Fix the start command, URL, or health path before retrying.',
            'configure_project'
          ),
          ['policy_acknowledged'],
          ['resolve_intervention', 'cancel'],
          failureArtifacts.map((artifact) => artifact.id)
        );
      }
      if (error instanceof BrowserModelOutputError) {
        throw new RunAttentionError(
          `Browser model returned invalid structured output: ${errorMessage(error)}`,
          'invalid_model_output',
          applicationAction(
            'repair-browser-model-output',
            'Repair browser model output',
            'Verify that the configured model can return Stagehand-compatible structured actions, then retry.',
            'configure_provider'
          ),
          ['provider_reconfigured'],
          ['resolve_intervention', 'cancel'],
          failureArtifacts.map((artifact) => artifact.id)
        );
      }
      if (error instanceof BrowserModelProviderError) {
        throw new RunAttentionError(
          `Browser model provider is unavailable or incompatible: ${errorMessage(error)}`,
          'provider_outage',
          applicationAction(
            'repair-browser-model-provider',
            'Repair browser model connection',
            'Verify that the configured endpoint and model support OpenAI-compatible chat completions, then retry.',
            'configure_provider'
          ),
          ['provider_reconfigured'],
          ['resolve_intervention', 'cancel'],
          failureArtifacts.map((artifact) => artifact.id)
        );
      }
      if (isBrowserStartupFailure(error)) {
        throw new RunAttentionError(
          `Browser startup failed: ${errorMessage(error)}`,
          'browser_startup_failure',
          applicationAction(
            'repair-browser',
            'Repair browser connection',
            'Verify the executable or Browserbase connection before retrying.',
            'configure_provider'
          ),
          ['browser_installed'],
          ['resolve_intervention', 'cancel'],
          failureArtifacts.map((artifact) => artifact.id)
        );
      }
      return { passed: false, output: message, artifacts };
    } finally {
      if (browserSessionStarted && !browserSessionClosed) {
        await this.emit(context.run.id, {
          kind: 'browser.session_closed',
          stage,
          payload: {
            sessionId: browserSessionId,
            attempt: context.run.attempt,
            status: context.signal.aborted ? 'cancelled' : 'failed',
            durationMs: Date.now() - browserStartedAt,
          },
          provenance: localProvenance(),
          artifactIds: artifacts.map((artifact) => artifact.id),
        });
      }
      if (service) {
        const exitedBeforeCleanup = await settledProcess(service.result);
        if (!exitedBeforeCleanup) await service.stop();
        const result = exitedBeforeCleanup ?? (await service.result);
        await Promise.all(serviceOutputEvents);
        await this.emit(context.run.id, {
          kind: 'target.service_exited',
          stage,
          payload: {
            serviceId,
            attempt: context.run.attempt,
            exitCode: result.exitCode,
            signal: result.signal,
            durationMs: result.durationMs,
            expected: exitedBeforeCleanup === null,
          },
          provenance: localProvenance(),
          artifactIds: [],
        });
      }
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
      const commandId = randomUUID();
      const streamedEvents: Array<Promise<unknown>> = [];
      const commandStartedAt = Date.now();
      await this.emit(context.run.id, {
        kind: 'command.started',
        stage,
        payload: {
          executable: command.executable,
          args: command.args,
          commandId,
          attempt: context.run.attempt,
        },
        provenance: localProvenance(),
        artifactIds: [],
      });
      let result: CommandResult;
      try {
        result = await this.processRunner.run(context.worktree.path, command, context.signal, {
          onOutput: (chunk) => {
            const output = this.boundedOutput(chunk.text, chunk.droppedBytes);
            streamedEvents.push(
              this.emit(context.run.id, {
                kind: 'command.output',
                stage,
                payload: {
                  commandId,
                  attempt: context.run.attempt,
                  stream: chunk.stream,
                  chunkIndex: chunk.sequence,
                  output,
                },
                provenance: localProvenance(),
                artifactIds: [],
              }),
              this.emitOutputBounds(context.run.id, stage, commandId, output, chunk.droppedBytes)
            );
          },
        });
      } catch (error) {
        await Promise.all(streamedEvents);
        const cancelled = context.signal.aborted;
        await this.emit(context.run.id, {
          kind: cancelled ? 'command.cancelled' : 'command.failed',
          stage,
          payload: {
            commandId,
            attempt: context.run.attempt,
            error: errorMessage(error),
            durationMs: Date.now() - commandStartedAt,
            output: this.boundedOutput('', 0),
          },
          provenance: localProvenance(),
          artifactIds: [],
        });
        throw error;
      }
      await Promise.all(streamedEvents);
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
      if (result.exitCode === 0) {
        await this.emit(context.run.id, {
          kind: 'command.completed',
          stage,
          payload: {
            executable: command.executable,
            args: command.args,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            commandId,
            attempt: context.run.attempt,
          },
          provenance: artifact.provenance,
          artifactIds: [artifact.id],
        });
      } else {
        const failedOutput = this.boundedOutput(result.combined, result.droppedBytes.combined);
        await this.emit(context.run.id, {
          kind: 'command.failed',
          stage,
          payload: {
            commandId,
            attempt: context.run.attempt,
            error: result.timedOut
              ? `Command timed out after ${command.timeoutMs}ms`
              : `Command exited with ${result.exitCode ?? result.signal ?? 'no status'}`,
            durationMs: result.durationMs,
            output: failedOutput,
          },
          provenance: artifact.provenance,
          artifactIds: [artifact.id],
        });
        await this.emitOutputBounds(
          context.run.id,
          stage,
          commandId,
          failedOutput,
          result.droppedBytes.combined
        );
      }
    }
    return {
      passed: commandResults.every(({ result }) => result.exitCode === 0),
      output: output.join('\n\n'),
      artifacts,
      commandResults,
    };
  }

  private boundedOutput(text: string, previouslyDroppedBytes: number): BoundedOutput {
    const bounded = this.storage.boundedOutput(text);
    const droppedBytes = Math.max(0, previouslyDroppedBytes);
    const omittedBytes = bounded.omittedBytes + droppedBytes;
    return {
      ...bounded,
      originalBytes: bounded.originalBytes + droppedBytes,
      omittedBytes,
      truncated: omittedBytes > 0,
      backpressure:
        omittedBytes > 0
          ? {
              droppedChunks:
                (bounded.backpressure?.droppedChunks ?? 0) + (droppedBytes > 0 ? 1 : 0),
              droppedBytes: omittedBytes,
            }
          : null,
    };
  }

  private async emitOutputBounds(
    runId: string,
    stage: RunStage,
    ownerId: string,
    output: BoundedOutput,
    sourceDroppedBytes: number
  ): Promise<void> {
    if (!output.truncated) return;
    const truncated = await this.emit(runId, {
      kind: 'output.truncated',
      stage,
      payload: {
        scope: 'command',
        ownerId,
        originalBytes: output.originalBytes,
        retainedBytes: output.retainedBytes,
        omittedBytes: output.omittedBytes,
        limitBytes: 48 * 1_024,
      },
      provenance: localProvenance(),
      artifactIds: [],
    });
    if (sourceDroppedBytes <= 0) return;
    await this.emit(runId, {
      kind: 'stream.backpressure',
      stage,
      payload: {
        scope: 'command',
        ownerId,
        droppedRecords: 1,
        droppedBytes: sourceDroppedBytes,
        resumeAfterSequence: truncated.sequence,
      },
      provenance: localProvenance(),
      artifactIds: [],
    });
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
    const diff = await this.gitRepository.diff(context.worktree, { signal: context.signal });
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
    let activeDiagnosis: Diagnosis | null = null;
    let repositoryContext: string | null = null;

    for (let iteration = 1; iteration <= context.config.limits.maxIterations; iteration += 1) {
      this.throwIfCancelled(context.signal);
      if (!activeDiagnosis) {
        await this.startStage(
          context.run.id,
          'triage',
          `Diagnosing grounded failure (${iteration}/${context.config.limits.maxIterations})`
        );
        const diagnosisCall = await this.callModel(
          context,
          'triage',
          TRIAGE_SYSTEM_PROMPT,
          diagnosisPrompt(failure),
          'qagent_diagnosis',
          DiagnosisOutputSchema,
          evidence.map((artifact) => artifact.id)
        );
        const diagnosisCompletion = diagnosisCall.value;
        activeDiagnosis = this.storage.createDiagnosis({
          id: randomUUID(),
          runId: context.run.id,
          summary: diagnosisCompletion.summary,
          rootCause: diagnosisCompletion.rootCause,
          confidence: diagnosisCompletion.confidence,
          evidenceArtifactIds: evidence.map((artifact) => artifact.id),
          provenance: {
            source: 'provider',
            provider: `${context.config.model.provider}/${context.config.model.model}`,
            capturedAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        });
        await this.emit(context.run.id, {
          kind: 'diagnosis.created',
          stage: 'triage',
          payload: {
            diagnosisId: activeDiagnosis.id,
            summary: activeDiagnosis.summary,
            confidence: activeDiagnosis.confidence,
          },
          provenance: activeDiagnosis.provenance,
          artifactIds: activeDiagnosis.evidenceArtifactIds,
        });
        this.recordProviderSpecialistOutcome({
          runId: context.run.id,
          stage: 'triage',
          role: 'trace',
          providerCallId: diagnosisCall.providerCallId,
          summary: `Trace identified ${activeDiagnosis.rootCause} (${Math.round(activeDiagnosis.confidence * 100)}% confidence).`,
          evidenceIds: activeDiagnosis.evidenceArtifactIds,
          handoffTarget: 'patch',
          actionRequired: 'Produce a minimal patch that addresses the diagnosed root cause.',
        });
        await this.completeStage(context.run.id, 'triage', activeDiagnosis.summary);
        repositoryContext = null;
      }
      const latestDiagnosis = activeDiagnosis;

      await this.startStage(context.run.id, 'patch', 'Generating and validating a minimal patch');
      repositoryContext ??= await this.gitRepository.gatherContext(
        context.worktree.path,
        `${failure}\n${latestDiagnosis.rootCause}`,
        { signal: context.signal }
      );
      const patchCall = await this.callModel(
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
        PatchOutputSchema,
        latestDiagnosis.evidenceArtifactIds
      );
      const patchCompletion = patchCall.value;
      const patchArtifact = await this.artifactStore.save({
        runId: context.run.id,
        kind: 'patch',
        name: `repair-${iteration}.diff`,
        mimeType: 'text/x-diff',
        data: patchCompletion.unifiedDiff,
        provenance: {
          source: 'provider',
          provider: `${context.config.model.provider}/${context.config.model.model}`,
          capturedAt: new Date().toISOString(),
        },
      });

      const pendingPatch = this.storage.createPatch({
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
      let inspection: Awaited<ReturnType<GitRepository['applyPatch']>>;
      try {
        context.assertLease();
        inspection = await this.gitRepository.applyPatch(
          context.worktree,
          patchCompletion.unifiedDiff,
          context.config.limits.maxPatchBytes,
          { signal: context.signal }
        );
      } catch (error) {
        if (
          context.signal.aborted ||
          error instanceof LeaseLostError ||
          error instanceof RunCancelledError
        ) {
          throw error;
        }
        previousAttempt = `Patch validation failed: ${errorMessage(error)}`;
        this.scheduleStageRetry(context.run.id, 'patch', previousAttempt, [patchArtifact.id]);
        continue;
      }
      inspection.files.forEach((file) => changedFiles.add(file));
      highRisk ||= inspection.highRisk;
      const latestPatch = this.storage.markPatchApplied(pendingPatch.id, inspection);
      this.storage.saveRunCheckpoint(context.run.id, 'patch_applied', {
        patchId: latestPatch.id,
        artifactId: patchArtifact.id,
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
      this.recordProviderSpecialistOutcome({
        runId: context.run.id,
        stage: 'patch',
        role: 'patch',
        providerCallId: patchCall.providerCallId,
        summary: `Patch produced a validated change across ${latestPatch.files.length} file(s): ${latestPatch.summary}`,
        evidenceIds: [patchArtifact.id],
        handoffTarget: 'proof',
        actionRequired: 'Run every configured verification command and browser flow.',
      });
      await this.completeStage(context.run.id, 'patch', latestPatch.summary);

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
      activeDiagnosis = null;
      repositoryContext = null;
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
    if (verification.passed) {
      this.storage.saveRunCheckpoint(context.run.id, 'verification_passed', {
        verificationId: verification.id,
      });
    }
    await this.emit(context.run.id, {
      kind: 'verification.completed',
      stage: 'verify',
      payload: { verificationId: verification.id, passed: verification.passed },
      provenance: localProvenance(),
      artifactIds: verification.artifactIds,
    });
    this.recordPolicySpecialistOutcome({
      runId: context.run.id,
      stage: 'verify',
      role: 'proof',
      status: verification.passed ? 'succeeded' : 'blocked',
      summary: verification.passed
        ? `Proof verified the repair with ${verification.commands.length} command result(s) and durable browser evidence where configured.`
        : 'Proof rejected the current repair because one or more configured checks failed.',
      evidenceIds: verification.artifactIds,
      ...(verification.passed
        ? {
            handoffTarget: 'gate' as const,
            actionRequired: 'Evaluate publication policy and repository requirements.',
          }
        : {
            actionRequired: 'Revise the patch using the failed verification artifacts.',
          }),
    });
    await this.completeStage(
      context.run.id,
      'verify',
      verification.passed ? 'Repair passed verification' : 'Repair failed verification',
      verification.passed ? 'succeeded' : 'failed',
      verification.artifactIds
    );
    return verification;
  }

  private async publishVerifiedRepair(
    context: ExecutionContext,
    repair: RepairOutcome
  ): Promise<Run> {
    const checkpoint = this.storage.getRunCheckpoint(context.run.id);
    const changedFiles = await this.gitRepository.changedFiles(context.worktree, {
      signal: context.signal,
    });
    const effectiveChangedFiles = changedFiles.length > 0 ? changedFiles : repair.patch.files;
    if (
      changedFiles.length === 0 &&
      checkpoint?.kind !== 'commit_created' &&
      checkpoint?.kind !== 'branch_pushed' &&
      checkpoint?.kind !== 'pull_request_created' &&
      checkpoint?.kind !== 'merge_observed' &&
      checkpoint?.kind !== 'postverify_passed'
    )
      throw new Error('Verified repair did not leave any changed files');
    let commitSha =
      checkpoint?.kind === 'commit_created' || checkpoint?.kind === 'branch_pushed'
        ? checkpoint.data.commitSha
        : checkpoint?.kind === 'pull_request_created'
          ? checkpoint.data.headSha
          : null;
    if (
      checkpoint?.kind !== 'commit_created' &&
      checkpoint?.kind !== 'branch_pushed' &&
      checkpoint?.kind !== 'pull_request_created' &&
      checkpoint?.kind !== 'merge_observed' &&
      checkpoint?.kind !== 'postverify_passed'
    ) {
      context.assertLease();
      commitSha = await this.gitRepository.commit(
        context.worktree,
        effectiveChangedFiles,
        `fix: ${repair.patch.summary.slice(0, 72)}`,
        { signal: context.signal }
      );
      this.storage.saveRunCheckpoint(context.run.id, 'commit_created', { commitSha });
      this.updateManifestHead(context.run.id, commitSha);
    }

    const policy = evaluatePublicationPolicy({
      originalCheckoutDirty: context.repository.dirty,
      patch: { files: effectiveChangedFiles, highRisk: repair.inspection.highRisk },
      configuredAutoMerge: context.config.publish.autoMerge,
    });
    await this.startStage(context.run.id, 'publish', 'Publishing the verified repair');
    if (!policy.mayPublish) {
      await this.completeStage(
        context.run.id,
        'publish',
        policy.reason ?? 'Publication blocked',
        'failed',
        [repair.patch.artifactId, ...repair.verification.artifactIds]
      );
      throw new RunAttentionError(
        policy.reason ?? 'Publication blocked by policy',
        context.repository.dirty ? 'dirty_checkout' : 'policy_blocked',
        context.repository.dirty
          ? applicationAction(
              'clean-checkout',
              'Clean source checkout',
              'Commit, stash, or remove source-checkout changes, then recheck publication.',
              'clean_checkout'
            )
          : applicationAction(
              'review-policy',
              'Review publication policy',
              'Review the policy boundary before retrying publication.',
              'review_policy'
            ),
        context.repository.dirty ? ['checkout_cleaned'] : ['policy_acknowledged'],
        ['resolve_intervention', 'cancel'],
        [repair.patch.artifactId, ...repair.verification.artifactIds]
      );
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
      throw new RunAttentionError(
        `Repair is verified on ${context.worktree.branch}, but GITHUB_TOKEN is not configured`,
        'github_auth_required',
        applicationAction(
          'configure-github',
          'Connect GitHub',
          'Store a GitHub credential and verify repository access before publishing.',
          'configure_provider'
        ),
        ['provider_reconfigured'],
        ['resolve_intervention', 'cancel'],
        [repair.patch.artifactId, ...repair.verification.artifactIds]
      );
    }

    try {
      context.assertLease();
      const rebased = await this.gitRepository.rebaseOnce(
        context.worktree,
        context.config.publish.baseBranch,
        { signal: context.signal }
      );
      if (rebased) await this.reverifyRebasedRepair(context);
    } catch (error) {
      throw new RunAttentionError(
        `The branch conflicted with its base: ${errorMessage(error)}`,
        'merge_conflict',
        applicationAction(
          'review-base-conflict',
          'Review base conflict',
          'Update the source branch or base branch, then retry publication in a new worktree.',
          'review_policy'
        ),
        ['policy_acknowledged']
      );
    }
    const publisher = this.githubPublisherFactory(this.githubToken);
    commitSha = (
      await this.gitRepository.inspectWorktreeState(context.worktree, {
        signal: context.signal,
      })
    ).headSha;
    let creationRecorded = false;
    const recordCreation = async (
      created: Awaited<ReturnType<GitHubPublisher['publish']>>
    ): Promise<void> => {
      if (creationRecorded) return;
      creationRecorded = true;
      this.storage.saveRunCheckpoint(context.run.id, 'branch_pushed', {
        branch: context.worktree.branch,
        commitSha: commitSha ?? context.worktree.baseSha,
      });
      this.storage.saveRunCheckpoint(context.run.id, 'pull_request_created', {
        number: created.number,
        url: created.url,
        headSha: commitSha ?? context.worktree.baseSha,
      });
      await this.emit(context.run.id, {
        kind: 'publication.created',
        stage: 'publish',
        payload: {
          url: created.url,
          number: created.number,
          autoMerge: created.autoMergeEnabled,
        },
        provenance: {
          source: 'github',
          provider: `${remote.owner}/${remote.repo}`,
          capturedAt: new Date().toISOString(),
        },
        artifactIds: [repair.patch.artifactId],
      });
      this.recordIntegration(
        'github',
        'end-to-end-verified',
        `Pull request #${created.number} exists for ${remote.owner}/${remote.repo}.`,
        'github',
        `https://github.com/${remote.owner}/${remote.repo}/pull/${created.number}`
      );
    };
    context.assertLease();
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
      onCreated: recordCreation,
    });
    await recordCreation(publication);

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
        context.assertLease();
        await this.gitRepository.rebaseOnce(context.worktree, context.config.publish.baseBranch, {
          signal: context.signal,
        });
        await this.reverifyRebasedRepair(context);
        await publisher.push(context.worktree, {
          forceWithLease: true,
          expectedRemoteSha: commitSha,
          signal: context.signal,
        });
      } catch (error) {
        throw new RunAttentionError(
          `The pull request still conflicts after one rebase attempt: ${errorMessage(error)}`,
          'merge_conflict',
          externalAction(
            'review-merge-conflict',
            'Review merge conflict',
            'Resolve the conflict in the existing pull request, then reconnect.',
            publication.url
          ),
          ['github_requirements_recheck_requested'],
          ['reconnect', 'resolve_intervention', 'cancel'],
          [repair.patch.artifactId, ...repair.verification.artifactIds]
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
      throw new RunAttentionError(
        publication.detail ?? 'Pull request remains open and requires repository action',
        publication.state === 'conflict' ? 'merge_conflict' : 'merge_waiting',
        externalAction(
          'review-pull-request',
          'Review pull request',
          'Complete required checks or review, then reconnect to the same pull request.',
          publication.url
        ),
        ['github_requirements_recheck_requested'],
        ['reconnect', 'resolve_intervention', 'cancel'],
        [repair.patch.artifactId, ...repair.verification.artifactIds]
      );
    }
    await this.startStage(context.run.id, 'merge', 'Recording the repository-controlled merge');
    await this.completeStage(context.run.id, 'merge', 'GitHub merged the verified repair');

    if (!publication.mergeCommitSha) {
      throw new RunAttentionError(
        'GitHub did not report the merged commit; exact post-merge verification was not started',
        'publication_failed',
        externalAction(
          'review-merge',
          'Review merged pull request',
          'Confirm the merge commit is visible, then reconnect.',
          publication.url
        ),
        ['github_requirements_recheck_requested'],
        ['reconnect', 'resolve_intervention', 'cancel'],
        [repair.patch.artifactId, ...repair.verification.artifactIds]
      );
    }
    this.storage.saveRunCheckpoint(context.run.id, 'merge_observed', {
      number: publication.number,
      mergeCommitSha: publication.mergeCommitSha,
    });
    this.updateManifestHead(context.run.id, publication.mergeCommitSha);
    context.assertLease();
    await this.gitRepository.checkoutMergedCommit(
      context.worktree,
      context.config.publish.baseBranch,
      publication.mergeCommitSha,
      { signal: context.signal }
    );

    const postverify = await this.runTests(context, 'postverify');
    if (!postverify.passed) {
      throw new RunAttentionError(
        'Post-merge verification failed in the isolated worktree',
        'verification_failed',
        applicationAction(
          'review-postmerge-verification',
          'Review verification evidence',
          'Inspect the post-merge command evidence before deciding whether to retry.',
          'review_policy'
        ),
        ['policy_acknowledged'],
        ['resolve_intervention', 'cancel'],
        postverify.artifacts.map((artifact) => artifact.id)
      );
    }
    this.storage.saveRunCheckpoint(context.run.id, 'postverify_passed', {
      mergeCommitSha: publication.mergeCommitSha,
    });
    await this.learn(context, repair);
    return this.completeRun(context.run.id, `Repair merged in ${publication.url}.`);
  }

  private async reverifyRebasedRepair(context: ExecutionContext): Promise<void> {
    const verification = await this.verify(context);
    if (!verification.passed) {
      throw new RunAttentionError(
        'The repair failed verification after rebasing onto the base',
        'verification_failed',
        applicationAction(
          'review-rebased-verification',
          'Review verification evidence',
          'Inspect the rebased verification evidence before retrying publication.',
          'review_policy'
        ),
        ['policy_acknowledged'],
        ['resolve_intervention', 'cancel'],
        verification.artifactIds
      );
    }
  }

  private async learn(context: ExecutionContext, repair: RepairOutcome): Promise<void> {
    context.assertLease();
    await this.startStage(context.run.id, 'learn', 'Persisting the verified local repair pattern');
    const importedAt = new Date().toISOString();
    const artifact = this.storage.getArtifact(repair.patch.artifactId);
    const diff = artifact ? (await this.artifactStore.read(artifact)).toString('utf8') : null;
    this.storage.importKnowledgeEntries([
      {
        id: context.run.id,
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
    schema: z.ZodType<T>,
    evidenceIds: string[] = []
  ): Promise<{ value: T; providerCallId: string }> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const startedAt = Date.now();
    let provider: string = context.config.model.provider;
    let modelName = context.config.model.model;
    let providerInitializationError: unknown;
    try {
      context.model ??= this.modelProviderFactory(context.config.model);
      provider = context.model.provider;
      modelName = context.model.model;
    } catch (error) {
      providerInitializationError = error;
    }
    const specialistRole = purpose === 'triage' ? ('trace' as const) : ('patch' as const);
    const stage = purpose === 'triage' ? ('triage' as const) : ('patch' as const);
    const requestDigest = sha256Text(JSON.stringify({ purpose, schemaName, system, prompt }));
    const durableEvidenceIds = [...new Set(evidenceIds)]
      .filter((artifactId) => this.storage.getArtifact(artifactId)?.runId === context.run.id)
      .slice(0, 64);
    const startedCall: ProviderCall = {
      id,
      runId: context.run.id,
      provider,
      model: modelName,
      purpose,
      status: 'started',
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      error: null,
      createdAt,
      attempt: context.run.attempt,
      startedAt: createdAt,
      completedAt: null,
      durationMs: null,
      specialistRole,
      evidenceIds: durableEvidenceIds,
      requestDigest,
      responseDigest: null,
      errorCode: null,
    };
    this.storage.beginProviderCall(startedCall, {
      kind: 'model.call_started',
      stage,
      payload: {
        providerCallId: id,
        provider,
        model: modelName,
        purpose,
        attempt: context.run.attempt,
        specialistRole,
      },
      provenance: {
        source: 'provider',
        provider: `${provider}/${modelName}`,
        capturedAt: createdAt,
      },
      artifactIds: durableEvidenceIds,
    });
    this.heartbeatActiveStage(
      context.run.id,
      `Waiting for ${specialistRole} model result`,
      `${provider}/${modelName}`
    );
    try {
      if (providerInitializationError) throw providerInitializationError;
      if (!context.model)
        throw new Error('Model provider initialization did not return a provider');
      const modelSignal = AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]);
      const completion = await context.model.complete({
        purpose,
        system,
        prompt,
        schemaName,
        schema,
        signal: modelSignal,
        timeoutMs: 120_000,
      });
      const durationMs = Date.now() - startedAt;
      const completedAt = new Date().toISOString();
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
        attempt: context.run.attempt,
        startedAt: createdAt,
        completedAt,
        durationMs,
        specialistRole,
        evidenceIds: durableEvidenceIds,
        requestDigest,
        responseDigest: sha256Text(JSON.stringify(completion.value)),
        errorCode: null,
      };
      this.storage.finishProviderCall(id, call, {
        kind: 'model.call_completed',
        stage,
        payload: {
          providerCallId: id,
          durationMs,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          costUsd: null,
        },
        provenance: {
          source: 'provider',
          provider: `${context.model.provider}/${context.model.model}`,
          capturedAt: completedAt,
        },
        artifactIds: durableEvidenceIds,
      });
      this.heartbeatActiveStage(context.run.id, `Processing ${specialistRole} model result`, null);
      this.recordIntegration(
        'model',
        'end-to-end-verified',
        `${purpose} returned schema-valid structured output with ${context.config.model.provider}/${context.config.model.model}.`,
        'provider'
      );
      return { value: completion.value, providerCallId: id };
    } catch (error) {
      const cancelled = context.signal.aborted;
      const message = errorMessage(error);
      const invalidOutput = isInvalidModelOutput(error);
      const durationMs = Date.now() - startedAt;
      const completedAt = new Date().toISOString();
      const failedCall: ProviderCall = {
        id,
        runId: context.run.id,
        provider,
        model: modelName,
        purpose,
        status: cancelled ? 'cancelled' : 'failed',
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        error: message,
        createdAt,
        attempt: context.run.attempt,
        startedAt: createdAt,
        completedAt,
        durationMs,
        specialistRole,
        evidenceIds: durableEvidenceIds,
        requestDigest,
        responseDigest: null,
        errorCode: cancelled
          ? 'cancelled'
          : invalidOutput
            ? 'invalid_model_output'
            : 'provider_error',
      };
      if (cancelled) {
        this.storage.finishProviderCall(id, failedCall, {
          kind: 'model.call_cancelled',
          stage,
          payload: {
            providerCallId: id,
            durationMs,
            error: message,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
          },
          provenance: {
            source: 'provider',
            provider: `${provider}/${modelName}`,
            capturedAt: completedAt,
          },
          artifactIds: durableEvidenceIds,
        });
      } else {
        this.storage.finishProviderCall(id, failedCall, {
          kind: 'model.call_failed',
          stage,
          payload: {
            providerCallId: id,
            durationMs,
            error: message,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
          },
          provenance: {
            source: 'provider',
            provider: `${provider}/${modelName}`,
            capturedAt: completedAt,
          },
          artifactIds: durableEvidenceIds,
        });
      }
      if (!cancelled) {
        this.heartbeatActiveStage(context.run.id, `${specialistRole} model call failed`, null);
      }
      if (cancelled) throw error;
      throw new RunAttentionError(
        `${context.config.model.provider}/${context.config.model.model} ${invalidOutput ? 'returned invalid structured output' : 'is unavailable'}: ${errorMessage(error)}`,
        invalidOutput ? 'invalid_model_output' : 'provider_outage',
        applicationAction(
          'repair-model-provider',
          invalidOutput ? 'Repair model output' : 'Repair model connection',
          invalidOutput
            ? 'Verify the configured model supports structured output, then retry.'
            : 'Check the provider credential, model ID, endpoint, and service health.',
          'configure_provider'
        ),
        ['provider_reconfigured']
      );
    }
  }

  private async startStage(runId: string, stage: RunStage, message: string): Promise<void> {
    const active = this.active.get(runId);
    if (active) this.throwIfCancelled(active.controller.signal);
    const previous = this.currentStageAttempt(runId);
    if (previous) {
      this.storage.completeStageAttempt(
        previous.id,
        'interrupted',
        `Superseded by ${stage}: ${message}`,
        [],
        localProvenance()
      );
      this.activeStageAttempts.delete(runId);
    }
    const attempt = this.storage.beginStageAttempt(runId, stage, message, localProvenance());
    this.activeStageAttempts.set(runId, { id: attempt.id, stage });
    this.storage.heartbeatStageAttempt(attempt.id, message, null, localProvenance());
  }

  private async completeStage(
    runId: string,
    stage: RunStage,
    message: string,
    status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted' = 'succeeded',
    evidenceIds: string[] = []
  ): Promise<void> {
    const active = this.active.get(runId);
    if (active) this.throwIfCancelled(active.controller.signal);
    let attempt = this.currentStageAttempt(runId, stage);
    if (!attempt) {
      const started = this.storage.beginStageAttempt(runId, stage, message, localProvenance());
      attempt = { id: started.id, stage };
    }
    this.storage.completeStageAttempt(attempt.id, status, message, evidenceIds, localProvenance());
    this.activeStageAttempts.delete(runId);
  }

  private scheduleStageRetry(
    runId: string,
    stage: RunStage,
    reason: string,
    evidenceIds: string[]
  ): void {
    const attempt = this.currentStageAttempt(runId, stage);
    if (!attempt) throw new Error(`No active ${stage} stage attempt is available for retry`);
    this.storage.scheduleStageRetry(
      attempt.id,
      reason,
      new Date().toISOString(),
      evidenceIds,
      localProvenance()
    );
    this.activeStageAttempts.delete(runId);
  }

  private currentStageAttempt(
    runId: string,
    stage?: RunStage
  ): { id: string; stage: RunStage } | null {
    const cached = this.activeStageAttempts.get(runId);
    if (cached && (!stage || cached.stage === stage)) return cached;
    const durable = this.storage
      .listStageAttempts(runId)
      .findLast(
        (attempt) =>
          (!stage || attempt.stage === stage) &&
          ['started', 'running', 'waiting'].includes(attempt.status)
      );
    return durable ? { id: durable.id, stage: durable.stage } : null;
  }

  private heartbeatActiveStage(
    runId: string,
    currentAction?: string,
    waitingOn: string | null = null
  ): void {
    const attempt = this.currentStageAttempt(runId);
    if (!attempt) return;
    this.storage.heartbeatStageAttempt(
      attempt.id,
      currentAction ?? `Executing ${attempt.stage}`,
      waitingOn,
      localProvenance()
    );
  }

  private settleActiveStage(
    runId: string,
    status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted',
    summary: string,
    evidenceIds: string[]
  ): void {
    const attempt = this.currentStageAttempt(runId);
    if (!attempt) return;
    this.storage.completeStageAttempt(attempt.id, status, summary, evidenceIds, localProvenance());
    this.activeStageAttempts.delete(runId);
  }

  private async emit(runId: string, input: NewRunEvent): Promise<RunEvent> {
    return this.storage.appendEvent(runId, input);
  }

  private recordTraceState(runId: string, stage: RunStage, state: TraceState): void {
    if (this.settlingRuns.has(runId)) return;
    if (this.traceStates.get(runId) === state) return;
    this.traceStates.set(runId, state);
    const capturedAt = new Date().toISOString();
    this.storage.appendEvent(runId, {
      kind: 'trace.status',
      stage,
      payload: { state },
      provenance:
        state === 'queued' || state === 'synced' || state === 'failed'
          ? { source: 'weave', provider: 'W&B Weave', capturedAt }
          : { source: 'local', provider: 'QAgent trace', capturedAt },
      artifactIds: [],
    });
    if (state === 'synced') {
      this.recordIntegration(
        'weave',
        'end-to-end-verified',
        'A locally redacted run event was delivered and the Weave queue was flushed.',
        'weave',
        this.traceSink.evidenceSourceUrl
      );
    }
  }

  private async completeRun(runId: string, summary: string): Promise<Run> {
    const run = this.storage.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found`);
    const verification = this.storage.getVerification(runId);
    const evidenceIds =
      verification?.artifactIds ??
      this.storage
        .listArtifacts(runId)
        .slice(-64)
        .map((artifact) => artifact.id);
    this.recordGateAssessment({
      runId,
      stage: run.stage,
      action: 'complete',
      summary: `Gate accepted the durable outcome: ${summary}`,
      evidenceIds,
    });
    this.storage.updateRun(runId, { stage: 'complete' });
    return this.finishRun(runId, 'succeeded', 'run.completed', summary);
  }

  private async finishRun(
    runId: string,
    status: 'succeeded' | 'failed' | 'cancelled' | 'policy_blocked',
    kind: 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.policy_blocked',
    message: string,
    failureCode: RunAttentionReason | null = status === 'failed' || status === 'policy_blocked'
      ? 'unexpected_failure'
      : null,
    availableActions: Run['availableActions'] = status === 'failed' || status === 'policy_blocked'
      ? ['retry']
      : []
  ): Promise<Run> {
    const existing = this.storage.getRun(runId);
    if (!existing) throw new Error(`Run ${runId} was not found`);
    if (['succeeded', 'failed', 'cancelled', 'policy_blocked'].includes(existing.status)) {
      return existing;
    }
    this.recordTraceState(runId, existing.stage, this.traceSink.state);
    this.settlingRuns.add(runId);
    this.settleActiveStage(
      runId,
      status === 'cancelled' ? 'cancelled' : status === 'succeeded' ? 'succeeded' : 'failed',
      message,
      this.storage
        .listArtifacts(runId)
        .slice(-64)
        .map((artifact) => artifact.id)
    );
    const artifacts = this.storage.listArtifacts(runId);
    const artifactIds = artifacts.map((artifact) => artifact.id);
    const evidenceLinks: EvidenceLink[] = artifacts.map((artifact) => ({
      artifactId: artifact.id,
      label: artifact.name,
      relationship: 'supports',
    }));
    const evidence: TerminalEvidence = {
      id: runId,
      runId,
      outcome: status,
      summary: message.slice(0, 4_000),
      evidenceAvailability: artifactIds.length > 0 ? 'ready' : 'unavailable',
      artifactIds,
      evidenceLinks,
      evidenceUnavailableReason:
        artifactIds.length > 0
          ? null
          : 'No durable artifacts were captured before the run reached its terminal outcome.',
      verificationId: this.storage.getVerification(runId)?.id ?? null,
      publication: this.publicationFromEvents(existing, this.storage.listEvents(runId)),
      createdAt: new Date().toISOString(),
    };
    const completedAt = evidence.createdAt;
    const terminalEvent = {
      kind,
      stage: existing.stage,
      payload: { message },
      provenance: localProvenance(),
      artifactIds: [],
    } as TerminalRunEvent;
    const durableTrace = this.storage
      .listEvents(runId)
      .findLast((event) => event.kind === 'trace.status');
    try {
      const finalized = await this.artifactStore.finalizeRunManifest({
        runId,
        status,
        stage: existing.stage,
        completedAt,
        traceState: durableTrace?.payload.state ?? 'local',
        traceProvider: durableTrace?.provenance.provider ?? null,
        terminalEvidence: evidence,
        terminalEvent,
        disposition: {
          failureCode,
          availableActions,
        },
      });
      return finalized.run;
    } catch (error) {
      this.settlingRuns.delete(runId);
      throw error;
    }
  }

  private finishUnexpected(runId: string, error: unknown): Promise<Run> {
    const classified = classifyUnexpectedFailure(error, this.storage.getRun(runId)?.stage);
    return this.finishRun(
      runId,
      'failed',
      'run.failed',
      errorMessage(error),
      classified.code,
      classified.retryable ? ['retry'] : []
    );
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason ?? new RunCancelledError('Run cancelled');
  }
}

function formatCommandLog(result: CommandResult): string {
  return [
    `$ ${[result.executable, ...result.args].join(' ')}`,
    [
      `exit=${result.exitCode ?? 'signal'}`,
      `signal=${result.signal ?? 'none'}`,
      `durationMs=${result.durationMs}`,
      `timedOut=${result.timedOut}`,
      `cancelled=${result.cancelled}`,
      `terminated=${result.terminated}`,
      `truncated=${result.truncated}`,
      `droppedBytes=${result.droppedBytes.combined}`,
    ].join(' '),
    result.combined,
  ].join('\n');
}

async function waitForUrl(
  url: string,
  signal: AbortSignal,
  service: ManagedProcess | null,
  healthWasReadyBeforeStart = false
): Promise<number> {
  const deadline = Date.now() + 30_000;
  let latest = 'No response';
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const exited = service ? await settledProcess(service.result) : null;
    if (exited) throw targetExitedError(exited);
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      });
      const status = response.status;
      await closeResponseBody(response);
      if (response.ok) {
        if (!service) return status;
        if (healthWasReadyBeforeStart) {
          const startupExit = await Promise.race([
            service.result,
            abortableDelay(5_000, signal).then(() => null),
          ]);
          if (startupExit) throw targetExitedError(startupExit);
          const diagnostics = formatStartupOutput(service.snapshot());
          throw new TargetStartupError(
            [
              `Target health endpoint was already ready before the configured start command: ${url}.`,
              'Readiness could not be attributed to the launched target process.',
              diagnostics,
            ]
              .filter(Boolean)
              .join('\n')
          );
        }
        const startupExit = await Promise.race([
          service.result,
          abortableDelay(250, signal).then(() => null),
        ]);
        if (startupExit) throw targetExitedError(startupExit);
        return status;
      }
      latest = `HTTP ${status}`;
    } catch (error) {
      if (error instanceof TargetStartupError || signal.aborted) throw error;
      latest = errorMessage(error);
    }
    await abortableDelay(500, signal);
  }
  throw new TargetStartupError(`Target readiness timed out at ${url}: ${latest}`);
}

async function urlRespondsOk(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
    });
    const ready = response.ok;
    await closeResponseBody(response);
    return ready;
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
}

async function closeResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Readiness only needs response headers; body cleanup is best-effort.
  }
}

async function settledProcess(result: Promise<CommandResult>): Promise<CommandResult | null> {
  return Promise.race([result, new Promise<null>((resolve) => setImmediate(() => resolve(null)))]);
}

function targetExitedError(result: CommandResult): TargetStartupError {
  const detail = formatStartupOutput(result);
  return new TargetStartupError(
    [
      `Target process exited before readiness (exit=${result.exitCode ?? 'signal'} signal=${result.signal ?? 'none'}).`,
      detail,
    ]
      .filter(Boolean)
      .join('\n')
  );
}

function formatStartupOutput(output: Pick<CommandResult, 'stdout' | 'stderr'>): string {
  const diagnostic = [
    output.stdout && `stdout:\n${output.stdout}`,
    output.stderr && `stderr:\n${output.stderr}`,
  ]
    .filter(Boolean)
    .join('\n');
  return diagnostic
    ? `Startup diagnostics:\n${diagnostic}`
    : 'Startup diagnostics: no output captured';
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    timeout.unref();
  });
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

function requestedByForRunAction(requestedBy: RunActionRequest['requestedBy']): Run['requestedBy'] {
  return requestedBy === 'recovery' ? 'resume' : requestedBy;
}

function applicationAction(
  id: string,
  label: string,
  description: string,
  action: Extract<CorrectiveAction, { type: 'application' }>['action']
): CorrectiveAction {
  return { id, type: 'application', label, description, action };
}

function externalAction(
  id: string,
  label: string,
  description: string,
  url: string
): CorrectiveAction {
  return { id, type: 'external', label, description, url };
}

function policyIntervention(message: string, evidenceArtifactIds: string[]): RunAttentionError {
  return new RunAttentionError(
    message,
    'policy_blocked',
    applicationAction(
      'review-policy',
      'Review policy',
      'Review the recorded policy boundary and correct the blocking condition.',
      'review_policy'
    ),
    ['policy_acknowledged'],
    ['resolve_intervention', 'cancel'],
    evidenceArtifactIds
  );
}

function classifyUnexpectedFailure(
  error: unknown,
  stage?: RunStage
): { code: RunAttentionReason; retryable: boolean } {
  const message = errorMessage(error).toLowerCase();
  if (message.includes('configuration') || message.includes('.qagent.yml')) {
    return { code: 'configuration_invalid', retryable: false };
  }
  if (stage === 'publish' || stage === 'wait_checks') {
    return { code: 'publication_failed', retryable: true };
  }
  if (stage === 'merge') {
    return {
      code: message.includes('conflict') ? 'merge_conflict' : 'publication_failed',
      retryable: true,
    };
  }
  if (
    stage === 'test' ||
    stage === 'triage' ||
    stage === 'patch' ||
    stage === 'verify' ||
    stage === 'postverify' ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('max iterations') ||
    message.includes('no verified repair')
  ) {
    return { code: 'verification_failed', retryable: true };
  }
  if (stage === 'preflight' && message.includes('worktree')) {
    return { code: 'worktree_recovery_failed', retryable: false };
  }
  return { code: 'unexpected_failure', retryable: true };
}

function isInvalidModelOutput(error: unknown): boolean {
  if (error instanceof z.ZodError) return true;
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('structured output') ||
    message.includes('schema validation') ||
    message.includes('invalid json') ||
    message.includes('json parse') ||
    message.includes('failed to parse')
  );
}

function isBrowserStartupFailure(error: unknown): boolean {
  if (error instanceof BrowserFlowError && error.evidence.flow === 'initialization') return true;
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('browser closed') ||
    message.includes('browser launch') ||
    message.includes('browser startup') ||
    message.includes('chromium') ||
    message.includes('executable')
  );
}

function browserProvenance(
  session: BrowserSessionMetadata | undefined,
  fallbackBrowserName?: string
): Provenance {
  const capturedAt = new Date().toISOString();
  if (session?.provider === 'browserbase') {
    return {
      source: 'provider',
      provider: session.sessionId ? `Browserbase session ${session.sessionId}` : 'Browserbase',
      capturedAt,
    };
  }
  return {
    source: 'local',
    provider: session?.browserName ?? fallbackBrowserName ?? 'Local Chromium',
    capturedAt,
  };
}

function githubProbeSummary(
  probe: GitHubRepositoryProbe,
  mergeMethod: QAgentConfig['publish']['mergeMethod']
): string {
  const rules =
    probe.rules.active.length > 0
      ? probe.rules.active.join(', ')
      : `classic protection ${probe.rules.classicProtection}`;
  return [
    `Authenticated as ${probe.identity.login} for ${probe.repository.fullName}.`,
    `Repository role ${probe.permissions.role}; pull=${probe.permissions.canPull}, push=${probe.permissions.canPush}, pull requests=${probe.permissions.pullRequests}.`,
    `Rules: ${rules}.`,
    `Checks: ${probe.checks.checkRuns} check run(s), ${probe.checks.statusContexts} status context(s), combined status ${probe.checks.combinedStatus}.`,
    `Merge: ${mergeMethod} ${probe.merge.allowedMethods.includes(mergeMethod) ? 'allowed' : 'not allowed'}, auto-merge=${probe.merge.allowAutoMerge}, merge queue required=${probe.merge.mergeQueueRequired}.`,
  ].join(' ');
}

function integrationCorrectiveAction(
  provider: IntegrationVerifyRequest['provider'],
  integration: Integration,
  disclosureRequired: boolean
): CorrectiveAction | null {
  if (
    !disclosureRequired &&
    (integration.status === 'healthy' || integration.status === 'end-to-end-verified')
  ) {
    return null;
  }
  if (provider === 'browser' && integration.provider === 'browser') {
    return applicationAction(
      'install-browser',
      'Install Chromium',
      'Install QAgent managed Chromium or configure a local executable, then verify again.',
      'install_browser'
    );
  }
  if (provider === 'github') {
    return applicationAction(
      'configure-github',
      'Configure GitHub',
      'Correct the credential, repository remote, or publication permissions, then verify again.',
      'configure_provider'
    );
  }
  if (provider === 'weave') {
    return applicationAction(
      'configure-weave',
      disclosureRequired ? 'Review Weave disclosure' : 'Configure Weave',
      disclosureRequired
        ? 'Accept the telemetry disclosure before sending and flushing a redacted probe.'
        : 'Correct the W&B credential or Weave project, then verify again.',
      'configure_provider'
    );
  }
  return applicationAction(
    `configure-${provider}`,
    `Configure ${provider}`,
    `Correct the ${provider} configuration, then run the authenticated probe again.`,
    'configure_provider'
  );
}

function safeProbeError(error: unknown): string {
  let message = errorMessage(error);
  for (const name of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_API_KEY',
    'GITHUB_TOKEN',
    'BROWSERBASE_API_KEY',
    'WANDB_API_KEY',
  ]) {
    const secret = process.env[name];
    if (secret && secret.length >= 4) message = message.replaceAll(secret, '[REDACTED]');
  }
  return message
    .replace(/bearer\s+[a-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/gh[pousr]_[a-z0-9_]+/gi, '[REDACTED]')
    .slice(0, 2_000);
}

function isSanitizedHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function browserbaseEvidenceSourceUrl(evidence: BrowserEvidence[]): string | undefined {
  const sessionUrl = evidence.find(
    (item) => item.session?.provider === 'browserbase' && item.session.sessionUrl
  )?.session?.sessionUrl;
  if (sessionUrl) {
    try {
      const parsed = new URL(sessionUrl);
      parsed.search = '';
      parsed.hash = '';
      const hostname = parsed.hostname.toLowerCase();
      const sanitized = parsed.toString();
      if (
        (hostname === 'browserbase.com' || hostname.endsWith('.browserbase.com')) &&
        !containsConfiguredSecret(sanitized) &&
        isSanitizedHttpsUrl(sanitized)
      ) {
        return sanitized;
      }
    } catch {
      // Fall through to the project probe URL when session metadata is malformed.
    }
  }
  const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
  if (!projectId || containsConfiguredSecret(projectId)) return undefined;
  const sourceUrl = `https://api.browserbase.com/v1/projects/${encodeURIComponent(projectId)}`;
  return isSanitizedHttpsUrl(sourceUrl) ? sourceUrl : undefined;
}

function containsConfiguredSecret(value: string): boolean {
  return ['GITHUB_TOKEN', 'BROWSERBASE_API_KEY', 'WANDB_API_KEY'].some((name) => {
    const secret = process.env[name];
    return Boolean(
      secret &&
      secret.length >= 4 &&
      (value.includes(secret) || value.includes(encodeURIComponent(secret)))
    );
  });
}

function dedupeEvidenceLinks(links: EvidenceLink[]): EvidenceLink[] {
  return [
    ...new Map(
      links.map((link) => [`${link.artifactId}:${link.relationship}:${link.label}`, link])
    ).values(),
  ];
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'flow'
  );
}
