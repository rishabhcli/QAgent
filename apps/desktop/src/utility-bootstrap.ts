import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { WorkerEnvelope } from './ipc.js';

interface WorkerRuntimeModule {
  createWorkerDispatcher(
    parentPort: NonNullable<typeof process.parentPort>
  ): (envelope: WorkerEnvelope) => Promise<void>;
}

const parentPort = process.parentPort;
if (!parentPort) throw new Error('QAgent engine worker requires an Electron parent port');
const loadRuntimeModule = createRequire(__filename);

const queue: WorkerEnvelope[] = [];
let dispatch: ((envelope: WorkerEnvelope) => Promise<void>) | null = null;
let loading = false;

parentPort.on('message', (event) => {
  const envelope = event.data as WorkerEnvelope;
  if (dispatch) void dispatch(envelope);
  else {
    queue.push(envelope);
    loadRuntime();
  }
});

function loadRuntime(): void {
  if (loading) return;
  loading = true;
  setImmediate(() => {
    try {
      const runtimePath = join(__dirname, 'engine-runtime.js');
      const runtime = loadRuntimeModule(runtimePath) as WorkerRuntimeModule;
      dispatch = runtime.createWorkerDispatcher(parentPort);
      for (const envelope of queue.splice(0)) void dispatch(envelope);
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`${message}\n`);
      for (const envelope of queue.splice(0)) {
        parentPort.postMessage({ id: envelope.id, ok: false, error: message });
      }
      process.exitCode = 1;
    }
  });
}
