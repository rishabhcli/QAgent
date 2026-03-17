import type { Run, RunStatus, AgentType, TestSpec, Patch, TestResult } from '@/lib/types';
import { addPatchFromRun } from '@/lib/dashboard/patch-store';
import {
  storeRun as storeRedisRun,
  getStoredRun,
  getAllStoredRuns,
  deleteStoredRun,
  getStoredRunStats,
} from '@/lib/redis/runs-store';

// Store runs in globalThis to survive HMR in development
const globalForRuns = globalThis as unknown as {
  runsMap: Map<string, Run> | undefined;
};

// In-memory store for runs with HMR persistence
const runs = globalForRuns.runsMap ?? new Map<string, Run>();
globalForRuns.runsMap = runs;

function cacheRun(run: Run): Run {
  runs.set(run.id, run);
  return run;
}

function persistRun(run: Run): void {
  cacheRun(run);
  storeRedisRun(run).catch((err) => {
    console.warn('Failed to store run in Redis:', err.message);
  });
}

export function createRun(data: {
  ownerId?: number;
  repoId: string;
  repoName: string;
  testSpecs: TestSpec[];
  maxIterations: number;
}): Run {
  const run: Run = {
    id: crypto.randomUUID(),
    ownerId: data.ownerId,
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

  persistRun(run);
  return run;
}

export function getRun(runId: string): Run | null {
  // First check in-memory cache
  const cached = runs.get(runId);
  if (cached) {
    return cached;
  }
  return null;
}

// Async version that checks Redis as fallback
export async function getRunAsync(runId: string): Promise<Run | null> {
  // First check in-memory cache
  const cached = runs.get(runId);
  if (cached) {
    return cached;
  }

  // Fall back to Redis
  try {
    const stored = await getStoredRun(runId);
    if (stored) {
      // Restore to in-memory cache
      cacheRun(stored);
      return stored;
    }
  } catch (err) {
    console.warn('Failed to get run from Redis:', err);
  }

  return null;
}

export function getAllRuns(): Run[] {
  return Array.from(runs.values()).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}

// Async version that merges with Redis
export async function getAllRunsAsync(): Promise<Run[]> {
  const memoryRuns = Array.from(runs.values());

  try {
    const storedRuns = await getAllStoredRuns(100);

    // Merge: use in-memory version if exists (more up-to-date), otherwise use Redis
    const runMap = new Map<string, Run>();

    // Add stored runs first
    for (const run of storedRuns) {
      runMap.set(run.id, run);
    }

    // Overwrite with in-memory runs (more current)
    for (const run of memoryRuns) {
      runMap.set(run.id, run);
    }

    return Array.from(runMap.values()).sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  } catch (err) {
    console.warn('Failed to get runs from Redis:', err);
    return memoryRuns.sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  }
}

export function updateRunStatus(runId: string, status: RunStatus): void {
  const run = runs.get(runId);
  if (run) {
    run.status = status;
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      run.completedAt = new Date();
    }

    persistRun(run);
  }
}

export function updateRunAgent(runId: string, agent: AgentType | null): void {
  const run = runs.get(runId);
  if (run) {
    run.currentAgent = agent;
    persistRun(run);
  }
}

export function updateRunSession(runId: string, sessionId: string): void {
  const run = runs.get(runId);
  if (run) {
    run.sessionId = sessionId;
    persistRun(run);
  }
}

export function incrementRunIteration(runId: string): void {
  const run = runs.get(runId);
  if (run) {
    run.iteration += 1;
    persistRun(run);
  }
}

export function addRunPatch(runId: string, patch: Patch): void {
  const run = runs.get(runId);
  if (run) {
    run.patches.push(patch);
    persistRun(run);
    addPatchFromRun(runId, patch).catch((err) => {
      console.warn('Failed to store patch details:', err);
    });
  }
}

export function addRunTestResult(runId: string, testResult: TestResult): void {
  const run = runs.get(runId);
  if (run) {
    run.testResults.push(testResult);
    persistRun(run);
  }
}

export function deleteRun(runId: string): boolean {
  abortControllers.delete(runId);
  const deleted = runs.delete(runId);
  deleteStoredRun(runId).catch((err) => {
    console.warn('Failed to delete run from Redis:', err);
  });
  return deleted;
}

// AbortController registry for active runs
const abortControllers = new Map<string, AbortController>();

export function registerAbortController(runId: string, controller: AbortController): void {
  abortControllers.set(runId, controller);
}

export function cancelRun(runId: string): boolean {
  const controller = abortControllers.get(runId);
  if (controller) {
    controller.abort();
    abortControllers.delete(runId);
    updateRunStatus(runId, 'cancelled');
    return true;
  }
  return false;
}

export function getAbortController(runId: string): AbortController | undefined {
  return abortControllers.get(runId);
}

// Get stats for dashboard
export function getRunStats(): {
  totalRuns: number;
  passRate: number;
  patchesApplied: number;
  avgIterations: number;
} {
  const allRuns = getAllRuns();

  if (allRuns.length === 0) {
    return {
      totalRuns: 0,
      passRate: 0,
      patchesApplied: 0,
      avgIterations: 0,
    };
  }

  const completedRuns = allRuns.filter((r) => r.status === 'completed');
  const totalPatches = allRuns.reduce((sum, r) => sum + r.patches.length, 0);
  const totalIterations = allRuns.reduce((sum, r) => sum + r.iteration, 0);

  return {
    totalRuns: allRuns.length,
    passRate: completedRuns.length / allRuns.length * 100,
    patchesApplied: totalPatches,
    avgIterations: totalIterations / allRuns.length,
  };
}

export async function getRunStatsAsync(repoId?: string): Promise<{
  totalRuns: number;
  passRate: number;
  patchesApplied: number;
  avgIterations: number;
}> {
  try {
    return await getStoredRunStats(repoId);
  } catch (err) {
    console.warn('Failed to get run stats from Redis:', err);
    return getRunStats();
  }
}
