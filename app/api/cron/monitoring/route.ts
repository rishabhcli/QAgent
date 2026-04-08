/**
 * Cron Job: Monitoring
 *
 * Runs hourly to check for scheduled monitoring runs and process the queue.
 */

import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
import { getConfigsDueForRun, recordMonitoringRun } from '@/lib/redis/monitoring-config';
import { enqueueRun, dequeueRun, getQueueStatus } from '@/lib/redis/queue';
import { processQueuedRun } from '@/lib/queue/processor';

/**
 * Verify cron request is authorized
 */
function getCronAuthorizationError(request: NextRequest): string | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return 'CRON_SECRET is not configured';
  }

  const authHeader = request.headers.get('authorization');
  const expectedSecret = `Bearer ${cronSecret}`;
  if (authHeader !== expectedSecret) {
    return 'Unauthorized';
  }

  return null;
}

/**
 * GET /api/cron/monitoring
 * Main cron endpoint - runs hourly
 */
export async function GET(request: NextRequest) {
  // Verify authorization
  const authError = getCronAuthorizationError(request);
  if (authError) {
    return NextResponse.json(
      { error: authError },
      { status: authError === 'Unauthorized' ? 401 : 503 }
    );
  }

  const results = {
    scheduled: 0,
    processed: 0,
    errors: [] as string[],
  };

  try {
    // Step 1: Check for scheduled runs that are due
    const dueConfigs = await getConfigsDueForRun();

    for (const config of dueConfigs) {
      try {
        const queuedRun = await enqueueRun({
          repoId: config.repoId,
          repoFullName: config.repoFullName,
          trigger: 'cron',
        });

        if (queuedRun) {
          results.scheduled++;
          // Update the config with next run time
          await recordMonitoringRun(config.repoId);
        }
      } catch (error) {
        const message = `Failed to schedule ${config.repoFullName}: ${error}`;
        console.error(`[Cron] ${message}`);
        results.errors.push(message);
      }
    }

    // Step 2: Process queued runs
    const queueStatus = await getQueueStatus();

    // Process up to 3 runs in this cron execution
    const maxProcessPerCron = 3;
    let processed = 0;

    while (processed < maxProcessPerCron) {
      const queuedRun = await dequeueRun();
      if (!queuedRun) {
        break; // No more runs to process or concurrency limit reached
      }

      try {
        await processQueuedRun(queuedRun);
        results.processed++;
        processed++;
      } catch (error) {
        const message = `Failed to process ${queuedRun.id}: ${error}`;
        console.error(`[Cron] ${message}`);
        results.errors.push(message);
      }
    }

    return NextResponse.json({
      success: true,
      ...results,
    });
  } catch (error) {
    console.error('[Cron] Error in monitoring cron:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Cron job failed',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/cron/monitoring
 * Manual trigger for testing (requires auth)
 */
export async function POST(request: NextRequest) {
  // Verify authorization
  const authError = getCronAuthorizationError(request);
  if (authError) {
    return NextResponse.json(
      { error: authError },
      { status: authError === 'Unauthorized' ? 401 : 503 }
    );
  }

  // Forward to GET handler
  return GET(request);
}
