/**
 * Queue Processor
 *
 * Processes queued runs by executing the QAgent orchestrator.
 */

import { completeQueuedRun } from '@/lib/redis/queue';
import { getMonitoringConfig, recordMonitoringRun } from '@/lib/redis/monitoring-config';
import {
  createStoredRun,
  updateStoredRunStatus,
  addStoredRunPatch,
  updateStoredRunSession,
} from '@/lib/redis/runs-store';
import { recordRunMetrics } from '@/lib/redis/metrics-store';
import { emitSessionStarted, sseEmitter } from '@/lib/dashboard/sse-emitter';
import { Orchestrator } from '@/agents/orchestrator';
import { getRunAsync } from '@/lib/dashboard/run-store';
import { executeAdHocRun } from '@/lib/queue/ad-hoc-runner';
import type { QueuedRun, Run } from '@/lib/types';

/**
 * Process a queued run
 */
export async function processQueuedRun(queuedRun: QueuedRun): Promise<Run | null> {
  console.log(`[Processor] Starting run ${queuedRun.id} for ${queuedRun.repoFullName}`);

  if (queuedRun.metadata?.adHoc) {
    return processAdHocQueuedRun(queuedRun);
  }

  // Get monitoring config for test specs
  const config = await getMonitoringConfig(queuedRun.repoId);
  if (!config) {
    console.error(`[Processor] No monitoring config found for ${queuedRun.repoId}`);
    await completeQueuedRun(queuedRun.id, '', false);
    return null;
  }

  if (config.testSpecs.length === 0) {
    console.error(`[Processor] No test specs configured for ${queuedRun.repoFullName}`);
    await completeQueuedRun(queuedRun.id, '', false);
    return null;
  }

  // Create a run record
  const run = await createStoredRun({
    repoId: queuedRun.repoId,
    repoName: queuedRun.repoFullName,
    testSpecs: config.testSpecs,
    maxIterations: parseInt(process.env.MAX_ITERATIONS || '5', 10),
    trigger: queuedRun.trigger,
    metadata: queuedRun.metadata,
  });

  // Emit run started event
  sseEmitter.emit({
    type: 'status',
    timestamp: new Date(),
    runId: run.id,
    data: {
      status: 'running',
      trigger: queuedRun.trigger,
      repoFullName: queuedRun.repoFullName,
    },
  });

  await updateStoredRunStatus(run.id, 'running');

  try {
    // Determine target URL
    const targetUrl = process.env.TARGET_URL || 'http://localhost:3002';

    console.log(`[Processor] Running orchestrator for ${queuedRun.repoFullName}`);
    console.log(`[Processor] Target URL: ${targetUrl}`);
    console.log(`[Processor] Test specs: ${config.testSpecs.length}`);

    // Create and run orchestrator
    const orchestrator = new Orchestrator({
      onSessionStarted: (sessionId) => {
        updateStoredRunSession(run.id, sessionId).catch((error) => {
          console.warn('[Processor] Failed to persist session ID:', error);
        });
        emitSessionStarted(run.id, sessionId);
      },
    });
    const result = await orchestrator.run({
      maxIterations: run.maxIterations,
      testSpecs: config.testSpecs,
      targetUrl,
    });

    // Update run with results
    if (result.success) {
      await updateStoredRunStatus(run.id, 'completed');
    } else {
      await updateStoredRunStatus(run.id, 'failed');
    }

    // Add patches to run
    for (const patch of result.patches || []) {
      await addStoredRunPatch(run.id, patch);
    }

    // Get updated run
    const updatedRun: Run = {
      ...run,
      status: result.success ? 'completed' : 'failed',
      patches: result.patches || [],
      testResults: result.finalTestResult ? [result.finalTestResult] : [],
      completedAt: new Date(),
      iteration: result.iterations,
    };

    // Record metrics
    await recordRunMetrics(updatedRun);

    // Update monitoring config with last run time
    await recordMonitoringRun(queuedRun.repoId);

    // Complete the queued run
    await completeQueuedRun(queuedRun.id, run.id, result.success);

    // Emit completion event
    sseEmitter.emit({
      type: 'complete',
      timestamp: new Date(),
      runId: run.id,
      data: {
        success: result.success,
        iterations: result.iterations,
        patchCount: result.patches?.length || 0,
      },
    });

    console.log(`[Processor] Completed run ${run.id}: ${result.success ? 'success' : 'failed'}`);
    return updatedRun;
  } catch (error) {
    console.error(`[Processor] Error in run ${run.id}:`, error);

    await updateStoredRunStatus(run.id, 'failed');
    await completeQueuedRun(queuedRun.id, run.id, false);

    // Emit error event
    sseEmitter.emit({
      type: 'error',
      timestamp: new Date(),
      runId: run.id,
      data: {
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });

    // Still record metrics for failed runs
    const failedRun: Run = {
      ...run,
      status: 'failed',
      completedAt: new Date(),
    };
    await recordRunMetrics(failedRun);
    await recordMonitoringRun(queuedRun.repoId);

    return null;
  }
}

async function processAdHocQueuedRun(queuedRun: QueuedRun): Promise<Run | null> {
  const adHocConfig = queuedRun.metadata?.adHoc;
  if (!adHocConfig) {
    return null;
  }

  const runId = adHocConfig.runId;

  try {
    const success = await executeAdHocRun({
      repoId: queuedRun.repoId,
      repoName: queuedRun.repoFullName,
      config: adHocConfig,
    });

    const run = await getRunAsync(runId);
    await completeQueuedRun(queuedRun.id, runId, success);

    if (run) {
      await recordRunMetrics(run);
    }

    return run;
  } catch (error) {
    console.error(`[Processor] Error in ad-hoc run ${runId}:`, error);
    await updateStoredRunStatus(runId, 'failed');
    await completeQueuedRun(queuedRun.id, runId, false);

    return await getRunAsync(runId);
  }
}

/**
 * Process multiple queued runs (for batch processing)
 */
export async function processQueuedRuns(runs: QueuedRun[]): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
}> {
  const results = {
    processed: 0,
    succeeded: 0,
    failed: 0,
  };

  for (const queuedRun of runs) {
    results.processed++;
    const result = await processQueuedRun(queuedRun);
    if (result) {
      results.succeeded++;
    } else {
      results.failed++;
    }
  }

  return results;
}
