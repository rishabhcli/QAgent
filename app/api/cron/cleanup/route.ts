/**
 * Cron Job: Cleanup
 *
 * Runs daily to clean up expired runs and stale processing entries.
 */

import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
import { cleanupExpiredRuns } from '@/lib/redis/runs-store';
import { cleanupStaleProcessing } from '@/lib/redis/queue';

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
 * GET /api/cron/cleanup
 * Daily cleanup cron
 */
export async function GET(request: NextRequest) {
  const authError = getCronAuthorizationError(request);
  if (authError) {
    return NextResponse.json(
      { error: authError },
      { status: authError === 'Unauthorized' ? 401 : 503 }
    );
  }

  const results = {
    expiredRuns: 0,
    staleProcessing: 0,
  };

  try {
    // Clean up expired runs
    results.expiredRuns = await cleanupExpiredRuns();

    // Clean up stale processing entries
    results.staleProcessing = await cleanupStaleProcessing();

    return NextResponse.json({
      success: true,
      ...results,
    });
  } catch (error) {
    console.error('[Cleanup] Error in cleanup cron:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Cleanup job failed',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
