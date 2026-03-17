import { dequeueRun } from '@/lib/redis/queue';
import { processQueuedRun } from '@/lib/queue/processor';

let draining = false;

export function scheduleQueueProcessing(): void {
  if (draining) {
    return;
  }

  draining = true;

  queueMicrotask(async () => {
    try {
      while (true) {
        const queuedRun = await dequeueRun();
        if (!queuedRun) {
          break;
        }

        await processQueuedRun(queuedRun);
      }
    } catch (error) {
      console.error('[QueueDispatcher] Failed to process queued runs:', error);
    } finally {
      draining = false;
    }
  });
}
