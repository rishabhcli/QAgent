import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { redactForTelemetry } from '@qagent/adapters';
import type { RunStatus } from '@qagent/contracts';
import { app, type UtilityProcess, utilityProcess, type WebContents } from 'electron';
import {
  parseWorkerResponseData,
  type DesktopPreferences,
  type WorkerEventMessage,
  type WorkerRequest,
  WorkerEventMessageSchema,
  WorkerResponseSchema,
} from './ipc.js';
import type { CredentialProvider, CredentialStore } from './secure-store.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  child: UtilityProcess;
  method: string;
  timer: NodeJS.Timeout;
}

interface PendingStart {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface EngineWorkerHostOptions {
  fork?: typeof utilityProcess.fork;
  workerPath?: () => string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  browserInstallTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  exitTimeoutMs?: number;
  crashRestartDelayMs?: number;
  diagnosticBytes?: number;
}

const ENV_NAMES: Record<CredentialProvider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  github: 'GITHUB_TOKEN',
  weave: 'WANDB_API_KEY',
  browserbase: 'BROWSERBASE_API_KEY',
};

const RUNTIME_ENVIRONMENT_NAMES = [
  'APPDATA',
  'BROWSERBASE_PROJECT_ID',
  'CI',
  'COMSPEC',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'OLLAMA_HOST',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'QAGENT_BROWSER_PATH',
  'QAGENT_DEBUG_STARTUP',
  'QAGENT_E2E',
  'QAGENT_GITHUB_API_URL',
  'QAGENT_OPENAI_BASE_URL',
  'QAGENT_OPENAI_MODEL',
  'SHELL',
  'SSH_AUTH_SOCK',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'WANDB_BASE_URL',
  'WAYLAND_DISPLAY',
  'WEAVE_PROJECT',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
] as const;

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_BROWSER_INSTALL_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 7_000;
const SHUTDOWN_ACK_PADDING_MS = 500;
const DEFAULT_EXIT_TIMEOUT_MS = 2_000;
const DEFAULT_CRASH_RESTART_DELAY_MS = 250;
const DEFAULT_DIAGNOSTIC_BYTES = 32 * 1024;
const DIAGNOSTIC_REDACTION_LOOKBEHIND_BYTES = 20 * 1024;

export class EngineWorkerHost {
  private child: UtilityProcess | null = null;
  private readyChild: UtilityProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingStarts = new WeakMap<UtilityProcess, PendingStart>();
  private readonly activeRuns = new Map<string, UtilityProcess>();
  private readonly quiescentRuns = new Set<string>();
  private readonly recoveringRuns = new Set<string>();
  private readonly terminalRuns = new WeakMap<UtilityProcess, Set<string>>();
  private readonly diagnostics = new WeakMap<UtilityProcess, BoundedDiagnosticBuffer>();
  private readonly workerSecrets = new WeakMap<UtilityProcess, string[]>();
  private readonly plannedStops = new WeakSet<UtilityProcess>();
  private webContents: WebContents | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private desiredRunning = false;
  private shutdownRequested = false;

  constructor(
    private readonly home: string,
    private readonly credentials: CredentialStore,
    private preferences: DesktopPreferences,
    private readonly options: EngineWorkerHostOptions = {}
  ) {}

  attach(webContents: WebContents): void {
    this.webContents = webContents;
  }

  async start(): Promise<void> {
    if (this.shutdownRequested) {
      throw new Error('QAgent engine worker is shutting down');
    }
    if (this.stopPromise) await this.stopPromise;
    if (this.shutdownRequested) {
      throw new Error('QAgent engine worker is shutting down');
    }
    this.desiredRunning = true;
    if (this.child && this.readyChild === this.child) return;
    if (this.startPromise) return this.startPromise;
    const startup = this.launchWorker();
    this.startPromise = startup;
    try {
      await startup;
    } finally {
      if (this.startPromise === startup) this.startPromise = null;
    }
  }

  private async launchWorker(): Promise<void> {
    if (process.env.QAGENT_DEBUG_STARTUP === 'true') {
      process.stderr.write('[qagent] starting engine utility process\n');
    }
    const values = await this.credentials.values();
    if (!this.desiredRunning) throw new Error('QAgent engine worker startup was stopped');
    const env = workerEnvironment(process.env);
    env.QAGENT_HOME = this.home;
    for (const name of Object.values(ENV_NAMES)) {
      if (process.env[name]) env[name] = process.env[name];
    }
    for (const [provider, value] of Object.entries(values)) {
      if (value) env[ENV_NAMES[provider as CredentialProvider]] = value;
    }
    env.QAGENT_WEAVE_DISCLOSURE_ACCEPTED = String(this.preferences.weaveDisclosureAccepted);
    env.QAGENT_WEAVE_ENABLED = String(this.preferences.weaveEnabled);
    if (this.preferences.browserbaseProjectId) {
      env.BROWSERBASE_PROJECT_ID = this.preferences.browserbaseProjectId;
    }
    const workerSecrets = [
      ...new Set(
        Object.values(ENV_NAMES)
          .map((name) => env[name])
          .filter((value): value is string => Boolean(value))
      ),
    ];
    const workerPath =
      this.options.workerPath?.() ?? join(app.getAppPath(), 'dist', 'utility-bootstrap.js');
    const fork = this.options.fork ?? utilityProcess.fork;
    const child = fork(workerPath, [], {
      serviceName: 'QAgent Engine',
      env,
      stdio: 'pipe',
    });
    this.child = child;
    this.terminalRuns.set(child, new Set());
    this.workerSecrets.set(child, workerSecrets);
    this.diagnostics.set(
      child,
      new BoundedDiagnosticBuffer(
        this.options.diagnosticBytes ?? DEFAULT_DIAGNOSTIC_BYTES,
        workerSecrets
      )
    );
    const ready = this.waitForReady(child);
    this.listenToChild(child);
    if (process.env.QAGENT_DEBUG_STARTUP === 'true') {
      process.stderr.write('[qagent] engine utility process forked\n');
    }
    try {
      await ready;
    } catch (error) {
      this.plannedStops.add(child);
      await this.terminateChild(child);
      if (this.child === child) this.child = null;
      if (this.readyChild === child) this.readyChild = null;
      throw error;
    }
  }

  private listenToChild(child: UtilityProcess): void {
    child.on('message', (message: unknown) => {
      this.handleMessage(child, message);
    });
    child.on('error', (type, location, report) => {
      const detail = `${type} at ${location}\n${report}`;
      this.diagnostics.get(child)?.append(detail);
      const error = this.workerError(child, 'QAgent engine worker encountered a fatal error');
      this.rejectStart(child, error);
      this.safeSend({ type: 'worker.failed', data: { message: error.message } }, child);
    });
    child.on('exit', (code) => this.handleExit(child, code));
    child.stdout?.on('data', (data: Buffer | string) => {
      this.diagnostics.get(child)?.append(data);
    });
    child.stderr?.on('data', (data: Buffer | string) => {
      this.diagnostics.get(child)?.append(data);
    });
  }

  private handleMessage(child: UtilityProcess, message: unknown): void {
    if (!message || typeof message !== 'object') return;
    if ('type' in message) {
      const event = WorkerEventMessageSchema.safeParse(message);
      if (!event.success) {
        this.diagnostics
          .get(child)
          ?.append('QAgent engine worker emitted an invalid event message');
        return;
      }
      if (event.data.type === 'worker.ready') {
        this.handleReady(child, event.data);
      } else if (event.data.type === 'worker.failed') {
        const error = this.workerError(child, event.data.data.message);
        this.rejectStart(child, error);
        this.safeSend({ type: event.data.type, data: { message: error.message } }, child);
      } else {
        this.trackRunEvent(child, event.data);
        this.safeSend(event.data, child);
      }
      return;
    }
    const response = WorkerResponseSchema.safeParse(message);
    if (!response.success) {
      this.diagnostics
        .get(child)
        ?.append('QAgent engine worker emitted an invalid response message');
      return;
    }
    const pending = this.pending.get(response.data.id);
    if (!pending || pending.child !== child) return;
    this.pending.delete(response.data.id);
    clearTimeout(pending.timer);
    if (response.data.ok) {
      let data: unknown;
      try {
        data = parseWorkerResponseData(pending.method, response.data.data);
      } catch {
        pending.reject(
          this.workerError(
            child,
            `QAgent engine worker returned an invalid response for ${pending.method}`
          )
        );
        return;
      }
      if (pending.method === 'run.start') {
        const run = (data as { run: { id: string; status: RunStatus } }).run;
        if (run.status === 'queued' || run.status === 'running') {
          this.activeRuns.set(run.id, child);
          this.quiescentRuns.delete(run.id);
        } else if (run.status === 'waiting_for_intervention' || run.status === 'interrupted') {
          this.quiescentRuns.add(run.id);
        }
      }
      pending.resolve(redactWorkerValue(data, this.workerSecrets.get(child) ?? []));
    } else {
      pending.reject(this.workerError(child, response.data.error));
    }
  }

  private handleReady(
    child: UtilityProcess,
    message: Extract<WorkerEventMessage, { type: 'worker.ready' }>
  ): void {
    if (this.child !== child) return;
    this.readyChild = child;
    const terminal = this.terminalRuns.get(child) ?? new Set<string>();
    this.recoveringRuns.clear();
    for (const runId of message.data.recoveredRunIds) {
      if (!terminal.has(runId)) this.activeRuns.set(runId, child);
    }
    const pending = this.pendingStarts.get(child);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingStarts.delete(child);
      pending.resolve();
    }
    this.safeSend(message, child);
  }

  private trackRunEvent(child: UtilityProcess, message: WorkerEventMessage): void {
    if (message.type === 'run.event') {
      if (isTerminalRunEvent(message.data.kind)) {
        this.markRunTerminal(child, message.data.runId);
      } else if (isQuiescentRunEvent(message.data.kind)) {
        if (this.activeRuns.get(message.data.runId) === child) {
          this.activeRuns.delete(message.data.runId);
        }
        this.quiescentRuns.add(message.data.runId);
      } else {
        this.quiescentRuns.delete(message.data.runId);
        this.activeRuns.set(message.data.runId, child);
      }
    }
    if (message.type === 'run.completed') {
      if (isTerminalRunStatus(message.data.status)) {
        this.markRunTerminal(child, message.data.id);
      }
    }
    if (message.type === 'run.updated') {
      if (
        message.data.status === 'waiting_for_intervention' ||
        message.data.status === 'interrupted'
      ) {
        if (this.activeRuns.get(message.data.id) === child) {
          this.activeRuns.delete(message.data.id);
        }
        this.quiescentRuns.add(message.data.id);
      }
    }
  }

  private markRunTerminal(child: UtilityProcess, runId: string): void {
    this.terminalRuns.get(child)?.add(runId);
    if (this.activeRuns.get(runId) === child) this.activeRuns.delete(runId);
    this.quiescentRuns.delete(runId);
    this.recoveringRuns.delete(runId);
  }

  private handleExit(child: UtilityProcess, code: number): void {
    const wasReady = this.readyChild === child;
    const wasCurrent = this.child === child;
    const planned = this.plannedStops.has(child);
    const error = this.workerError(child, `QAgent engine worker exited with code ${code}`);
    this.rejectStart(child, error);
    for (const [id, request] of this.pending) {
      if (request.child !== child) continue;
      clearTimeout(request.timer);
      request.reject(error);
      this.pending.delete(id);
    }
    for (const [runId, owner] of this.activeRuns) {
      if (owner !== child) continue;
      this.activeRuns.delete(runId);
      this.recoveringRuns.add(runId);
    }
    if (this.readyChild === child) this.readyChild = null;
    if (this.child === child) this.child = null;
    if (!planned && wasReady) {
      this.safeSend(
        {
          type: 'worker.failed',
          data: { message: error.message, recoveringRunIds: [...this.recoveringRuns] },
        },
        child
      );
    }
    if (!planned && wasReady && wasCurrent && this.desiredRunning) {
      this.scheduleCrashRestart();
    }
  }

  private waitForReady(child: UtilityProcess): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingStarts.delete(child);
        reject(this.workerError(child, 'QAgent engine worker readiness timed out'));
      }, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
      timer.unref();
      this.pendingStarts.set(child, { resolve, reject, timer });
    });
  }

  private rejectStart(child: UtilityProcess, error: Error): void {
    const pending = this.pendingStarts.get(child);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingStarts.delete(child);
    pending.reject(error);
  }

  private scheduleCrashRestart(): void {
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.desiredRunning || this.child) return;
      void this.start().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.safeSend({ type: 'worker.failed', data: { message } });
      });
    }, this.options.crashRestartDelayMs ?? DEFAULT_CRASH_RESTART_DELAY_MS);
    this.restartTimer.unref();
  }

  async restart(preferences = this.preferences): Promise<void> {
    if (this.shutdownRequested) {
      throw new Error('QAgent engine worker is shutting down');
    }
    if (this.activeRuns.size > 0 || this.recoveringRuns.size > 0) {
      throw new Error('Runtime settings cannot change while a QAgent run is active');
    }
    const previous = this.preferences;
    await this.stop();
    this.preferences = preferences;
    try {
      await this.start();
    } catch (error) {
      this.preferences = previous;
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    await this.stop();
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const stopping = this.stopWorker();
    this.stopPromise = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopPromise === stopping) this.stopPromise = null;
    }
  }

  private async stopWorker(): Promise<void> {
    this.desiredRunning = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const startup = this.startPromise;
    let child = this.child;
    if (!child && startup) {
      await settlesWithin(
        startup.catch(() => undefined),
        this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
      );
      child = this.child;
    }
    if (!child) return;
    this.plannedStops.add(child);
    const shutdownId = randomUUID();
    const shutdown = this.postToChild(
      child,
      shutdownId,
      { id: shutdownId, type: 'worker.shutdown', graceMs: this.shutdownTimeoutMs },
      'worker.shutdown',
      this.shutdownTimeoutMs + SHUTDOWN_ACK_PADDING_MS
    );
    for (const [id, request] of this.pending) {
      if (request.child !== child || id === shutdownId) continue;
      clearTimeout(request.timer);
      this.pending.delete(id);
      request.reject(new Error('QAgent engine worker is shutting down'));
    }
    await shutdown.catch(() => undefined);
    await this.terminateChild(child);
    if (this.child === child) this.child = null;
    if (this.readyChild === child) this.readyChild = null;
  }

  async request(request: WorkerRequest): Promise<unknown> {
    await this.start();
    if (!this.child || this.readyChild !== this.child) {
      throw new Error('Engine worker is unavailable');
    }
    const id = randomUUID();
    const timeoutMs =
      request.method === 'browser.install'
        ? (this.options.browserInstallTimeoutMs ?? DEFAULT_BROWSER_INSTALL_TIMEOUT_MS)
        : (this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    return this.postToChild(this.child, id, { id, request }, request.method, timeoutMs);
  }

  private postToChild(
    child: UtilityProcess,
    id: string,
    envelope: unknown,
    method: string,
    timeoutMs: number
  ): Promise<unknown> {
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending || pending.child !== child) return;
        this.pending.delete(id);
        reject(this.workerError(child, `Engine request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, child, method, timer });
    });
    try {
      child.postMessage(envelope);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(
          this.workerError(
            child,
            error instanceof Error ? error.message : `Engine request ${method} could not be sent`
          )
        );
      }
    }
    return promise;
  }

  private async terminateChild(child: UtilityProcess): Promise<void> {
    const pid = child.pid;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    if (await settlesWithin(exited, this.exitTimeoutMs)) return;
    if (pid === undefined) return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      return;
    }
    await settlesWithin(exited, this.exitTimeoutMs);
  }

  private safeSend(message: WorkerEventMessage, child?: UtilityProcess): void {
    const target = this.webContents;
    if (!target || target.isDestroyed()) return;
    try {
      target.send(
        'qagent:event',
        redactWorkerValue(message, child ? (this.workerSecrets.get(child) ?? []) : [])
      );
    } catch {
      // Durable events remain available from SQLite after a renderer interruption.
    }
  }

  private workerError(child: UtilityProcess, message: string): Error {
    const buffer = this.diagnostics.get(child);
    const safeMessage = buffer?.redact(message) ?? String(redactForTelemetry(message));
    const diagnostics = buffer?.value();
    return new Error(
      diagnostics ? `${safeMessage}\n\nWorker diagnostics:\n${diagnostics}` : safeMessage
    );
  }

  private get shutdownTimeoutMs(): number {
    return this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  private get exitTimeoutMs(): number {
    return this.options.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS;
  }
}

class BoundedDiagnosticBuffer {
  private rawContents = '';

  constructor(
    private readonly maxBytes: number,
    private readonly secrets: string[]
  ) {}

  append(value: Buffer | string): void {
    const incoming = Buffer.isBuffer(value) ? value.toString('utf8') : value;
    const combined = Buffer.from(this.rawContents + incoming);
    const rawLimit = this.maxBytes + DIAGNOSTIC_REDACTION_LOOKBEHIND_BYTES;
    this.rawContents =
      combined.byteLength <= rawLimit
        ? combined.toString('utf8')
        : combined.subarray(combined.byteLength - rawLimit).toString('utf8');
  }

  value(): string {
    const text = this.redact(this.rawContents);
    const redacted = Buffer.from(text);
    return (
      redacted.byteLength <= this.maxBytes
        ? redacted.toString('utf8')
        : redacted.subarray(redacted.byteLength - this.maxBytes).toString('utf8')
    ).trim();
  }

  redact(value: string): string {
    let text = String(redactForTelemetry(value));
    for (const secret of this.secrets) {
      text = text.replaceAll(secret, '[REDACTED]');
    }
    return text;
  }
}

function isTerminalRunEvent(kind: unknown): boolean {
  return (
    kind === 'run.completed' ||
    kind === 'run.failed' ||
    kind === 'run.cancelled' ||
    kind === 'run.policy_blocked'
  );
}

function isQuiescentRunEvent(kind: unknown): boolean {
  return kind === 'intervention.required' || kind === 'run.interrupted';
}

function isTerminalRunStatus(status: unknown): status is RunStatus {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'policy_blocked'
  );
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function workerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    RUNTIME_ENVIRONMENT_NAMES.flatMap((name) => {
      const value = source[name];
      return value === undefined || hasEmbeddedUrlCredentials(value) ? [] : [[name, value]];
    })
  );
}

function hasEmbeddedUrlCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

function redactWorkerValue(value: unknown, secrets: string[]): unknown {
  return replaceWorkerSecrets(redactForTelemetry(value), secrets);
}

function replaceWorkerSecrets(value: unknown, secrets: string[]): unknown {
  const replace = (text: string): string =>
    secrets.reduce((current, secret) => current.replaceAll(secret, '[REDACTED]'), text);
  const redacted = value;
  if (typeof redacted === 'string') {
    return replace(redacted);
  }
  if (Array.isArray(redacted)) {
    return redacted.map((item) => replaceWorkerSecrets(item, secrets));
  }
  if (redacted && typeof redacted === 'object') {
    return Object.fromEntries(
      Object.entries(redacted).map(([key, child]) => [
        replace(key),
        replaceWorkerSecrets(child, secrets),
      ])
    );
  }
  return redacted;
}
