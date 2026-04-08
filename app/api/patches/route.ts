import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getAllPatches } from '@/lib/dashboard/patch-store';

export const dynamic = 'force-dynamic';

// GET /api/patches - List all patches
export async function GET() {
  const session = await getSession();
  const userId = session?.user?.id;

  if (userId === undefined) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const allPatches = await getAllPatches();
  const visiblePatches = allPatches.filter((patch) => patch.ownerId === userId);

  return NextResponse.json({
    patches: visiblePatches.map((p) => ({
      id: p.id,
      file: p.file,
      description: p.description,
      diff: p.diff,
      linesAdded: p.metadata.linesAdded,
      linesRemoved: p.metadata.linesRemoved,
      status: p.status,
      runId: p.runId,
      createdAt: p.createdAt,
      prUrl: p.prUrl,
      prNumber: p.prNumber,
      merged: p.merged,
      mergeMethod: p.mergeMethod,
      mergeCommitSha: p.mergeCommitSha,
      mergeError: p.mergeError,
      diagnosis: p.diagnosis,
    })),
  });
}
