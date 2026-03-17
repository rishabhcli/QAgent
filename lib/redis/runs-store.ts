/**
 * Redis-backed Run Storage
 *
 * Provides persistent storage for runs with TTL support.
 * Replaces in-memory storage for production use.
 */

import { getRedisClient, isRedisAvailable } from './client';
import type { Run, RunStatus, AgentType, Patch, TestResult, TestSpec } from '@/lib/types';

// Redis key prefixes
const RUN_KEY_PREFIX = 'runs:data:';
const RUN_HISTORY_PREFIX = 'runs:history:';
const ACTIVE_RUNS_KEY = 'runs:active';
const ALL_RUNS_KEY = 'runs:all';

// Default TTL: 30 days in seconds
const DEFAULT_RUN_TTL = 30 * 24 * 60 * 60;

/**
 * Serialize dates for Redis storage
 */
function serializeRun(run: Run): string {
  return JSON.stringify({
    ...run,
    startedAt: run.startedAt instanceof Date ? run.startedAt.toISOString() : run.startedAt,
    completedAt: run.completedAt instanceof Date ? run.completedAt.toISOString() : run.completedAt,
  });
}

/**
 * Deserialize dates from Redis storage
 */
function deserializeRun(data: string): Run {
  const parsed = JSON.parse(data);
  return {
    ...parsed,
    startedAt: new Date(parsed.startedAt),
    completedAt: parsed.completedAt ? new Date(parsed.completedAt) : undefined,
  };
}

/**
 * Store a new run in Redis
 */
export async function storeRun(run: Run, ttlSeconds: number = DEFAULT_RUN_TTL): Promise<void> {
  if (!(await isRedisAvailable())) {
    console.warn('Redis not available, run will not be persisted');
    return;
  }

  const redis = await getRedisClient();
  const key = `${RUN_KEY_PREFIX}${run.id}`;

  // Store run data with TTL
  await redis.setEx(key, ttlSeconds, serializeRun(run));

  // Add to repo history (capped list)
  const historyKey = `${RUN_HISTORY_PREFIX}${run.repoId}`;
  await redis.lPush(historyKey, run.id);
  await redis.lTrim(historyKey, 0, 99); // Keep last 100 runs per repo

  // Add to all runs sorted set (score = timestamp)
  await redis.zAdd(ALL_RUNS_KEY, {
    score: run.startedAt.getTime(),
    value: run.id,
  });
}

/**
 * Get a run by ID
 */
export async function getStoredRun(runId: string): Promise<Run | null> {
  if (!(await isRedisAvailable())) {
    return null;
  }

  const redis = await getRedisClient();
  const key = `${RUN_KEY_PREFIX}${runId}`;
  const data = await redis.get(key);

  if (!data || typeof data !== 'string') {
    return null;
  }

  return deserializeRun(data);
}

/**
 * Update a run in Redis
 */
export async function updateStoredRun(
  runId: string,
  updates: Partial<Run>,
  ttlSeconds: number = DEFAULT_RUN_TTL
): Promise<Run | null> {
  const existing = await getStoredRun(runId);
  if (!existing) {
    return null;
  }

  const updated: Run = {
    ...existing,
    ...updates,
  };

  await storeRun(updated, ttlSeconds);
  return updated;
}

/**
 * Update run status
 */
export async function updateStoredRunStatus(runId: string, status: RunStatus): Promise<void> {
  const updates: Partial<Run> = { status };

  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    updates.completedAt = new Date();

    // Remove from active runs
    if (await isRedisAvailable()) {
      const redis = await getRedisClient();
      await redis.sRem(ACTIVE_RUNS_KEY, runId);
    }
  } else if (status === 'running') {
    // Add to active runs
    if (await isRedisAvailable()) {
      const redis = await getRedisClient();
      await redis.sAdd(ACTIVE_RUNS_KEY, runId);
    }
  }

  await updateStoredRun(runId, updates);
}

/**
 * Update current agent for a run
 */
export async function updateStoredRunAgent(runId: string, agent: AgentType | null): Promise<void> {
  await updateStoredRun(runId, { currentAgent: agent });
}

/**
 * Update Browserbase session ID for a run
 */
export async function updateStoredRunSession(runId: string, sessionId: string): Promise<void> {
  await updateStoredRun(runId, { sessionId });
}

/**
 * Increment run iteration
 */
export async function incrementStoredRunIteration(runId: string): Promise<void> {
  const run = await getStoredRun(runId);
  if (run) {
    await updateStoredRun(runId, { iteration: run.iteration + 1 });
  }
}

/**
 * Add a patch to a run
 */
export async function addStoredRunPatch(runId: string, patch: Patch): Promise<void> {
  const run = await getStoredRun(runId);
  if (run) {
    await updateStoredRun(runId, { patches: [...run.patches, patch] });
  }
}

/**
 * Add a test result to a run
 */
export async function addStoredRunTestResult(runId: string, testResult: TestResult): Promise<void> {
  const run = await getStoredRun(runId);
  if (run) {
    await updateStoredRun(runId, { testResults: [...run.testResults, testResult] });
  }
}

/**
 * Get all runs for a repository
 */
export async function getRepoRuns(repoId: string, limit: number = 50): Promise<Run[]> {
  if (!(await isRedisAvailable())) {
    return [];
  }

  const redis = await getRedisClient();
  const historyKey = `${RUN_HISTORY_PREFIX}${repoId}`;
  const runIds = await redis.lRange(historyKey, 0, limit - 1);

  const runs: Run[] = [];
  for (const id of runIds) {
    const run = await getStoredRun(id);
    if (run) {
      runs.push(run);
    }
  }

  return runs;
}

/**
 * Get all runs across all repos
 */
export async function getAllStoredRuns(limit: number = 100): Promise<Run[]> {
  if (!(await isRedisAvailable())) {
    return [];
  }

  const redis = await getRedisClient();
  // Get most recent runs (highest scores first)
  const runIds = await redis.zRange(ALL_RUNS_KEY, '+inf', '-inf', {
    BY: 'SCORE',
    REV: true,
    LIMIT: { offset: 0, count: limit },
  });

  const runs: Run[] = [];
  for (const id of runIds) {
    const run = await getStoredRun(id);
    if (run) {
      runs.push(run);
    }
  }

  return runs;
}

/**
 * Get active (running) runs
 */
export async function getActiveRuns(): Promise<Run[]> {
  if (!(await isRedisAvailable())) {
    return [];
  }

  const redis = await getRedisClient();
  const runIds = await redis.sMembers(ACTIVE_RUNS_KEY);

  const runs: Run[] = [];
  for (const id of runIds) {
    const run = await getStoredRun(id);
    if (run && run.status === 'running') {
      runs.push(run);
    }
  }

  return runs;
}

/**
 * Delete a run
 */
export async function deleteStoredRun(runId: string): Promise<boolean> {
  if (!(await isRedisAvailable())) {
    return false;
  }

  const run = await getStoredRun(runId);
  if (!run) {
    return false;
  }

  const redis = await getRedisClient();

  // Remove from all data structures
  await redis.del(`${RUN_KEY_PREFIX}${runId}`);
  await redis.lRem(`${RUN_HISTORY_PREFIX}${run.repoId}`, 0, runId);
  await redis.zRem(ALL_RUNS_KEY, runId);
  await redis.sRem(ACTIVE_RUNS_KEY, runId);

  return true;
}

/**
 * Create a new run and store it in Redis
 */
export async function createStoredRun(data: {
  id?: string;
  repoId: string;
  repoName: string;
  testSpecs: TestSpec[];
  maxIterations: number;
  trigger?: 'webhook' | 'cron' | 'manual';
  metadata?: {
    commitSha?: string;
    branch?: string;
    pusher?: string;
  };
}): Promise<Run> {
  const run: Run = {
    id: data.id || crypto.randomUUID(),
    repoId: data.repoId,
    repoName: data.repoName,
    status: 'pending',
    currentAgent: null,
    iteration: 0,
    maxIterations: data.maxIterations,
    testSpecs: data.testSpecs,
    patches: [],
    testResults: [],
    startedAt: new Date(),
  };

  await storeRun(run);
  return run;
}

/**
 * Get run statistics for a repo
 */
export async function getStoredRunStats(repoId?: string): Promise<{
  totalRuns: number;
  passRate: number;
  patchesApplied: number;
  avgIterations: number;
}> {
  const runs = repoId ? await getRepoRuns(repoId) : await getAllStoredRuns();

  if (runs.length === 0) {
    return {
      totalRuns: 0,
      passRate: 0,
      patchesApplied: 0,
      avgIterations: 0,
    };
  }

  const completedRuns = runs.filter((r) => r.status === 'completed');
  const totalPatches = runs.reduce((sum, r) => sum + r.patches.length, 0);
  const totalIterations = runs.reduce((sum, r) => sum + r.iteration, 0);

  return {
    totalRuns: runs.length,
    passRate: (completedRuns.length / runs.length) * 100,
    patchesApplied: totalPatches,
    avgIterations: totalIterations / runs.length,
  };
}

/**
 * Clean up expired runs (for maintenance)
 */
export async function cleanupExpiredRuns(): Promise<number> {
  if (!(await isRedisAvailable())) {
    return 0;
  }

  const redis = await getRedisClient();
  const retentionDays = parseInt(process.env.RUN_RETENTION_DAYS || '30', 10);
  const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  // Get runs older than cutoff
  const oldRunIds = await redis.zRangeByScore(ALL_RUNS_KEY, 0, cutoffTime);

  let cleaned = 0;
  for (const runId of oldRunIds) {
    if (await deleteStoredRun(runId)) {
      cleaned++;
    }
  }

  return cleaned;
}
