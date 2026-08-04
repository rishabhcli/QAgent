import { realpath } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { CommandSpec } from '@qagent/contracts';
import { execa } from 'execa';
import { assertPathContained } from './paths.js';

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_STREAM_BYTES = 256 * 1024;
const DEFAULT_MAX_CHUNK_CHARACTERS = 16 * 1024;
const DEFAULT_STOP_GRACE_MS = 2_000;
const DEFAULT_STOP_KILL_WAIT_MS = 2_000;
const REDACTION_GUARD_CHARACTERS = 1_024;
const OUTPUT_TRUNCATION_MARKER = Buffer.from('\n[... output truncated ...]\n');
const SECRET_KEY =
  /(access[-_]?key|api[-_]?key|token|secret|password|authorization|cookie|credential|private[-_]?key)/i;
const SENSITIVE_ENVIRONMENT_URL = /^(database_url|mongodb_uri|mysql_url|postgres_url|redis_url)$/i;
const SECRET_PATTERNS = [
  /bearer\s+[a-z0-9._~+/-]{8,512}/gi,
  /sk-[a-z0-9_-]{12,512}/gi,
  /gh[pousr]_[a-z0-9_]{12,512}/gi,
  /(?:api[-_]?key|token|secret|password|authorization|cookie|credential)\s*[=:]\s*[^\s'"]{4,512}/gi,
  /https?:\/\/[^/\s:@]+:[^@\s/]+@/gi,
];

export function commandEnvironment(
  inherited: NodeJS.ProcessEnv,
  explicit: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const safeInherited = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key, value]) =>
        value !== undefined &&
        !SECRET_KEY.test(key) &&
        !SENSITIVE_ENVIRONMENT_URL.test(key) &&
        key !== 'SSH_AUTH_SOCK' &&
        !hasEmbeddedUrlCredentials(value)
    )
  );
  return { ...safeInherited, ...explicit };
}

function hasEmbeddedUrlCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

export type ProcessOutputStream = 'stdout' | 'stderr';

export interface ProcessOutputChunk {
  stream: ProcessOutputStream;
  text: string;
  sequence: number;
  truncated: boolean;
  droppedBytes: number;
}

export interface ProcessOutputSnapshot {
  stdout: string;
  stderr: string;
  combined: string;
  truncated: boolean;
  droppedBytes: {
    stdout: number;
    stderr: number;
    combined: number;
    streamed: number;
  };
}

export interface ProcessExecutionOptions {
  input?: string;
  maxOutputBytes?: number;
  maxStreamBytes?: number;
  maxChunkCharacters?: number;
  stopGraceMs?: number;
  stopKillWaitMs?: number;
  redactValues?: string[];
  onOutput?: (chunk: ProcessOutputChunk) => void;
}

export interface ProcessRunnerOptions extends Omit<ProcessExecutionOptions, 'input' | 'onOutput'> {
  onOutput?: (chunk: ProcessOutputChunk) => void;
}

interface ResolvedProcessOptions {
  input?: string;
  maxOutputBytes: number;
  maxStreamBytes: number;
  maxChunkCharacters: number;
  stopGraceMs: number;
  stopKillWaitMs: number;
  redactValues: string[];
  onOutput?: (chunk: ProcessOutputChunk) => void;
}

export interface CommandResult extends ProcessOutputSnapshot {
  executable: string;
  args: string[];
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  terminated: boolean;
  signal: string | null;
}

export interface ManagedProcess {
  pid: number | null;
  result: Promise<CommandResult>;
  snapshot: () => ProcessOutputSnapshot;
  stop: () => Promise<void>;
}

interface ProcessOutcome {
  exitCode?: number;
  timedOut?: boolean;
  isCanceled?: boolean;
  isTerminated?: boolean;
  signal?: string;
}

interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export class ProcessRunner {
  constructor(private readonly defaults: ProcessRunnerOptions = {}) {}

  async run(
    root: string,
    spec: CommandSpec,
    signal?: AbortSignal,
    options: ProcessExecutionOptions = {}
  ): Promise<CommandResult> {
    signal?.throwIfAborted();
    const execution = await this.spawn(root, spec, signal, options);
    const result = await execution.result;
    if (signal?.aborted) throw signal.reason;
    return result;
  }

  async start(
    root: string,
    spec: CommandSpec,
    signal?: AbortSignal,
    options: ProcessExecutionOptions = {}
  ): Promise<ManagedProcess> {
    signal?.throwIfAborted();
    const execution = await this.spawn(root, spec, signal, options);
    let stopPromise: Promise<void> | null = null;
    return {
      pid: execution.pid,
      result: execution.result,
      snapshot: execution.capture.snapshot,
      stop: () => {
        stopPromise ??= execution.stop();
        return stopPromise;
      },
    };
  }

  private async spawn(
    root: string,
    spec: CommandSpec,
    signal: AbortSignal | undefined,
    options: ProcessExecutionOptions
  ): Promise<{
    pid: number | null;
    result: Promise<CommandResult>;
    capture: OutputCapture;
    stop: () => Promise<void>;
  }> {
    const cwd = await this.resolveCwd(root, spec.cwd);
    const resolvedOptions = this.resolveOptions(spec, options);
    const capture = new OutputCapture(resolvedOptions);
    const startedAt = Date.now();
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new Error(`Command timed out after ${spec.timeoutMs}ms`)),
      spec.timeoutMs
    );
    timeout.unref();
    const cancelSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    const child = execa(spec.executable, spec.args, {
      cwd,
      env: commandEnvironment(process.env, spec.env),
      reject: false,
      cancelSignal,
      buffer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      cleanup: true,
      killDescendants: true,
      forceKillAfterDelay: resolvedOptions.stopGraceMs,
      input: resolvedOptions.input,
    });
    const pid = child.pid ?? null;
    capture.attach(child.stdout as Readable | null, 'stdout');
    capture.attach(child.stderr as Readable | null, 'stderr');

    let manuallyStopped = false;
    let terminationPromise: Promise<void> | null = null;
    const terminate = (): Promise<void> => {
      terminationPromise ??= terminateProcessTree(
        child,
        resolvedOptions.stopGraceMs,
        resolvedOptions.stopKillWaitMs
      );
      return terminationPromise;
    };
    const onAbort = (): void => {
      void terminate();
    };
    cancelSignal.addEventListener('abort', onAbort, { once: true });

    let naturalSettled = false;
    const naturalResult = Promise.resolve(child)
      .then(
        (outcome) =>
          this.commandResult(
            spec,
            outcome as ProcessOutcome,
            capture,
            startedAt,
            timeoutController.signal.aborted,
            signal?.aborted ?? false,
            manuallyStopped
          ),
        (error: unknown) =>
          this.commandResult(
            spec,
            processOutcome(error),
            capture,
            startedAt,
            timeoutController.signal.aborted,
            signal?.aborted ?? false,
            manuallyStopped
          )
      )
      .then(async (result) => {
        if (terminationPromise) await terminationPromise;
        return result;
      })
      .finally(() => {
        naturalSettled = true;
        clearTimeout(timeout);
        cancelSignal.removeEventListener('abort', onAbort);
      });

    let forceResult: ((result: CommandResult) => void) | null = null;
    const forcedResult = new Promise<CommandResult>((resolve) => {
      forceResult = resolve;
    });
    const result = Promise.race([naturalResult, forcedResult]);

    return {
      pid,
      result,
      capture,
      stop: async () => {
        manuallyStopped = true;
        await terminate();
        if (naturalSettled) return;
        const settled = await Promise.race([
          naturalResult.then(() => true),
          delay(resolvedOptions.stopKillWaitMs).then(() => false),
        ]);
        if (!settled && forceResult) {
          forceResult(
            this.commandResult(
              spec,
              { isTerminated: true, signal: 'SIGKILL' },
              capture,
              startedAt,
              timeoutController.signal.aborted,
              signal?.aborted ?? false,
              true
            )
          );
        }
      },
    };
  }

  private commandResult(
    spec: CommandSpec,
    outcome: ProcessOutcome,
    capture: OutputCapture,
    startedAt: number,
    timedOut: boolean,
    cancelled: boolean,
    manuallyStopped: boolean
  ): CommandResult {
    const output = capture.finish();
    return {
      executable: spec.executable,
      args: spec.args,
      exitCode: outcome.exitCode ?? null,
      ...output,
      durationMs: Date.now() - startedAt,
      timedOut: timedOut || Boolean(outcome.timedOut),
      cancelled: cancelled || Boolean(outcome.isCanceled),
      terminated: manuallyStopped || Boolean(outcome.isTerminated),
      signal: outcome.signal ?? null,
    };
  }

  private resolveOptions(
    spec: CommandSpec,
    options: ProcessExecutionOptions
  ): ResolvedProcessOptions {
    const environment = commandEnvironment(process.env, spec.env);
    const environmentSecrets = Object.entries(environment)
      .filter(
        ([key, value]) =>
          (SECRET_KEY.test(key) || SENSITIVE_ENVIRONMENT_URL.test(key)) &&
          value &&
          value.length >= 4
      )
      .map(([, value]) => value as string);
    return {
      input: options.input,
      maxOutputBytes: positiveInteger(
        options.maxOutputBytes ?? this.defaults.maxOutputBytes,
        DEFAULT_MAX_OUTPUT_BYTES,
        'maxOutputBytes'
      ),
      maxStreamBytes: positiveInteger(
        options.maxStreamBytes ?? this.defaults.maxStreamBytes,
        DEFAULT_MAX_STREAM_BYTES,
        'maxStreamBytes'
      ),
      maxChunkCharacters: positiveInteger(
        options.maxChunkCharacters ?? this.defaults.maxChunkCharacters,
        DEFAULT_MAX_CHUNK_CHARACTERS,
        'maxChunkCharacters'
      ),
      stopGraceMs: positiveInteger(
        options.stopGraceMs ?? this.defaults.stopGraceMs,
        DEFAULT_STOP_GRACE_MS,
        'stopGraceMs'
      ),
      stopKillWaitMs: positiveInteger(
        options.stopKillWaitMs ?? this.defaults.stopKillWaitMs,
        DEFAULT_STOP_KILL_WAIT_MS,
        'stopKillWaitMs'
      ),
      redactValues: [
        ...environmentSecrets,
        ...(this.defaults.redactValues ?? []),
        ...(options.redactValues ?? []),
      ],
      onOutput: options.onOutput ?? this.defaults.onOutput,
    };
  }

  private async resolveCwd(root: string, cwd: string): Promise<string> {
    const canonicalRoot = await realpath(root);
    const contained = assertPathContained(canonicalRoot, cwd);
    const canonicalCwd = await realpath(contained);
    assertPathContained(canonicalRoot, canonicalCwd);
    return canonicalCwd;
  }
}

class OutputCapture {
  private readonly stdout: BoundedBuffer;
  private readonly stderr: BoundedBuffer;
  private readonly combined: BoundedBuffer;
  private readonly stdoutRedactor: StreamingRedactor;
  private readonly stderrRedactor: StreamingRedactor;
  private readonly combinedRedactor: StreamingRedactor;
  private readonly emitter: BoundedOutputEmitter;
  private finished = false;

  constructor(options: ResolvedProcessOptions) {
    this.stdout = new BoundedBuffer(options.maxOutputBytes);
    this.stderr = new BoundedBuffer(options.maxOutputBytes);
    this.combined = new BoundedBuffer(options.maxOutputBytes);
    this.stdoutRedactor = new StreamingRedactor(options.redactValues);
    this.stderrRedactor = new StreamingRedactor(options.redactValues);
    this.combinedRedactor = new StreamingRedactor(options.redactValues);
    this.emitter = new BoundedOutputEmitter(
      options.onOutput,
      options.maxStreamBytes,
      options.maxChunkCharacters
    );
  }

  readonly snapshot = (): ProcessOutputSnapshot => {
    const snapshot = this.currentSnapshot(true);
    return {
      ...snapshot,
      stdout: stripFinalNewline(snapshot.stdout),
      stderr: stripFinalNewline(snapshot.stderr),
      combined: stripFinalNewline(snapshot.combined),
    };
  };

  attach(stream: Readable | null, name: ProcessOutputStream): void {
    stream?.on('data', (chunk: Buffer | string) => {
      this.write(name, Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    });
  }

  finish(): ProcessOutputSnapshot {
    if (!this.finished) {
      this.finished = true;
      this.append('stdout', this.stdoutRedactor.flush());
      this.append('stderr', this.stderrRedactor.flush());
      this.combined.append(this.combinedRedactor.flush());
    }
    const snapshot = this.currentSnapshot(false);
    return {
      ...snapshot,
      stdout: stripFinalNewline(snapshot.stdout),
      stderr: stripFinalNewline(snapshot.stderr),
      combined: stripFinalNewline(snapshot.combined),
    };
  }

  private write(stream: ProcessOutputStream, text: string): void {
    if (this.finished || !text) return;
    const redactor = stream === 'stdout' ? this.stdoutRedactor : this.stderrRedactor;
    this.append(stream, redactor.write(text));
    this.combined.append(this.combinedRedactor.write(text));
  }

  private append(stream: ProcessOutputStream, text: string): void {
    if (!text) return;
    const buffer = stream === 'stdout' ? this.stdout : this.stderr;
    buffer.append(text);
    this.emitter.emit(stream, text);
  }

  private currentSnapshot(includePending: boolean): ProcessOutputSnapshot {
    const stdout = this.stdout.snapshot(includePending ? this.stdoutRedactor.preview() : '');
    const stderr = this.stderr.snapshot(includePending ? this.stderrRedactor.preview() : '');
    const combined = this.combined.snapshot(includePending ? this.combinedRedactor.preview() : '');
    const droppedBytes = {
      stdout: stdout.droppedBytes,
      stderr: stderr.droppedBytes,
      combined: combined.droppedBytes,
      streamed: this.emitter.droppedBytes,
    };
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      combined: combined.text,
      truncated: Object.values(droppedBytes).some((bytes) => bytes > 0),
      droppedBytes,
    };
  }
}

class BoundedBuffer {
  private head: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private totalBytes = 0;
  private overflowed = false;

  constructor(private readonly limit: number) {}

  append(text: string): void {
    if (!text) return;
    const incoming = Buffer.from(text);
    this.totalBytes += incoming.byteLength;
    if (!this.overflowed) {
      const combined = Buffer.concat([this.tail, incoming]);
      if (combined.byteLength <= this.limit) {
        this.tail = combined;
        return;
      }
      this.overflowed = true;
      this.head = safeUtf8Prefix(combined, this.headBudget());
      this.tail = safeUtf8Tail(combined, this.tailBudget());
      return;
    }
    this.tail = safeUtf8Tail(Buffer.concat([this.tail, incoming]), this.tailBudget());
  }

  snapshot(suffix = ''): { text: string; droppedBytes: number } {
    const buffer = this.copy();
    buffer.append(suffix);
    const retainedBytes = buffer.head.byteLength + buffer.tail.byteLength;
    return {
      text: buffer.render(),
      droppedBytes: Math.max(0, buffer.totalBytes - retainedBytes),
    };
  }

  private copy(): BoundedBuffer {
    const copy = new BoundedBuffer(this.limit);
    copy.head = this.head;
    copy.tail = this.tail;
    copy.totalBytes = this.totalBytes;
    copy.overflowed = this.overflowed;
    return copy;
  }

  private headBudget(): number {
    if (this.limit <= OUTPUT_TRUNCATION_MARKER.byteLength) return 0;
    return Math.floor((this.limit - OUTPUT_TRUNCATION_MARKER.byteLength) / 2);
  }

  private tailBudget(): number {
    const headBudget = this.headBudget();
    return headBudget === 0
      ? this.limit
      : this.limit - OUTPUT_TRUNCATION_MARKER.byteLength - headBudget;
  }

  private render(): string {
    if (!this.overflowed || this.head.byteLength === 0) return this.tail.toString('utf8');
    return Buffer.concat([this.head, OUTPUT_TRUNCATION_MARKER, this.tail]).toString('utf8');
  }
}

class StreamingRedactor {
  private pending = '';
  private readonly guard: number;
  private readonly secrets: string[];
  private readonly canFlushCompleteLines: boolean;

  constructor(values: string[]) {
    this.secrets = [...new Set(values.filter((value) => value.length >= 4))].sort(
      (left, right) => right.length - left.length
    );
    this.canFlushCompleteLines = this.secrets.every((secret) => !/[\r\n]/.test(secret));
    this.guard = Math.max(
      REDACTION_GUARD_CHARACTERS,
      ...this.secrets.map((secret) => secret.length)
    );
  }

  write(text: string): string {
    this.pending += text;
    const guardedCharacters = this.pending.length - this.guard;
    const completeLineCharacters = this.canFlushCompleteLines
      ? this.pending.lastIndexOf('\n') + 1
      : 0;
    const emitCharacters = Math.max(guardedCharacters, completeLineCharacters);
    if (emitCharacters <= 0) return '';
    const redacted = redactSameLength(this.pending, this.secrets);
    const output = redacted.slice(0, emitCharacters);
    this.pending = this.pending.slice(emitCharacters);
    return output;
  }

  flush(): string {
    const output = this.preview();
    this.pending = '';
    return output;
  }

  preview(): string {
    return redactSameLength(this.pending, this.secrets);
  }
}

class BoundedOutputEmitter {
  private emittedBytes = 0;
  private sequence = 0;
  private closed = false;
  droppedBytes = 0;

  constructor(
    private readonly callback: ProcessExecutionOptions['onOutput'],
    private readonly limit: number,
    private readonly maxChunkCharacters: number
  ) {}

  emit(stream: ProcessOutputStream, text: string): void {
    if (!this.callback || !text) return;
    if (this.closed) {
      this.droppedBytes += Buffer.byteLength(text);
      return;
    }
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + this.maxChunkCharacters);
      if (
        end < text.length &&
        isHighSurrogate(text.charCodeAt(end - 1)) &&
        isLowSurrogate(text.charCodeAt(end))
      ) {
        end -= 1;
      }
      if (end === offset) end = Math.min(text.length, offset + 2);
      const chunk = text.slice(offset, end);
      const bytes = Buffer.byteLength(chunk);
      const remaining = Math.max(0, this.limit - this.emittedBytes);
      if (bytes <= remaining) {
        this.send(stream, chunk, false, 0);
        this.emittedBytes += bytes;
        offset = end;
        continue;
      }
      const partial = utf8Prefix(chunk, remaining);
      const emitted = Buffer.byteLength(partial);
      const dropped = bytes - emitted + Buffer.byteLength(text.slice(end));
      this.emittedBytes += emitted;
      this.droppedBytes += dropped;
      this.send(stream, partial, true, dropped);
      this.closed = true;
      return;
    }
  }

  private send(
    stream: ProcessOutputStream,
    text: string,
    truncated: boolean,
    droppedBytes: number
  ): void {
    try {
      this.callback?.({
        stream,
        text,
        sequence: ++this.sequence,
        truncated,
        droppedBytes,
      });
    } catch {
      // Output observation is best-effort and must never change command behavior.
    }
  }
}

function redactSameLength(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    redacted = redacted.replaceAll(secret, '*'.repeat(secret.length));
  }
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => '*'.repeat(match.length));
  }
  return redacted;
}

function stripFinalNewline(value: string): string {
  return value.replace(/\r?\n$/, '');
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function safeUtf8Prefix(buffer: Buffer<ArrayBufferLike>, limit: number): Buffer<ArrayBufferLike> {
  if (buffer.byteLength <= limit) return buffer;
  let end = Math.max(0, limit);
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end);
}

function safeUtf8Tail(buffer: Buffer<ArrayBufferLike>, limit: number): Buffer<ArrayBufferLike> {
  if (buffer.byteLength <= limit) return buffer;
  let start = Math.max(0, buffer.byteLength - limit);
  while (start < buffer.byteLength && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start);
}

function utf8Prefix(text: string, limit: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > limit) break;
    bytes += characterBytes;
    end += character.length;
  }
  return text.slice(0, end);
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function processOutcome(value: unknown): ProcessOutcome {
  if (!value || typeof value !== 'object') return {};
  const candidate = value as Record<string, unknown>;
  return {
    exitCode: typeof candidate.exitCode === 'number' ? candidate.exitCode : undefined,
    timedOut: candidate.timedOut === true,
    isCanceled: candidate.isCanceled === true,
    isTerminated: candidate.isTerminated === true,
    signal: typeof candidate.signal === 'string' ? candidate.signal : undefined,
  };
}

async function terminateProcessTree(
  child: KillableProcess,
  graceMs: number,
  killWaitMs: number
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  signalProcessTree(child, pid, 'SIGTERM');
  if (await waitForTreeExit(pid, graceMs)) return;
  signalProcessTree(child, pid, 'SIGKILL');
  await waitForTreeExit(pid, killWaitMs);
}

function signalProcessTree(child: KillableProcess, pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to the direct child when the process group is already gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child might have exited between the liveness check and the signal.
  }
}

async function waitForTreeExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processTreeAlive(pid)) return true;
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  return !processTreeAlive(pid);
}

function processTreeAlive(pid: number): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
