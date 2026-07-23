import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  detectProject,
  type ModelCompletion,
  type ModelProvider,
  type ModelRequest,
  writeProjectConfig,
} from '@qagent/adapters';
import type { QAgentConfig } from '@qagent/contracts';
import { QAgentEngine } from '@qagent/core';
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
    expect(engine.getRunEvents(queued.id).map((event) => event.kind)).toEqual(['run.cancelled']);
  });

  it('fails visibly when the default model provider has no credential', async () => {
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
      expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('OPENAI') });
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
    const { engine } = await createEngine(model);
    const project = await engine.addProject(repository, true);
    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'desktop' })
    ).result();

    expect(result.status).toBe('succeeded');
    expect(result.summary).toMatch(/No defects found/);
    expect(model.calls).toEqual([]);
  });

  it('records provider failure without substituting a fake model', async () => {
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

    expect(result.status).toBe('failed');
    expect(result.error).toBe('provider is unavailable');
    expect(storage.listProviderCalls(result.id)).toEqual([
      expect.objectContaining({
        provider: 'unavailable-test-provider',
        status: 'failed',
        error: 'provider is unavailable',
      }),
    ]);
    expect(storage.getPatch(result.id)).toBeNull();
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
    expect(engine.getRunEvents(result.id).at(-1)?.kind).toBe('run.cancelled');
  }, 30_000);

  it('permits only one active mutation run per project', async () => {
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
    expect(blocked.status).toBe('policy_blocked');
    expect(blocked.error).toMatch(/already mutating/);
    await first.cancel('Lease test complete');
    expect((await first.result()).status).toBe('cancelled');
  }, 30_000);

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
    expect(engine.getRunEvents(result.id)[0]?.payload).toEqual({ message: 'Resuming durable run' });
  });

  it('policy-blocks missing configuration and browser availability', async () => {
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
    expect(missing.status).toBe('policy_blocked');
    expect(missing.error).toMatch(/valid .qagent.yml/);

    const browserRepository = await temporaryFixtureRepository();
    const unavailable = await createEngine(new DeterministicRepairModel(), async () => null);
    const browserProject = await unavailable.engine.addProject(browserRepository, true);
    const browserRun = await (
      await unavailable.engine.startRun({ projectId: browserProject.id, requestedBy: 'desktop' })
    ).result();
    expect(browserRun.status).toBe('policy_blocked');
    expect(browserRun.error).toMatch(/No Chrome-compatible browser/);
  });
});

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
