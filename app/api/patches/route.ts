import { NextResponse } from 'next/server';
import { getAllPatches } from '@/lib/dashboard/patch-store';

export const dynamic = 'force-dynamic';

// GET /api/patches - List all patches
export async function GET() {
  const allPatches = await getAllPatches();

  return NextResponse.json({
    patches: allPatches.map((p) => ({
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
