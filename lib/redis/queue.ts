/**
 * Redis-backed Run Queue
 *
 * Provides a priority queue for scheduled and webhook-triggered runs
 * with deduplication and concurrency control.
 */

import { getRedisClient, isRedisAvailable } from './client';
import type { QueuedRun, QueuedRunPriority, QueuedRunTrigger } from '@/lib/types';

// Redis keys
const QUEUE_KEY = 'run_queue';
const QUEUE_DATA_PREFIX = 'run_queue:data:';
const PROCESSING_SET_KEY = 'run_queue:processing';
const REPO_LOCK_PREFIX = 'run_queue:lock:';

// Priority scores (lower = higher priority)
const PRIORITY_SCORES: Record<QueuedRunPriority, number> = {
  high: 0,
  normal: 1000000,
  low: 2000000,
};

// Trigger priorities
const TRIGGER_PRIORITY: Record<QueuedRunTrigger, QueuedRunPriority> = {
  webhook: 'high',
  cron: 'normal',
  manual: 'normal',
};

// Lock TTL: 10 minutes
const LOCK_TTL = 10 * 60;

/**
 * Serialize a queued run for storage
 */
function serializeQueuedRun(run: QueuedRun): string {
  return JSON.stringify({
    ...run,
    createdAt: run.createdAt instanceof Date ? run.createdAt.toISOString() : run.createdAt,
    startedAt: run.startedAt instanceof Date ? run.startedAt.toISOString() : run.startedAt,
    completedAt: run.completedAt instanceof Date ? run.completedAt.toISOString() : run.completedAt,
  });
}

/**
 * Deserialize a queued run from storage
 */
function deserializeQueuedRun(data: string): QueuedRun {
  const parsed = JSON.parse(data);
  return {
    ...parsed,
    createdAt: new Date(parsed.createdAt),
    startedAt: parsed.startedAt ? new Date(parsed.startedAt) : undefined,
    completedAt: parsed.completedAt ? new Date(parsed.completedAt) : undefined,
  };
}

/**
 * Calculate queue score based on priority and timestamp
 * Lower score = higher priority
 */
function calculateScore(priority: QueuedRunPriority, timestamp: number): number {
  return PRIORITY_SCORES[priority] + timestamp;
}

/**
 * Enqueue a run for processing
 * Returns null if a run for this repo/branch is already queued (deduplication)
 */
export async function enqueueRun(params: {
  repoId: string;
  repoFullName: string;
  trigger: QueuedRunTrigger;
  priority?: QueuedRunPriority;
  metadata?: QueuedRun['metadata'];
}): Promise<QueuedRun | null> {
  if (!(await isRedisAvailable())) {
    console.warn('Redis not available, cannot enqueue run');
    return null;
  }

  const redis = await getRedisClient();

  // Deduplication key based on repo and branch
  const branch = params.metadata?.branch || 'main';
  const dedupeKey = `${REPO_LOCK_PREFIX}${params.repoId}:${branch}`;

  // Check if there's already a pending run for this repo/branch
  const existing = await redis.get(dedupeKey);
  if (existing) {
    console.log(`Run already queued for ${params.repoFullName}:${branch}`);
    return null;
  }

  const priority = params.priority || TRIGGER_PRIORITY[params.trigger];
  const now = Date.now();
  const id = crypto.randomUUID();

  const queuedRun: QueuedRun = {
    id,
    repoId: params.repoId,
    repoFullName: params.repoFullName,
    priority,
    trigger: params.trigger,
    status: 'queued',
    createdAt: new Date(now),
    metadata: params.metadata,
  };

  // Store run data
  await redis.setEx(`${QUEUE_DATA_PREFIX}${id}`, 24 * 60 * 60, serializeQueuedRun(queuedRun));

  // Add to priority queue
  const score = calculateScore(priority, now);
  await redis.zAdd(QUEUE_KEY, { score, value: id });

  // Set deduplication lock (expires after run completes or 1 hour)
  await redis.setEx(dedupeKey, 60 * 60, id);

  console.log(`Enqueued run ${id} for ${params.repoFullName} (${params.trigger}, priority: ${priority})`);
  return queuedRun;
}

/**
 * Dequeue the next run for processing
 * Returns null if no runs are available or concurrency limit is reached
 */
export async function dequeueRun(): Promise<QueuedRun | null> {
  if (!(await isRedisAvailable())) {
    return null;
  }

  const redis = await getRedisClient();

  // Check concurrency limit
  const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_RUNS || '3', 10);
  const processingCount = await redis.sCard(PROCESSING_SET_KEY);
  if (processingCount >= maxConcurrent) {
    console.log(`Concurrency limit reached (${processingCount}/${maxConcurrent})`);
    return null;
  }

  // Get highest priority run (lowest score)
  const results = await redis.zRange(QUEUE_KEY, 0, 0);
  if (results.length === 0) {
    return null;
  }

  const runId = results[0];

  // Remove from queue and add to processing set (atomic)
  const removed = await redis.zRem(QUEUE_KEY, runId);
  if (removed === 0) {
    // Already dequeued by another process
    return null;
  }

  // Get run data
  const data = await redis.get(`${QUEUE_DATA_PREFIX}${runId}`);
  if (!data || typeof data !== 'string') {
    console.warn(`Run data not found for ${runId}`);
    return null;
  }

  const queuedRun = deserializeQueuedRun(data);
  queuedRun.status = 'processing';
  queuedRun.startedAt = new Date();

  // Update stored data
  await redis.setEx(`${QUEUE_DATA_PREFIX}${runId}`, 24 * 60 * 60, serializeQueuedRun(queuedRun));

  // Add to processing set with TTL
  await redis.sAdd(PROCESSING_SET_KEY, runId);

  console.log(`Dequeued run ${runId} for ${queuedRun.repoFullName}`);
  return queuedRun;
}

/**
 * Mark a queued run as completed
 */
export async function completeQueuedRun(
  queuedRunId: string,
  runId: string,
  success: boolean
): Promise<void> {
  if (!(await isRedisAvailable())) {
    return;
  }

  const redis = await getRedisClient();

  // Get run data
  const data = await redis.get(`${QUEUE_DATA_PREFIX}${queuedRunId}`);
  if (!data || typeof data !== 'string') {
    return;
  }

  const queuedRun = deserializeQueuedRun(data);
  queuedRun.status = success ? 'completed' : 'failed';
  queuedRun.completedAt = new Date();
  queuedRun.runId = runId;

  // Update stored data
  await redis.setEx(`${QUEUE_DATA_PREFIX}${queuedRunId}`, 24 * 60 * 60, serializeQueuedRun(queuedRun));

  // Remove from processing set
  await redis.sRem(PROCESSING_SET_KEY, queuedRunId);

  // Remove deduplication lock
  const branch = queuedRun.metadata?.branch || 'main';
  await redis.del(`${REPO_LOCK_PREFIX}${queuedRun.repoId}:${branch}`);

  console.log(`Completed queued run ${queuedRunId} (${success ? 'success' : 'failed'})`);
}

/**
 * Get a queued run by ID
 */
export async function getQueuedRun(id: string): Promise<QueuedRun | null> {
  if (!(await isRedisAvailable())) {
    return null;
  }

  const redis = await getRedisClient();
  const data = await redis.get(`${QUEUE_DATA_PREFIX}${id}`);

  if (!data || typeof data !== 'string') {
    return null;
  }

  return deserializeQueuedRun(data);
}

/**
 * Get queue status
 */
export async function getQueueStatus(): Promise<{
  pending: number;
  processing: number;
  items: QueuedRun[];
}> {
  if (!(await isRedisAvailable())) {
    return { pending: 0, processing: 0, items: [] };
  }

  const redis = await getRedisClient();

  const pending = await redis.zCard(QUEUE_KEY);
  const processing = await redis.sCard(PROCESSING_SET_KEY);

  // Get all pending items
  const pendingIds = await redis.zRange(QUEUE_KEY, 0, -1);
  const processingIds = await redis.sMembers(PROCESSING_SET_KEY);

  const items: QueuedRun[] = [];
  for (const id of [...pendingIds, ...processingIds]) {
    const run = await getQueuedRun(id);
    if (run) {
      items.push(run);
    }
  }

  return { pending, processing, items };
}

/**
 * Cancel a queued run
 */
export async function cancelQueuedRun(id: string): Promise<boolean> {
  if (!(await isRedisAvailable())) {
    return false;
  }

  const redis = await getRedisClient();

  // Get run to find repo for lock cleanup
  const data = await redis.get(`${QUEUE_DATA_PREFIX}${id}`);
  if (!data || typeof data !== 'string') {
    return false;
  }

  const queuedRun = deserializeQueuedRun(data);

  // Remove from queue
  await redis.zRem(QUEUE_KEY, id);

  // Remove from processing if applicable
  await redis.sRem(PROCESSING_SET_KEY, id);

  // Remove deduplication lock
  const branch = queuedRun.metadata?.branch || 'main';
  await redis.del(`${REPO_LOCK_PREFIX}${queuedRun.repoId}:${branch}`);

  // Delete run data
  await redis.del(`${QUEUE_DATA_PREFIX}${id}`);

  console.log(`Cancelled queued run ${id}`);
  return true;
}

/**
 * Get pending runs for a specific repo
 */
export async function getRepoQueuedRuns(repoId: string): Promise<QueuedRun[]> {
  const status = await getQueueStatus();
  return status.items.filter((item) => item.repoId === repoId);
}

export async function cancelQueuedRunByActualRunId(runId: string): Promise<boolean> {
  const status = await getQueueStatus();
  const match = status.items.find((item) => item.metadata?.adHoc?.runId === runId);
  if (!match) {
    return false;
  }

  return cancelQueuedRun(match.id);
}

/**
 * Clean up stale processing entries
 * (runs that have been processing for too long without completing)
 */
export async function cleanupStaleProcessing(maxAge: number = LOCK_TTL * 1000): Promise<number> {
  if (!(await isRedisAvailable())) {
    return 0;
  }

  const redis = await getRedisClient();
  const processingIds = await redis.sMembers(PROCESSING_SET_KEY);
  const cutoff = Date.now() - maxAge;

  let cleaned = 0;
  for (const id of processingIds) {
    const run = await getQueuedRun(id);
    if (run && run.startedAt && run.startedAt.getTime() < cutoff) {
      await cancelQueuedRun(id);
      cleaned++;
    }
  }

  return cleaned;
}
