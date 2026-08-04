import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type {
  BootstrapSnapshot,
  Project,
  Run,
  RunEvent,
  RunLaunch,
  RunStatus,
} from '@qagent/contracts';
import { BootstrapSnapshotSchema } from '@qagent/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UtilityProcess, WebContents } from 'electron';
import {
  EngineWorkerHost,
  type EngineWorkerHostOptions,
} from '../../apps/desktop/src/worker-host.js';
import type { DesktopPreferences } from '../../apps/desktop/src/ipc.js';
import type { CredentialStore } from '../../apps/desktop/src/secure-store.js';

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/qagent' },
  utilityProcess: { fork: vi.fn() },
}));

const preferences: DesktopPreferences = {
  weaveDisclosureAccepted: false,
  weaveEnabled: false,
  browserbaseProjectId: 'desktop-project',
};
const NOW = '2026-07-23T12:00:00.000Z';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const TEST_ID = '44444444-4444-4444-8444-444444444444';

describe('EngineWorkerHost lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('single-flights startup and waits for recovery-aware readiness', async () => {
    const child = new FakeUtilityProcess();
    const { host, fork } = createHost([child]);

    const first = host.start();
    const second = host.start();
    await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(1));
    expect(fork.mock.calls[0]?.[2]?.env).toMatchObject({
      BROWSERBASE_PROJECT_ID: 'desktop-project',
      QAGENT_HOME: '/tmp/qagent-worker-host',
    });
    child.ready([]);
    await Promise.all([first, second]);

    await host.stop();
    expect(child.killCalls).toBe(1);
  });

  it('cancels a startup that is still loading when shutdown begins', async () => {
    const child = new FakeUtilityProcess();
    let releaseCredentials!: (values: Partial<Record<'openai', string>>) => void;
    const credentialsReady = new Promise<Partial<Record<'openai', string>>>((resolve) => {
      releaseCredentials = resolve;
    });
    const fork = vi.fn(() => child as unknown as UtilityProcess);
    const host = new EngineWorkerHost(
      '/tmp/qagent-worker-host',
      { values: () => credentialsReady } as unknown as CredentialStore,
      preferences,
      {
        workerPath: () => '/mock/qagent/utility-bootstrap.js',
        fork: fork as unknown as EngineWorkerHostOptions['fork'],
        startupTimeoutMs: 250,
        shutdownTimeoutMs: 50,
        exitTimeoutMs: 50,
      }
    );

    const startup = host.start();
    const shutdown = host.shutdown();
    releaseCredentials({});

    await expect(startup).rejects.toThrow('startup was stopped');
    await shutdown;
    expect(fork).not.toHaveBeenCalled();
    await expect(host.start()).rejects.toThrow('shutting down');
  });

  it('preserves bounded redacted startup diagnostics and fails every start', async () => {
    const credential = 'sk-startup-secret-123456789';
    const splitBearerToken = 'cross-chunk-secret-123456789';
    const child = new FakeUtilityProcess();
    const replacement = new FakeUtilityProcess();
    const { host, fork } = createHost([child, replacement], {
      diagnosticBytes: 512,
      credentials: { openai: credential },
    });

    const startup = host.start();
    await vi.waitFor(() => expect(child.listenerCount('message')).toBeGreaterThan(0));
    child.stderr.write(`prefix ${'x'.repeat(700)} ${credential} Bearer cross-chunk-`);
    child.stderr.write('secret-123456789 final diagnostic');
    child.failed('runtime import failed');

    await expect(startup).rejects.toThrow('runtime import failed');
    await expect(startup).rejects.not.toThrow(credential);
    await expect(startup).rejects.not.toThrow(splitBearerToken);
    await expect(startup).rejects.toThrow('[REDACTED]');
    await expect(startup).rejects.toThrow('final diagnostic');

    const retry = host.start();
    await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(2));
    replacement.ready([]);
    await retry;
    await host.stop();
  });

  it('redacts environment credentials from worker failures and renderer events', async () => {
    const credential = 'opaque-browserbase-credential-value';
    vi.stubEnv('BROWSERBASE_API_KEY', credential);
    vi.stubEnv('HTTPS_PROXY', 'https://proxy-user:proxy-password@proxy.example.test:8443');
    vi.stubEnv(
      'QAGENT_OPENAI_BASE_URL',
      'https://model-user:model-password@models.example.test/v1'
    );
    vi.stubEnv('WANDB_BASE_URL', 'https://weave-user:weave-password@api.wandb.ai');
    const child = new FakeUtilityProcess();
    const { host, fork } = createHost([child]);
    const send = vi.fn();
    host.attach({ isDestroyed: () => false, send } as unknown as WebContents);

    const startup = host.start();
    await vi.waitFor(() => expect(child.listenerCount('message')).toBeGreaterThan(0));
    child.ready([]);
    await startup;
    expect(fork.mock.calls[0]?.[2]?.env).not.toHaveProperty('HTTPS_PROXY');
    expect(fork.mock.calls[0]?.[2]?.env).not.toHaveProperty('QAGENT_OPENAI_BASE_URL');
    expect(fork.mock.calls[0]?.[2]?.env).not.toHaveProperty('WANDB_BASE_URL');
    child.emit('message', {
      type: 'run.event',
      data: commandStartedEvent(RUN_ID, credential),
    });

    expect(JSON.stringify(send.mock.calls)).not.toContain(credential);
    expect(JSON.stringify(send.mock.calls)).toContain('[REDACTED]');

    const successfulRequest = host.request({ method: 'bootstrap', params: {} });
    await vi.waitFor(() =>
      expect(child.messages.filter((message) => 'request' in message)).toHaveLength(1)
    );
    const successfulEnvelope = child.messages.find((message) => 'request' in message);
    child.emit('message', {
      id: successfulEnvelope?.id,
      ok: true,
      data: bootstrapSnapshot(credential),
    });
    const snapshot = await successfulRequest;
    const parsedSnapshot = BootstrapSnapshotSchema.parse(snapshot);
    expect(JSON.stringify(snapshot)).not.toContain(credential);
    expect(JSON.stringify(snapshot)).toContain('[REDACTED]');
    expect((snapshot as BootstrapSnapshot).tests.data?.[0]?.definition['[REDACTED]']).toBe(
      '[REDACTED]'
    );
    expect(parsedSnapshot.integrations.data?.[0]?.requirements?.[0]?.secret).toBe(true);

    const request = host.request({ method: 'bootstrap', params: {} });
    await vi.waitFor(() =>
      expect(child.messages.some((message) => 'request' in message)).toBe(true)
    );
    child.stderr.write(`diagnostic ${credential}`);
    child.failed(`worker failure included ${credential}`);
    child.crash(9);
    await expect(request).rejects.not.toThrow(credential);
    await expect(request).rejects.toThrow('[REDACTED]');
  });

  it('settles an unanswered request at its deadline', async () => {
    const child = new FakeUtilityProcess();
    const { host } = createHost([child], { requestTimeoutMs: 20 });
    const startup = host.start();
    await vi.waitFor(() => expect(child.listenerCount('message')).toBeGreaterThan(0));
    child.ready([]);
    await startup;

    await expect(host.request({ method: 'bootstrap', params: {} })).rejects.toThrow(
      'bootstrap timed out'
    );
    await host.stop();
  });

  it('restarts a ready worker after a crash and keeps recovered runs locked', async () => {
    const first = new FakeUtilityProcess();
    const second = new FakeUtilityProcess();
    const { host, fork } = createHost([first, second], { crashRestartDelayMs: 1 });
    const startup = host.start();
    await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(1));
    first.ready([]);
    await startup;

    const runId = RUN_ID;
    first.emit('message', {
      type: 'run.event',
      data: commandStartedEvent(runId),
    });
    first.crash(17);

    await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(2));
    second.ready([runId]);
    await expect(host.restart(preferences)).rejects.toThrow('run is active');

    second.emit('message', {
      type: 'run.completed',
      data: runRecord(runId, 'succeeded'),
    });
    await host.stop();
  });

  it('tracks the RunLaunch owner and permits a planned restart once it is waiting', async () => {
    const first = new FakeUtilityProcess();
    const second = new FakeUtilityProcess();
    const { host, fork } = createHost([first, second]);
    const startup = host.start();
    await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(1));
    first.ready([]);
    await startup;

    const runId = RUN_ID;
    const launchRequest = host.request({
      method: 'run.start',
      params: { projectId: PROJECT_ID },
    });
    await vi.waitFor(() =>
      expect(first.messages.some((message) => 'request' in message)).toBe(true)
    );
    const envelope = first.messages.find((message) => 'request' in message);
    first.emit('message', {
      id: envelope?.id,
      ok: true,
      data: runLaunch(runId),
    });
    await launchRequest;

    await expect(host.restart(preferences)).rejects.toThrow('run is active');

    first.emit('message', {
      type: 'run.event',
      data: interruptedEvent(runId),
    });
    first.emit('message', {
      type: 'run.updated',
      data: runRecord(runId, 'interrupted'),
    });

    const restart = host.restart(preferences);
    await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(2));
    second.ready([]);
    await restart;
    await host.stop();
  });

  it('rejects pending work, drains shutdown, and ignores a destroyed renderer', async () => {
    const child = new FakeUtilityProcess();
    const { host } = createHost([child]);
    host.attach({
      isDestroyed: () => true,
      send: () => {
        throw new Error('destroyed renderer must not receive events');
      },
    } as unknown as WebContents);
    const startup = host.start();
    await vi.waitFor(() => expect(child.listenerCount('message')).toBeGreaterThan(0));
    child.ready([]);
    await startup;

    const request = host.request({ method: 'bootstrap', params: {} });
    await vi.waitFor(() =>
      expect(child.messages.some((message) => 'request' in message)).toBe(true)
    );
    const shutdown = host.stop();
    const duplicateShutdown = host.stop();
    await expect(request).rejects.toThrow('shutting down');
    await Promise.all([shutdown, duplicateShutdown]);
    expect(child.messages.filter((message) => message.type === 'worker.shutdown')).toHaveLength(1);
    expect(child.killCalls).toBe(1);
  });

  it('rejects malformed worker responses and never forwards malformed events', async () => {
    const child = new FakeUtilityProcess();
    const { host } = createHost([child]);
    const send = vi.fn();
    host.attach({ isDestroyed: () => false, send } as unknown as WebContents);
    const startup = host.start();
    await vi.waitFor(() => expect(child.listenerCount('message')).toBeGreaterThan(0));
    child.ready([]);
    await startup;

    const request = host.request({ method: 'bootstrap', params: {} });
    await vi.waitFor(() =>
      expect(child.messages.some((message) => 'request' in message)).toBe(true)
    );
    const envelope = child.messages.find((message) => 'request' in message);
    child.emit('message', {
      id: envelope?.id,
      ok: true,
      data: { untrusted: 'not a bootstrap snapshot' },
    });
    await expect(request).rejects.toThrow('invalid response for bootstrap');

    const callsBeforeMalformedEvent = send.mock.calls.length;
    child.emit('message', {
      type: 'run.event',
      data: { runId: RUN_ID, kind: 'command.started' },
    });
    expect(send).toHaveBeenCalledTimes(callsBeforeMalformedEvent);
    await host.stop();
  });
});

function projectRecord(): Project {
  return {
    id: PROJECT_ID,
    name: 'fixture',
    path: '/tmp/project',
    trusted: true,
    configPath: '/tmp/project/.qagent.yml',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function runRecord(id: string, status: RunStatus): Run {
  const terminal = ['succeeded', 'failed', 'cancelled', 'policy_blocked'].includes(status);
  return {
    id,
    projectId: PROJECT_ID,
    status,
    stage: terminal ? 'complete' : 'test',
    requestedBy: 'desktop',
    branch: 'qagent/test',
    worktreePath: '/tmp/worktree',
    baseSha: '0123456789abcdef',
    summary: null,
    error: null,
    cancelRequestedAt: null,
    attempt: 1,
    retryOfRunId: null,
    availableActions: status === 'interrupted' ? ['resume'] : [],
    intervention: null,
    failureCode: null,
    lastHeartbeatAt: NOW,
    recoveryCount: status === 'interrupted' ? 1 : 0,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: terminal ? NOW : null,
  };
}

function runLaunch(runId: string): RunLaunch {
  return {
    run: runRecord(runId, 'running'),
    project: projectRecord(),
    isolation: {
      state: 'ready',
      canonicalProjectPath: '/tmp/project',
      worktreePath: '/tmp/worktree',
      branch: 'qagent/test',
      baseSha: '0123456789abcdef',
    },
    policyBoundary: {
      mutationMode: 'dedicated-worktree',
      activeCheckoutMutationAllowed: false,
      dirtyCheckoutPublicationAllowed: false,
      highRiskAutoMergeAllowed: false,
      originalCheckoutDirty: false,
      publishProvider: 'local',
      baseBranch: 'main',
      autoMergeRequested: false,
      publicationAllowed: true,
      autoMergeAllowed: false,
      blockedReasons: [],
    },
    commands: { test: [], verify: [], start: null },
  };
}

function commandStartedEvent(runId: string, executable = 'node'): RunEvent {
  return {
    schemaVersion: 1,
    id: EVENT_ID,
    runId,
    sequence: 1,
    stage: 'test',
    occurredAt: NOW,
    provenance: { source: 'local', capturedAt: NOW },
    artifactIds: [],
    kind: 'command.started',
    payload: { executable, args: [] },
  };
}

function interruptedEvent(runId: string): RunEvent {
  return {
    schemaVersion: 1,
    id: '55555555-5555-4555-8555-555555555555',
    runId,
    sequence: 2,
    stage: 'test',
    occurredAt: NOW,
    provenance: { source: 'local', capturedAt: NOW },
    artifactIds: [],
    kind: 'run.interrupted',
    payload: { message: 'Worker restart required', recoveryCount: 1 },
  };
}

function bootstrapSnapshot(credential: string): BootstrapSnapshot {
  const provenance = { source: 'local' as const, capturedAt: NOW };
  return {
    projects: { availability: 'ready', data: [projectRecord()], provenance },
    runs: { availability: 'ready', data: [], provenance },
    tests: {
      availability: 'ready',
      data: [
        {
          id: TEST_ID,
          projectId: PROJECT_ID,
          name: 'credential redaction',
          kind: 'command',
          definition: { [credential]: credential },
          provenance,
          createdAt: NOW,
        },
      ],
      provenance,
    },
    integrations: {
      availability: 'ready',
      data: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          provider: 'github',
          status: 'configured',
          detail: credential,
          requirements: [
            {
              id: 'github-token',
              label: 'Access token',
              state: 'configured',
              secret: true,
            },
          ],
          evidence: [],
          provenance,
          updatedAt: NOW,
        },
      ],
      provenance,
    },
  };
}

function createHost(
  children: FakeUtilityProcess[],
  input: Partial<EngineWorkerHostOptions> & {
    credentials?: Partial<Record<'openai', string>>;
  } = {}
) {
  const { credentials: values = {}, ...overrides } = input;
  const fork = vi.fn(() => {
    const child = children.shift();
    if (!child) throw new Error('No fake utility process remains');
    return child as unknown as UtilityProcess;
  });
  const credentialStore = {
    values: async () => values,
  } as unknown as CredentialStore;
  const host = new EngineWorkerHost('/tmp/qagent-worker-host', credentialStore, preferences, {
    workerPath: () => '/mock/qagent/utility-bootstrap.js',
    fork: fork as unknown as EngineWorkerHostOptions['fork'],
    startupTimeoutMs: 250,
    shutdownTimeoutMs: 50,
    exitTimeoutMs: 50,
    crashRestartDelayMs: 5,
    ...overrides,
  });
  return { host, fork };
}

class FakeUtilityProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: Array<Record<string, unknown>> = [];
  pid: number | undefined = 42_000;
  killCalls = 0;

  postMessage(message: Record<string, unknown>): void {
    this.messages.push(message);
    if (message.type === 'worker.shutdown') {
      queueMicrotask(() => {
        this.emit('message', {
          id: message.id,
          ok: true,
          data: { drained: true, activeRunIds: [] },
        });
      });
    }
  }

  kill(): boolean {
    if (this.pid === undefined) return false;
    this.killCalls += 1;
    this.pid = undefined;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }

  ready(recoveredRunIds: string[]): void {
    this.emit('message', { type: 'worker.ready', data: { recoveredRunIds } });
  }

  failed(message: string): void {
    this.emit('message', { type: 'worker.failed', data: { message } });
  }

  crash(code: number): void {
    this.pid = undefined;
    this.emit('exit', code);
  }
}
