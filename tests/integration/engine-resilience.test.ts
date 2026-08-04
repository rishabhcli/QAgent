import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  detectProject,
  GitRepository,
  type ModelCompletion,
  type ModelProvider,
  type ModelRequest,
  writeProjectConfig,
} from '@qagent/adapters';
import type { QAgentConfig } from '@qagent/contracts';
import { PolicyBlockedError, QAgentEngine } from '@qagent/core';
import { ArtifactStore, QAgentStorage } from '@qagent/storage';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DeterministicRepairModel,
  git,
  readCounter,
  temporaryDirectory,
  temporaryFixtureRepository,
} from '../helpers.js';

const openStorage: QAgentStorage[] = [];

afterEach(() => {
  for (const storage of openStorage.splice(0)) storage.close();
});

describe('QAgentEngine recovery and failure boundaries', () => {
  it('guards project, durable run, and cancellation identities', async () => {
    const repository = await temporaryFixtureRepository();
    const { engine, storage } = await createEngine(new DeterministicRepairModel());
    const project = await engine.addProject(repository);

    expect((await engine.addProject(repository)).id).toBe(project.id);
    expect((await engine.addProject(repository, true)).trusted).toBe(true);
    expect(engine.trustProject(project.id).trusted).toBe(true);
    expect(engine.listProjects().map((item) => item.id)).toContain(project.id);

    await expect(engine.startRun({ projectId: randomUUID(), requestedBy: 'cli' })).rejects.toThrow(
      /was not found/
    );
    await expect(
      engine.startRun({
        projectId: project.id,
        requestedBy: 'cli',
        resumeRunId: randomUUID(),
      })
    ).rejects.toThrow(/Run .* was not found/);

    const queued = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const otherProject = storage.createProject({
      name: 'Other project',
      path: join(repository, 'other'),
      trusted: true,
    });
    await expect(
      engine.startRun({
        projectId: otherProject.id,
        requestedBy: 'desktop',
        resumeRunId: queued.id,
      })
    ).rejects.toThrow(/does not belong/);

    await engine.cancelRun(randomUUID());
    await engine.cancelRun(queued.id, 'Cancelled before activation');
    await engine.cancelRun(queued.id);
    expect(engine.getRun(queued.id)).toMatchObject({ status: 'cancelled' });
    expect(engine.listRuns(project.id).map((run) => run.id)).toContain(queued.id);
    const cancellationEventKinds = engine.getRunEvents(queued.id).map((event) => event.kind);
    expect(cancellationEventKinds.filter((kind) => kind === 'terminal.evidence')).toHaveLength(1);
    expect(cancellationEventKinds.filter((kind) => kind === 'run.cancelled')).toHaveLength(1);
    expect(cancellationEventKinds.indexOf('terminal.evidence')).toBeLessThan(
      cancellationEventKinds.indexOf('run.cancelled')
    );
  });

  it('requires provider intervention when the default model has no credential', async () => {
    const repository = await temporaryFixtureRepository();
    await updateConfig(repository, (config) => {
      config.test.browserFlows = [];
    });
    const home = await temporaryDirectory('qagent-default-provider-');
    const storage = new QAgentStorage(join(home, 'qagent.sqlite'));
    openStorage.push(storage);
    const engine = new QAgentEngine({
      storage,
      artifactStore: new ArtifactStore(join(home, 'artifacts'), storage),
      qagentHome: home,
    });
    const existingKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const project = await engine.addProject(repository, true);
      const result = await (
        await engine.startRun({ projectId: project.id, requestedBy: 'desktop' })
      ).result();
      expect(result).toMatchObject({
        status: 'waiting_for_intervention',
        error: expect.stringContaining('OPENAI'),
        failureCode: 'provider_outage',
        availableActions: ['resolve_intervention', 'cancel'],
        intervention: {
          reason: 'provider_outage',
          resolutionOptions: ['provider_reconfigured'],
          requiredAction: {
            type: 'application',
            action: 'configure_provider',
          },
        },
      });
      expectNoTerminalEvent(engine, result.id);
    } finally {
      if (existingKey) process.env.OPENAI_API_KEY = existingKey;
    }
  });

  it('completes without a model call when grounded checks find no defect', async () => {
    const repository = await temporaryFixtureRepository();
    await writeFile(
      join(repository, 'src/counter.mjs'),
      (await readCounter(repository)).replace('value + 2', 'value + 1')
    );
    await git(repository, ['add', 'src/counter.mjs']);
    await git(repository, [
      '-c',
      'user.name=QAgent tests',
      '-c',
      'user.email=tests@qagent.local',
      'commit',
      '-m',
      'fix fixture baseline',
    ]);
    await updateConfig(repository, (config) => {
      config.test.browserFlows = [];
    });
    const model = new DeterministicRepairModel();
    const { engine, storage } = await createEngine(model);
    const project = await engine.addProject(repository, true);
    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'desktop' })
    ).result();

    expect(result.status).toBe('succeeded');
    expect(result.summary).toMatch(/No defects found/);
    expect(model.calls).toEqual([]);
    expect(storage.listEvents(result.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'trace.status', payload: { state: 'local' } }),
      ])
    );
  });

  it('records actionable provider intervention without substituting a fake model', async () => {
    const repository = await temporaryFixtureRepository();
    await updateConfig(repository, (config) => {
      config.test.browserFlows = [];
    });
    const provider: ModelProvider = {
      provider: 'unavailable-test-provider',
      model: 'none',
      complete: async () => {
        throw new Error('provider is unavailable');
      },
    };
    const { engine, storage } = await createEngine(provider);
    const project = await engine.addProject(repository, true);
    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'cli' })
    ).result();

    expect(result).toMatchObject({
      status: 'waiting_for_intervention',
      failureCode: 'provider_outage',
      availableActions: ['resolve_intervention', 'cancel'],
      intervention: {
        reason: 'provider_outage',
        resolutionOptions: ['provider_reconfigured'],
        requiredAction: {
          type: 'application',
          action: 'configure_provider',
        },
      },
    });
    expect(result.error).toContain('openai/gpt-5-mini is unavailable');
    expect(result.error).toContain('provider is unavailable');
    expect(storage.listProviderCalls(result.id)).toEqual([
      expect.objectContaining({
        provider: 'unavailable-test-provider',
        status: 'failed',
        error: 'provider is unavailable',
      }),
    ]);
    expect(storage.getPatch(result.id)).toBeNull();
    expectNoTerminalEvent(engine, result.id);
  });

  it('retries a rejected patch and verifies the next bounded attempt', async () => {
    const repository = await temporaryFixtureRepository();
    await updateConfig(repository, (config) => {
      config.test.browserFlows = [];
      config.limits.maxIterations = 2;
    });
    const provider = new RetryRepairModel();
    const { engine, storage } = await createEngine(provider);
    const project = await engine.addProject(repository, true);
    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'cli' })
    ).result();

    expect(result.status).toBe('succeeded');
    expect(provider.patchAttempts).toBe(2);
    expect(storage.listArtifacts(result.id).filter((item) => item.kind === 'patch')).toHaveLength(
      2
    );
    expect(storage.getPatch(result.id)?.applied).toBe(true);
  });

  it('durably cancels a running child process', async () => {
    const repository = await temporaryFixtureRepository();
    await updateConfig(repository, (config) => {
      const command = {
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        cwd: '.',
        env: {},
        timeoutMs: 120_000,
      };
      config.test.commands = [command];
      config.verify.commands = [command];
      config.test.browserFlows = [];
    });
    const { engine } = await createEngine(new DeterministicRepairModel());
    const project = await engine.addProject(repository, true);
    const handle = await engine.startRun({ projectId: project.id, requestedBy: 'mcp' });
    for await (const event of handle.events()) {
      if (event.kind === 'command.started') {
        await expect(
          engine.startRun({
            projectId: project.id,
            requestedBy: 'mcp',
            resumeRunId: handle.id,
          })
        ).rejects.toThrow(/already active/);
        expect(await engine.resumeInterruptedRuns()).toEqual([]);
        await handle.cancel('Test cancellation');
        break;
      }
    }
    const result = await handle.result();
    expect(result.status).toBe('cancelled');
    expect(result.error).toContain('Test cancellation');
    expect(
      engine.getRunEvents(result.id).filter((event) => event.kind === 'run.cancelled')
    ).toHaveLength(1);
  }, 30_000);

  it('requires policy intervention for a second concurrent mutation run', async () => {
    const repository = await temporaryFixtureRepository();
    await updateConfig(repository, (config) => {
      config.test.commands = [
        {
          executable: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 60000)'],
          cwd: '.',
          env: {},
          timeoutMs: 120_000,
        },
      ];
      config.test.browserFlows = [];
    });
    const { engine } = await createEngine(new DeterministicRepairModel());
    const project = await engine.addProject(repository, true);
    const first = await engine.startRun({ projectId: project.id, requestedBy: 'desktop' });
    for await (const event of first.events()) {
      if (event.kind === 'command.started') break;
    }
    const second = await engine.startRun({ projectId: project.id, requestedBy: 'cli' });
    const blocked = await second.result();
    expect(blocked).toMatchObject({
      status: 'waiting_for_intervention',
      failureCode: 'policy_blocked',
      availableActions: ['resolve_intervention', 'cancel'],
      intervention: {
        reason: 'policy_blocked',
        resolutionOptions: ['policy_acknowledged'],
        requiredAction: {
          type: 'application',
          action: 'review_policy',
        },
      },
    });
    expect(blocked.error).toMatch(/already mutating/);
    expectNoTerminalEvent(engine, blocked.id);
    await first.cancel('Lease test complete');
    expect((await first.result()).status).toBe('cancelled');
  }, 30_000);

  it('interrupts safely when its project lease renewal is rejected', async () => {
    const repository = await temporaryFixtureRepository();
    await updateConfig(repository, (config) => {
      config.test.browserFlows = [];
    });
    const home = await temporaryDirectory('qagent-lease-loss-');
    const storage = new RejectFirstRenewalStorage(join(home, 'qagent.sqlite'));
    openStorage.push(storage);
    const engine = new QAgentEngine({
      storage,
      artifactStore: new ArtifactStore(join(home, 'artifacts'), storage),
      qagentHome: home,
      modelProviderFactory: () => new DeterministicRepairModel(),
    });
    const project = await engine.addProject(repository, true);
    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'desktop' })
    ).result();

    expect(result).toMatchObject({
      status: 'interrupted',
      failureCode: 'interrupted_recovery',
      availableActions: ['resume', 'cancel'],
      intervention: null,
      recoveryCount: 1,
    });
    expect(result.error).toContain('project mutation lease was lost');
    expect(storage.getRunCheckpoint(result.id)).toBeNull();
    expectNoTerminalEvent(engine, result.id);
    expect(
      engine.getRunEvents(result.id).filter((event) => event.kind === 'run.interrupted')
    ).toHaveLength(1);
    expect(storage.acquireLease(project.id, result.id)).toBe(true);
    storage.releaseLease(project.id, result.id);
  });

  it('requires early policy intervention and terminalizes only after verification', async () => {
    const repository = await temporaryFixtureRepository();
    await updateConfig(repository, (config) => {
      config.test.browserFlows = [];
    });

    const preflight = await createEngineWithGitRepository(new PreflightPolicyBlockGitRepository());
    const preflightProject = await preflight.engine.addProject(repository, true);
    const preflightBlocked = await (
      await preflight.engine.startRun({
        projectId: preflightProject.id,
        requestedBy: 'desktop',
      })
    ).result();
    expect(preflightBlocked).toMatchObject({
      status: 'waiting_for_intervention',
      failureCode: 'policy_blocked',
      availableActions: ['resolve_intervention', 'cancel'],
      intervention: {
        reason: 'policy_blocked',
        resolutionOptions: ['policy_acknowledged'],
        requiredAction: {
          type: 'application',
          action: 'review_policy',
        },
      },
    });
    expect(preflight.storage.getRunCheckpoint(preflightBlocked.id)).toBeNull();
    expectNoTerminalEvent(preflight.engine, preflightBlocked.id);

    const isolated = await createEngineWithGitRepository(
      new WorktreeCheckpointPolicyBlockGitRepository()
    );
    const isolatedProject = await isolated.engine.addProject(repository, true);
    const isolatedBlocked = await (
      await isolated.engine.startRun({
        projectId: isolatedProject.id,
        requestedBy: 'desktop',
      })
    ).result();
    expect(isolatedBlocked).toMatchObject({
      status: 'waiting_for_intervention',
      failureCode: 'policy_blocked',
      availableActions: ['resolve_intervention', 'cancel'],
      intervention: {
        reason: 'policy_blocked',
        resolutionOptions: ['policy_acknowledged'],
        requiredAction: {
          type: 'application',
          action: 'review_policy',
        },
      },
    });
    expect(isolated.storage.getRunCheckpoint(isolatedBlocked.id)?.kind).toBe('worktree_created');
    expectNoTerminalEvent(isolated.engine, isolatedBlocked.id);

    const postCheckpoint = await createEngineWithGitRepository(
      new PostCheckpointPolicyBlockGitRepository()
    );
    const postCheckpointProject = await postCheckpoint.engine.addProject(repository, true);
    const terminal = await (
      await postCheckpoint.engine.startRun({
        projectId: postCheckpointProject.id,
        requestedBy: 'desktop',
      })
    ).result();
    expect(terminal).toMatchObject({
      status: 'policy_blocked',
      failureCode: 'policy_blocked',
      availableActions: ['retry'],
      intervention: null,
    });
    expect(terminal.error).toContain('Post-checkpoint policy block');
    expect(postCheckpoint.storage.getRunCheckpoint(terminal.id)?.kind).toBe('verification_passed');
    expect(
      postCheckpoint.engine
        .getRunEvents(terminal.id)
        .filter((event) => event.kind === 'run.policy_blocked')
    ).toHaveLength(1);
    expectSingleTerminalEvent(postCheckpoint.engine, terminal.id, 'run.policy_blocked');
  });

  it('resumes a durable interrupted run after restart', async () => {
    const repository = await temporaryFixtureRepository();
    await writeFile(
      join(repository, 'src/counter.mjs'),
      (await readCounter(repository)).replace('value + 2', 'value + 1')
    );
    await git(repository, ['add', 'src/counter.mjs']);
    await git(repository, [
      '-c',
      'user.name=QAgent tests',
      '-c',
      'user.email=tests@qagent.local',
      'commit',
      '-m',
      'fix fixture baseline',
    ]);
    await updateConfig(repository, (config) => {
      config.test.browserFlows = [];
    });
    const model = new DeterministicRepairModel();
    const { engine, storage } = await createEngine(model);
    const project = await engine.addProject(repository, true);
    const interrupted = storage.createRun({ projectId: project.id, requestedBy: 'resume' });
    storage.updateRun(interrupted.id, { status: 'running' });
    const handles = await engine.resumeInterruptedRuns();
    expect(handles).toHaveLength(1);
    const result = await handles[0]!.result();
    expect(result.id).toBe(interrupted.id);
    expect(result.status).toBe('succeeded');
    expect(
      engine.getRunEvents(result.id).find((event) => event.kind === 'run.interrupted')?.payload
    ).toEqual({
      message: 'The previous runtime stopped; durable recovery is starting.',
      recoveryCount: 1,
    });
  });

  it('does not mutate a legacy terminal run while scanning for restart recovery', async () => {
    const home = await temporaryDirectory('qagent-legacy-terminal-');
    const databasePath = join(home, 'qagent.sqlite');
    const storage = new QAgentStorage(databasePath);
    openStorage.push(storage);
    const project = storage.createProject({
      name: 'Legacy terminal project',
      path: await temporaryDirectory('qagent-legacy-terminal-project-'),
      trusted: true,
    });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'desktop' });
    storage.settleRunOnce(
      run.id,
      'failed',
      {
        kind: 'run.failed',
        stage: 'preflight',
        payload: { message: 'Legacy terminal failure' },
        provenance: {
          source: 'local',
          provider: 'Legacy QAgent runtime',
          capturedAt: new Date().toISOString(),
        },
        artifactIds: [],
      },
      {
        failureCode: 'unexpected_failure',
        availableActions: ['retry'],
      }
    );
    const eventsBeforeRestart = storage.listEvents(run.id);
    const artifactsBeforeRestart = storage.listArtifacts(run.id);
    expect(eventsBeforeRestart.at(-1)?.kind).toBe('run.failed');
    expect(storage.getRunManifest(run.id)).toBeNull();

    storage.close();
    openStorage.splice(openStorage.indexOf(storage), 1);
    const reopened = new QAgentStorage(databasePath);
    openStorage.push(reopened);
    const restarted = new QAgentEngine({
      storage: reopened,
      artifactStore: new ArtifactStore(join(home, 'artifacts'), reopened),
      qagentHome: home,
    });

    await expect(restarted.resumeInterruptedRuns()).resolves.toEqual([]);
    expect(reopened.listEvents(run.id)).toEqual(eventsBeforeRestart);
    expect(reopened.listEvents(run.id).at(-1)?.kind).toBe('run.failed');
    expect(reopened.listArtifacts(run.id)).toEqual(artifactsBeforeRestart);
    expect(reopened.getRunManifest(run.id)).toBeNull();
  });

  it('requires actionable intervention for missing configuration and browser', async () => {
    const missingConfig = await temporaryFixtureRepository();
    await rm(join(missingConfig, '.qagent.yml'));
    await git(missingConfig, ['add', '-u']);
    await git(missingConfig, [
      '-c',
      'user.name=QAgent tests',
      '-c',
      'user.email=tests@qagent.local',
      'commit',
      '-m',
      'remove config',
    ]);
    const { engine } = await createEngine(new DeterministicRepairModel());
    const project = await engine.addProject(missingConfig, true);
    const missing = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'cli' })
    ).result();
    expect(missing).toMatchObject({
      status: 'waiting_for_intervention',
      failureCode: 'configuration_invalid',
      availableActions: ['resolve_intervention', 'cancel'],
      intervention: {
        reason: 'configuration_invalid',
        resolutionOptions: ['policy_acknowledged'],
        requiredAction: {
          type: 'application',
          action: 'configure_project',
        },
      },
    });
    expect(missing.error).toMatch(/valid .qagent.yml/);
    expectNoTerminalEvent(engine, missing.id);

    const browserRepository = await temporaryFixtureRepository();
    const unavailable = await createEngine(new DeterministicRepairModel(), async () => null);
    const browserProject = await unavailable.engine.addProject(browserRepository, true);
    const browserRun = await (
      await unavailable.engine.startRun({ projectId: browserProject.id, requestedBy: 'desktop' })
    ).result();
    expect(browserRun).toMatchObject({
      status: 'waiting_for_intervention',
      failureCode: 'browser_startup_failure',
      availableActions: ['resolve_intervention', 'cancel'],
      intervention: {
        reason: 'browser_startup_failure',
        resolutionOptions: ['browser_installed'],
        requiredAction: {
          type: 'application',
          action: 'install_browser',
        },
      },
    });
    expect(browserRun.error).toMatch(/No Chrome-compatible browser/);
    expect(unavailable.storage.getIntegration('browser')).toMatchObject({
      status: 'unconfigured',
      detail: expect.stringContaining(browserRun.id),
      provenance: {
        source: 'local',
        provider: 'QAgent browser configuration',
      },
    });
    expectNoTerminalEvent(unavailable.engine, browserRun.id);
  });
});

function expectNoTerminalEvent(engine: QAgentEngine, runId: string): void {
  expect(
    engine
      .getRunEvents(runId)
      .filter((event) =>
        ['run.completed', 'run.failed', 'run.cancelled', 'run.policy_blocked'].includes(event.kind)
      )
  ).toHaveLength(0);
}

function expectSingleTerminalEvent(
  engine: QAgentEngine,
  runId: string,
  expectedKind: 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.policy_blocked'
): void {
  const terminalEvents = engine
    .getRunEvents(runId)
    .filter((event) =>
      ['run.completed', 'run.failed', 'run.cancelled', 'run.policy_blocked'].includes(event.kind)
    );
  expect(terminalEvents).toHaveLength(1);
  expect(terminalEvents[0]?.kind).toBe(expectedKind);
}

class RetryRepairModel implements ModelProvider {
  readonly provider = 'test';
  readonly model = 'retry';
  patchAttempts = 0;

  async complete<T>(request: ModelRequest<T>): Promise<ModelCompletion<T>> {
    const deterministic = new DeterministicRepairModel();
    if (request.purpose === 'triage') return deterministic.complete(request);
    this.patchAttempts += 1;
    if (this.patchAttempts === 1) {
      return {
        value: request.schema.parse({
          summary: 'Unsafe first attempt',
          unifiedDiff:
            'diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-A=1\n+A=2\n',
        }),
        inputTokens: 1,
        outputTokens: 1,
      };
    }
    return deterministic.complete(request);
  }
}

class RejectFirstRenewalStorage extends QAgentStorage {
  override renewLease(): boolean {
    return false;
  }
}

class PreflightPolicyBlockGitRepository extends GitRepository {
  override async inspect(): Promise<never> {
    throw new PolicyBlockedError('Preflight policy block');
  }
}

class WorktreeCheckpointPolicyBlockGitRepository extends GitRepository {
  override async gatherContext(): Promise<never> {
    throw new PolicyBlockedError('Isolated-worktree policy block');
  }
}

class PostCheckpointPolicyBlockGitRepository extends GitRepository {
  override async commit(): Promise<never> {
    throw new PolicyBlockedError('Post-checkpoint policy block');
  }
}

async function createEngine(
  model: ModelProvider,
  browserDetector: QAgentEngineConstructorOptions['browserDetector'] = async () => null
) {
  const home = await temporaryDirectory('qagent-resilience-');
  const storage = new QAgentStorage(join(home, 'qagent.sqlite'));
  openStorage.push(storage);
  return {
    storage,
    engine: new QAgentEngine({
      storage,
      artifactStore: new ArtifactStore(join(home, 'artifacts'), storage),
      qagentHome: home,
      browserDetector,
      modelProviderFactory: () => model,
    }),
  };
}

async function createEngineWithGitRepository(gitRepository: GitRepository) {
  const home = await temporaryDirectory('qagent-policy-boundary-');
  const storage = new QAgentStorage(join(home, 'qagent.sqlite'));
  openStorage.push(storage);
  return {
    storage,
    engine: new QAgentEngine({
      storage,
      artifactStore: new ArtifactStore(join(home, 'artifacts'), storage),
      qagentHome: home,
      gitRepository,
      modelProviderFactory: () => new DeterministicRepairModel(),
    }),
  };
}

type QAgentEngineConstructorOptions = ConstructorParameters<typeof QAgentEngine>[0];

async function updateConfig(
  repository: string,
  update: (config: QAgentConfig) => void
): Promise<void> {
  const detected = await detectProject(repository);
  if (!detected.config) throw new Error('Fixture config was not found');
  update(detected.config);
  await writeProjectConfig(repository, detected.config, { force: true });
  await git(repository, ['add', '.qagent.yml']);
  await git(repository, [
    '-c',
    'user.name=QAgent tests',
    '-c',
    'user.email=tests@qagent.local',
    'commit',
    '-m',
    'update qagent config',
  ]);
}
