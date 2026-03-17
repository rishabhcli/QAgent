import { NextRequest, NextResponse } from 'next/server';
import { getRunAsync, cancelRun, deleteRun, updateRunStatus } from '@/lib/dashboard/run-store';
import { emitRunError } from '@/lib/dashboard/sse-emitter';
import { cancelQueuedRunByActualRunId } from '@/lib/redis/queue';

// GET /api/runs/[runId] - Get run details
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;

  // Use async version to check Redis fallback
  const run = await getRunAsync(runId);

  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  return NextResponse.json({ run });
}

// DELETE /api/runs/[runId] - Cancel/delete a run
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const run = await getRunAsync(runId);

  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  // If running, abort and mark as cancelled
  if (run.status === 'running' || run.status === 'pending') {
    const cancelled = cancelRun(runId) || await cancelQueuedRunByActualRunId(runId);
    if (!cancelled) {
      return NextResponse.json({ error: 'Run could not be cancelled' }, { status: 409 });
    }
    updateRunStatus(runId, 'cancelled');
    emitRunError(runId, 'Run cancelled by user');
    return NextResponse.json({ message: 'Run cancelled' });
  }

  // If completed, delete the record
  deleteRun(runId);
  return NextResponse.json({ message: 'Run deleted' });
}
