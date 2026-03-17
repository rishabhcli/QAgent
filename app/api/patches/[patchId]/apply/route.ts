import { NextRequest, NextResponse } from 'next/server';
import { getPatch, updatePatchStatus } from '@/lib/dashboard/patch-store';
import { getSession } from '@/lib/auth/session';
import { createPatchPR } from '@/lib/github/patches';

export const dynamic = 'force-dynamic';

// POST /api/patches/[patchId]/apply - Apply a patch, create a PR, and optionally merge it
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ patchId: string }> }
) {
  const { patchId } = await params;
  const patch = await getPatch(patchId);

  if (!patch) {
    return NextResponse.json({ error: 'Patch not found' }, { status: 404 });
  }

  if (patch.status === 'applied') {
    return NextResponse.json({ error: 'Patch already applied' }, { status: 400 });
  }

  // Get session for GitHub access
  const session = await getSession();

  if (!session || !session.accessToken) {
    return NextResponse.json(
      { error: 'GitHub authentication required' },
      { status: 401 }
    );
  }

  try {
    const body = await request.json().catch(() => ({}));
    const {
      repoOwner,
      repoName,
      autoMerge = true,
      mergeMethod,
    } = body;

    if (!repoOwner || !repoName) {
      return NextResponse.json(
        { error: 'Repository owner and name are required' },
        { status: 400 }
      );
    }

    const repoFullName = `${repoOwner}/${repoName}`;

    // Full workflow: create branch, apply patch, commit, and create PR
    const result = await createPatchPR(
      session.accessToken,
      repoFullName,
      {
        id: patchId,
        diagnosisId: patchId,
        file: patch.file,
        diff: patch.diff,
        description: patch.description,
        metadata: patch.metadata || {
          linesAdded: 0,
          linesRemoved: 0,
          llmModel: 'unknown',
          promptTokens: 0,
        },
      },
      {
        rootCause: patch.diagnosis.rootCause,
        confidence: patch.diagnosis.confidence,
        suggestedFix: patch.description,
      },
      {
        autoMerge,
        mergeMethod,
      }
    );

    // Update patch status. A created but unmerged PR remains pending.
    await updatePatchStatus(
      patchId,
      result.merged ? 'applied' : 'pending',
      {
        prUrl: result.prUrl,
        prNumber: result.prNumber,
        merged: result.merged,
        mergeMethod: result.mergeMethod,
        mergeCommitSha: result.mergeCommitSha,
        mergeError: result.mergeError,
      }
    );

    return NextResponse.json({
      success: true,
      branchName: result.branchName,
      commitSha: result.commitSha,
      prUrl: result.prUrl,
      prNumber: result.prNumber,
      merged: result.merged,
      mergeMethod: result.mergeMethod,
      mergeCommitSha: result.mergeCommitSha,
      mergeError: result.mergeError,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Error applying patch:', error);

    // Check if it's a GitHub API error
    if (error instanceof Error) {
      return NextResponse.json(
        { error: error.message },
        { status: 422 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to apply patch' },
      { status: 500 }
    );
  }
}
