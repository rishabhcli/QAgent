import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { WorkerEnvelope, WorkerResponse } from './ipc.js';

interface WorkerRuntimeModule {
  createWorkerDispatcher(
    parentPort: NonNullable<typeof process.parentPort>
  ): Promise<WorkerRuntimeController>;
}

interface WorkerRuntimeController {
  recoveredRunIds: string[];
  dispatch(envelope: WorkerEnvelope): Promise<void>;
  shutdown(options?: { graceMs?: number }): Promise<{
    drained: boolean;
    activeRunIds: string[];
  }>;
}

interface ShutdownEnvelope {
  id: string;
  type: 'worker.shutdown';
  graceMs?: number;
}

const parentPort = process.parentPort;
if (!parentPort) throw new Error('QAgent engine worker requires an Electron parent port');
const loadRuntimeModule = createRequire(__filename);

const MAX_QUEUED_REQUESTS = 256;
const MAX_FAILURE_BYTES = 8 * 1024;
const queue: WorkerEnvelope[] = [];
let controller: WorkerRuntimeController | null = null;
let state: 'loading' | 'ready' | 'stopping' | 'failed' = 'loading';
let failureMessage = 'QAgent engine worker failed to start';

parentPort.on('message', (event) => {
  const message = event.data as WorkerEnvelope | ShutdownEnvelope;
  if (isShutdownEnvelope(message)) {
    void beginShutdown(message);
    return;
  }
  if (state === 'ready' && controller) {
    dispatch(message);
    return;
  }
  if (state === 'failed') {
    postResponse({ id: message.id, ok: false, error: failureMessage });
    return;
  }
  if (state === 'stopping') {
    postResponse({ id: message.id, ok: false, error: 'QAgent engine worker is shutting down' });
    return;
  }
  if (queue.length >= MAX_QUEUED_REQUESTS) {
    postResponse({
      id: message.id,
      ok: false,
      error: 'QAgent engine worker startup queue is full',
    });
    return;
  }
  queue.push(message);
});

void loadRuntime();

async function loadRuntime(): Promise<void> {
  try {
    const runtimePath = join(__dirname, 'engine-runtime.js');
    const runtime = loadRuntimeModule(runtimePath) as WorkerRuntimeModule;
    controller = await runtime.createWorkerDispatcher(parentPort);
    state = 'ready';
    safePost({
      type: 'worker.ready',
      data: { recoveredRunIds: controller.recoveredRunIds },
    });
    for (const envelope of queue.splice(0)) dispatch(envelope);
  } catch (error) {
    state = 'failed';
    failureMessage = boundedFailure(error);
    safePost({ type: 'worker.failed', data: { message: failureMessage } });
    for (const envelope of queue.splice(0)) {
      postResponse({ id: envelope.id, ok: false, error: failureMessage });
    }
    process.stderr.write(`${failureMessage}\n`);
    setImmediate(() => process.exit(1));
  }
}

function dispatch(envelope: WorkerEnvelope): void {
  if (!controller) {
    postResponse({ id: envelope.id, ok: false, error: 'QAgent engine worker is not ready' });
    return;
  }
  void controller.dispatch(envelope).catch((error) => {
    postResponse({ id: envelope.id, ok: false, error: boundedFailure(error) });
  });
}

async function beginShutdown(envelope: ShutdownEnvelope): Promise<void> {
  if (state === 'failed') {
    postResponse({ id: envelope.id, ok: false, error: failureMessage });
    return;
  }
  if (state === 'loading' || !controller) {
    postResponse({
      id: envelope.id,
      ok: false,
      error: 'QAgent engine worker has not finished starting',
    });
    return;
  }
  if (state === 'stopping') {
    postResponse({
      id: envelope.id,
      ok: false,
      error: 'QAgent engine worker shutdown is already in progress',
    });
    return;
  }
  state = 'stopping';
  try {
    const result = await controller.shutdown({ graceMs: envelope.graceMs });
    postResponse({ id: envelope.id, ok: true, data: result });
  } catch (error) {
    postResponse({ id: envelope.id, ok: false, error: boundedFailure(error) });
  }
}

function isShutdownEnvelope(
  envelope: WorkerEnvelope | ShutdownEnvelope
): envelope is ShutdownEnvelope {
  return (
    Boolean(envelope) &&
    typeof envelope === 'object' &&
    'type' in envelope &&
    envelope.type === 'worker.shutdown'
  );
}

function postResponse(response: WorkerResponse): void {
  safePost(response);
}

function safePost(message: unknown): boolean {
  try {
    parentPort.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function boundedFailure(error: unknown): string {
  const raw = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const redacted = raw
    .replace(/bearer\s+[a-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[a-z0-9_-]{12,}/gi, '[REDACTED]')
    .replace(/gh[pousr]_[a-z0-9_]+/gi, '[REDACTED]');
  const bytes = Buffer.from(redacted);
  return bytes.byteLength <= MAX_FAILURE_BYTES
    ? redacted
    : bytes.subarray(bytes.byteLength - MAX_FAILURE_BYTES).toString('utf8');
}
