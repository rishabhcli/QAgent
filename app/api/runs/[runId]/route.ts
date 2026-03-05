import { NextRequest, NextResponse } from 'next/server';
import { getRunAsync, cancelRun, deleteRun } from '@/lib/dashboard/run-store';
import { emitRunError } from '@/lib/dashboard/sse-emitter';

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
    cancelRun(runId);
    emitRunError(runId, 'Run cancelled by user');
    return NextResponse.json({ message: 'Run cancelled' });
  }

  // If completed, delete the record
  deleteRun(runId);
  return NextResponse.json({ message: 'Run deleted' });
}
