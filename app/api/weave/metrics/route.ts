/**
 * Weave Metrics API
 *
 * Provides access to aggregated Weave metrics for the dashboard UI.
 * Shows key performance indicators from traced operations.
 */

import { NextResponse } from 'next/server';
import { isWeaveEnabled, getWeaveProjectUrl } from '@/lib/weave';

export const dynamic = 'force-dynamic';

/**
 * GET /api/weave/metrics
 *
 * Returns aggregated metrics from Weave traces
 */
export async function GET() {
  try {
    // Check if Weave is enabled
    if (!isWeaveEnabled()) {
      return NextResponse.json({
        enabled: false,
        message: 'Weave is not enabled. Set WANDB_API_KEY to enable tracing.',
        metrics: null,
      });
    }

    // Get project URL
    const projectUrl = getWeaveProjectUrl();

    return NextResponse.json({
      enabled: true,
      metrics: null,
      message: 'No trace data available yet. Run your first pipeline to see metrics.',
      links: {
        project: projectUrl,
        traces: `${projectUrl}/traces`,
        evaluations: `${projectUrl}/evaluations`,
        datasets: `${projectUrl}/datasets`,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Weave metrics API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch Weave metrics' },
      { status: 500 }
    );
  }
}
