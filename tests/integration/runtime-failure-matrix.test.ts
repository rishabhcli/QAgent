import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createModelProvider,
  detectProject,
  StagehandBrowser,
  writeProjectConfig,
  type BrowserEvidence,
  type BrowserInstallation,
  type ModelClientFactories,
  type ModelCompletion,
  type ModelProvider,
  type ModelRequest,
} from '@qagent/adapters';
import type { BrowserFlow, QAgentConfig } from '@qagent/contracts';
import { QAgentEngine } from '@qagent/core';
import { ArtifactStore, QAgentStorage } from '@qagent/storage';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DeterministicRepairModel,
  git,
  playwrightBrowserInstallation,
  temporaryDirectory,
  temporaryFixtureRepository,
} from '../helpers.js';

const openStorages = new Set<QAgentStorage>();
const openServers = new Set<Server>();
const trackedPidFiles = new Set<string>();
const terminalEventKinds = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.policy_blocked',
]);

afterEach(async () => {
  await Promise.all([...openServers].map(closeServer));
  openServers.clear();
  for (const pidFile of trackedPidFiles) await terminateTrackedProcess(pidFile);
  trackedPidFiles.clear();
  for (const storage of openStorages) storage.close();
  openStorages.clear();
});

describe('QAgentEngine real runtime failure matrix', () => {
  it('requires corrective intervention, preserves diagnostics, and reaps the exited target', async () => {
    const repository = await temporaryFixtureRepository();
    const pidDirectory = await temporaryDirectory('qagent-port-collision-pid-');
    const pidFile = join(pidDirectory, 'target.pid');
    trackedPidFiles.add(pidFile);

    const blocker = createServer((request, response) => {
      response.writeHead(request.url === '/health' ? 200 : 404);
      response.end(request.url === '/health' ? 'ok' : 'not found');
    });
    openServers.add(blocker);
    const port = await listen(blocker);

    await updateConfig(repository, (config) => {
      config.target.url = `http://127.0.0.1:${port}`;
      config.target.healthPath = '/health';
      config.target.start = {
        executable: process.execPath,
        args: [
          '-e',
          [
            'const fs = require("node:fs");',
            'const path = require("node:path");',
            'const { pathToFileURL } = require("node:url");',
            'fs.writeFileSync(process.env.QAGENT_TEST_PID_FILE, String(process.pid));',
            'console.error("qagent-port-collision-marker");',
            'setTimeout(() => {',
            'void import(pathToFileURL(path.resolve("src/server.mjs")).href);',
            '}, 750);',
          ].join(' '),
        ],
        cwd: '.',
        env: {
          PORT: String(port),
          QAGENT_TEST_PID_FILE: pidFile,
        },
        timeoutMs: 10_000,
      };
    });

    const unexpectedBrowser = new UnexpectedBrowserInvocation();
    const { engine, storage, artifactStore } = await createEngine({
      model: new DeterministicRepairModel(),
      browser: unexpectedBrowser,
      browserDetector: async () => playwrightBrowserInstallation(),
    });
    const project = await engine.addProject(repository, true);
    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'cli' })
    ).result();

    expect(result).toMatchObject({
      status: 'waiting_for_intervention',
      failureCode: 'target_startup_failure',
      availableActions: ['resolve_intervention', 'cancel'],
      intervention: {
        reason: 'target_startup_failure',
        resolutionOptions: ['policy_acknowledged'],
        requiredAction: {
          type: 'application',
          action: 'configure_project',
          label: 'Repair target health',
        },
      },
    });
    expect(result.error).toContain('Target process exited before readiness');
    const browserLog = storage
      .listArtifacts(result.id)
      .find((artifact) => artifact.name === 'test-browser-error.log');
    expect(browserLog).toBeDefined();
    const diagnostics = (await artifactStore.read(browserLog!)).toString('utf8');
    expect(diagnostics).toContain('Startup diagnostics:');
    expect(diagnostics).toContain('qagent-port-collision-marker');
    expect(diagnostics).toContain('EADDRINUSE');
    expect(JSON.stringify(engine.getRunEvents(result.id))).toContain(
      'qagent-port-collision-marker'
    );
    expect(
      engine.getRunEvents(result.id).some((event) => event.kind === 'target.service_failed')
    ).toBe(true);
    const eventKinds = engine.getRunEvents(result.id).map((event) => event.kind);
    expect(eventKinds).not.toContain('target.service_ready');
    expect(eventKinds).not.toContain('browser.session_started');
    expect(eventKinds).not.toContain('model.call_started');
    expect(eventKinds).toContain('target.service_exited');
    expect(eventKinds.indexOf('target.service_failed')).toBeLessThan(
      eventKinds.indexOf('target.service_exited')
    );
    expect(storage.listProviderCalls(result.id)).toHaveLength(0);
    expect(unexpectedBrowser.calls).toBe(0);

    const targetPid = await readPid(pidFile);
    await expectProcessGone(targetPid);
    expect(
      engine
        .getRunEvents(result.id)
        .filter((event) =>
          ['run.completed', 'run.failed', 'run.cancelled', 'run.policy_blocked'].includes(
            event.kind
          )
        )
    ).toHaveLength(0);
  }, 30_000);

  it('requires corrective intervention when a real provider adapter rejects malformed output', async () => {
    const repository = await temporaryFixtureRepository();
    await updateConfig(repository, (config) => {
      config.test.browserFlows = [];
    });

    const factories: ModelClientFactories = {
      openai: () => ({
        responses: {
          create: async () => ({
            output_text: 'definitely not JSON',
            usage: { input_tokens: 7, output_tokens: 4 },
          }),
        },
        chat: {
          completions: {
            create: async () => ({
              choices: [{ message: { content: 'definitely not JSON' } }],
              usage: { prompt_tokens: 7, completion_tokens: 4 },
            }),
          },
        },
      }),
      anthropic: () => {
        throw new Error('Anthropic factory was not expected');
      },
      google: () => {
        throw new Error('Google factory was not expected');
      },
    };
    const { engine, storage } = await createEngine({
      modelProviderFactory: (config) =>
        createModelProvider(config, { openai: 'test-only-key' }, factories),
    });
    const project = await engine.addProject(repository, true);
    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'mcp' })
    ).result();

    expect(result).toMatchObject({
      status: 'waiting_for_intervention',
      failureCode: 'invalid_model_output',
      availableActions: ['resolve_intervention', 'cancel'],
      intervention: {
        reason: 'invalid_model_output',
        resolutionOptions: ['provider_reconfigured'],
        requiredAction: {
          type: 'application',
          action: 'configure_provider',
          label: 'Repair model output',
        },
      },
    });
    expect(result.intervention?.evidenceArtifactIds.length).toBeGreaterThan(0);
    expect(result.error).toContain('returned invalid structured output');
    expect(storage.listProviderCalls(result.id)).toEqual([
      expect.objectContaining({
        provider: 'openai',
        purpose: 'triage',
        status: 'failed',
        error: expect.stringContaining('Model response did not contain JSON'),
      }),
    ]);
    expect(storage.getDiagnosis(result.id)).toBeNull();
    expect(storage.getPatch(result.id)).toBeNull();
    expect(
      engine
        .getRunEvents(result.id)
        .filter((event) =>
          ['run.completed', 'run.failed', 'run.cancelled', 'run.policy_blocked'].includes(
            event.kind
          )
        )
    ).toHaveLength(0);
  });

  it('settles after a real local Chromium navigation timeout and stops the target', async () => {
    const repository = await temporaryFixtureRepository();
    const pidDirectory = await temporaryDirectory('qagent-browser-timeout-pid-');
    const pidFile = join(pidDirectory, 'target.pid');
    trackedPidFiles.add(pidFile);
    const port = await availablePort();
    const timeoutBrowser = new LocalNavigationTimeoutBrowser(250);

    await updateConfig(repository, (config) => {
      config.target.url = `http://127.0.0.1:${port}`;
      config.target.healthPath = '/health';
      config.target.start = {
        executable: process.execPath,
        args: [
          '-e',
          [
            'const fs = require("node:fs");',
            'const http = require("node:http");',
            'fs.writeFileSync(process.env.QAGENT_TEST_PID_FILE, String(process.pid));',
            'const server = http.createServer((request, response) => {',
            'if (request.url === "/health") {',
            'response.writeHead(200); response.end("ok");',
            '}',
            '});',
            'server.listen(Number(process.env.PORT), "127.0.0.1", () =>',
            'console.log("qagent-timeout-target-ready"));',
          ].join(' '),
        ],
        cwd: '.',
        env: {
          PORT: String(port),
          QAGENT_TEST_PID_FILE: pidFile,
        },
        timeoutMs: 20_000,
      };
      config.limits.maxIterations = 1;
    });

    const model = new ExhaustingRepairModel();
    const { engine, storage, artifactStore } = await createEngine({
      model,
      browser: timeoutBrowser,
      browserDetector: async () => playwrightBrowserInstallation(),
    });
    const project = await engine.addProject(repository, true);
    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'desktop' })
    ).result();

    expect(result.status).toBe('failed');
    expect(result.error).toContain('No verified repair was found after 1 attempts');
    expect(timeoutBrowser.launches).toBe(1);
    expect(timeoutBrowser.closes).toBe(1);
    const browserLog = storage
      .listArtifacts(result.id)
      .find((artifact) => artifact.name === 'test-browser-error.log');
    expect(browserLog).toBeDefined();
    const browserFailure = (await artifactStore.read(browserLog!)).toString('utf8');
    expect(browserFailure).toMatch(/page\.goto.*Timeout 250ms/is);
    expect(
      engine.getRunEvents(result.id).some((event) => event.kind === 'target.service_ready')
    ).toBe(true);
    expect(
      engine.getRunEvents(result.id).some((event) => event.kind === 'target.service_exited')
    ).toBe(true);

    const targetPid = await readPid(pidFile);
    await expectProcessGone(targetPid);
    assertSingleTerminalSettlement(engine, result.id, 'run.failed');
  }, 30_000);

  it('executes exactly the configured maximum repair iterations before settling', async () => {
    const repository = await temporaryFixtureRepository();
    await updateConfig(repository, (config) => {
      config.test.browserFlows = [];
      config.limits.maxIterations = 2;
    });
    const model = new ExhaustingRepairModel();
    const { engine, storage } = await createEngine({ model });
    const project = await engine.addProject(repository, true);
    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'cli' })
    ).result();

    expect(result.status).toBe('failed');
    expect(result.error).toContain('No verified repair was found after 2 attempts');
    expect(model.calls.map((request) => request.purpose)).toEqual(['triage', 'patch', 'patch']);
    expect(model.calls[2]?.prompt).toContain('Patch validation failed:');
    expect(storage.listProviderCalls(result.id).map((call) => call.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    expect(storage.listDiagnoses(result.id)).toHaveLength(1);
    expect(storage.listPatches(result.id)).toHaveLength(2);
    expect(storage.listPatches(result.id).every((patch) => !patch.applied)).toBe(true);
    expect(await git(result.worktreePath!, ['status', '--porcelain'])).toBe('');
    assertSingleTerminalSettlement(engine, result.id, 'run.failed');
  });

  it('aborts before patch mutation when lease renewal is rejected', async () => {
    const repository = await temporaryFixtureRepository();
    await updateConfig(repository, (config) => {
      config.test.browserFlows = [];
    });
    const { engine, storage } = await createEngine({
      model: new DeterministicRepairModel(),
      storageFactory: (databasePath) => new RejectSecondRenewalStorage(databasePath),
    });
    const leaseStorage = storage as RejectSecondRenewalStorage;
    const project = await engine.addProject(repository, true);
    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'desktop' })
    ).result();

    expect(result).toMatchObject({
      status: 'interrupted',
      failureCode: 'interrupted_recovery',
      availableActions: ['resume', 'cancel'],
      recoveryCount: 1,
    });
    expect(result.error).toContain('project mutation lease was lost');
    expect(leaseStorage.renewalAttempts).toBe(2);
    expect(storage.listProviderCalls(result.id).map((call) => call.purpose)).toEqual([
      'triage',
      'patch',
    ]);
    expect(storage.listPatches(result.id)).toEqual([
      expect.objectContaining({ applied: false, files: [] }),
    ]);
    expect(storage.getRunCheckpoint(result.id)?.kind).toBe('worktree_created');
    expect(await git(result.worktreePath!, ['status', '--porcelain'])).toBe('');
    expect(storage.acquireLease(project.id, result.id)).toBe(true);
    storage.releaseLease(project.id, result.id);
    expect(
      engine
        .getRunEvents(result.id)
        .filter((event) =>
          ['run.completed', 'run.failed', 'run.cancelled', 'run.policy_blocked'].includes(
            event.kind
          )
        )
    ).toHaveLength(0);
  });
});

class ExhaustingRepairModel implements ModelProvider {
  readonly provider = 'test';
  readonly model = 'bounded-exhaustion';
  readonly calls: ModelRequest<unknown>[] = [];

  async complete<T>(request: ModelRequest<T>): Promise<ModelCompletion<T>> {
    this.calls.push(request as ModelRequest<unknown>);
    const value =
      request.purpose === 'triage'
        ? {
            summary: 'Counter check still fails',
            rootCause: 'The fixture intentionally increments by two.',
            confidence: 1,
          }
        : {
            summary: 'A deliberately rejected test patch',
            unifiedDiff:
              'diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-A=1\n+A=2\n',
          };
    return {
      value: request.schema.parse(value),
      inputTokens: 3,
      outputTokens: 2,
    };
  }
}

class LocalNavigationTimeoutBrowser extends StagehandBrowser {
  launches = 0;
  closes = 0;

  constructor(private readonly navigationTimeoutMs: number) {
    super();
  }

  override async runFlows(options: {
    config: QAgentConfig;
    browser?: BrowserInstallation;
    targetUrl: string;
    flows: BrowserFlow[];
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<BrowserEvidence[]> {
    options.signal?.throwIfAborted();
    if (!options.browser) throw new Error('Local browser installation was not provided');
    this.launches += 1;
    const browser = await chromium.launch({
      executablePath: options.browser.executablePath,
      headless: true,
    });
    try {
      const page = await browser.newPage();
      await page.goto(new URL('/never', options.targetUrl).toString(), {
        waitUntil: 'load',
        timeout: this.navigationTimeoutMs,
      });
      throw new Error('The non-responsive browser route unexpectedly completed');
    } finally {
      await browser.close();
      this.closes += 1;
    }
  }
}

class UnexpectedBrowserInvocation extends StagehandBrowser {
  calls = 0;

  override async runFlows(): Promise<never> {
    this.calls += 1;
    throw new Error('Browser verification ran before target startup settled');
  }
}

class RejectSecondRenewalStorage extends QAgentStorage {
  renewalAttempts = 0;

  override renewLease(
    projectId: string,
    runId: string,
    ttlMs = 60_000,
    ownerPid = process.pid
  ): boolean {
    this.renewalAttempts += 1;
    if (this.renewalAttempts === 2) return false;
    return super.renewLease(projectId, runId, ttlMs, ownerPid);
  }
}

type EngineOptions = ConstructorParameters<typeof QAgentEngine>[0];

async function createEngine(options: {
  model?: ModelProvider;
  modelProviderFactory?: EngineOptions['modelProviderFactory'];
  browser?: StagehandBrowser;
  browserDetector?: EngineOptions['browserDetector'];
  storageFactory?: (databasePath: string) => QAgentStorage;
}) {
  const home = await temporaryDirectory('qagent-runtime-matrix-');
  const storage =
    options.storageFactory?.(join(home, 'qagent.sqlite')) ??
    new QAgentStorage(join(home, 'qagent.sqlite'));
  openStorages.add(storage);
  const artifactStore = new ArtifactStore(join(home, 'artifacts'), storage);
  const model = options.model ?? new DeterministicRepairModel();
  return {
    storage,
    artifactStore,
    engine: new QAgentEngine({
      storage,
      artifactStore,
      qagentHome: home,
      browser: options.browser,
      browserDetector: options.browserDetector ?? (async () => null),
      modelProviderFactory: options.modelProviderFactory ?? (() => model),
    }),
  };
}

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
    'configure runtime failure matrix',
  ]);
}

function assertSingleTerminalSettlement(
  engine: QAgentEngine,
  runId: string,
  expectedKind: string
): void {
  const run = engine.getRun(runId);
  const events = engine.getRunEvents(runId);
  expect(
    events.filter((event) => terminalEventKinds.has(event.kind)).map((event) => event.kind)
  ).toEqual([expectedKind]);
  expect(events.filter((event) => event.kind === 'terminal.evidence')).toHaveLength(1);
  expect(run?.completedAt).not.toBeNull();
  expect(['queued', 'running', 'waiting_for_intervention', 'interrupted']).not.toContain(
    run?.status
  );
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not expose a TCP port');
  return address.port;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pid = Number.parseInt(await readFile(path, 'utf8'), 10);
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {
      // The child writes the PID immediately after spawn; allow the filesystem event to settle.
    }
    await delay(20);
  }
  throw new Error(`Target process did not write a PID to ${path}`);
}

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processAlive(pid)) return;
    await delay(20);
  }
  throw new Error(`Target process ${pid} remained alive after terminal settlement`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function terminateTrackedProcess(pidFile: string): Promise<void> {
  try {
    const pid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
    if (Number.isSafeInteger(pid) && pid > 0 && processAlive(pid)) {
      process.kill(pid, 'SIGKILL');
      await expectProcessGone(pid);
    }
  } catch {
    // Best-effort cleanup for tests that fail before the target writes its PID.
  }
}
