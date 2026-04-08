import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isRepoAllowed } from '@/lib/auth/repo-access';
import { createRun, getAllRunsAsync } from '@/lib/dashboard/run-store';
import { enqueueRun } from '@/lib/redis/queue';
import { isRedisAvailable } from '@/lib/redis/client';
import { scheduleQueueProcessing } from '@/lib/queue/dispatcher';
import { executeAdHocRun } from '@/lib/queue/ad-hoc-runner';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getSession();
  const userId = session?.user?.id;

  if (userId === undefined) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));
  const statusFilter = searchParams.get('status') as import('@/lib/types').RunStatus | null;
  const repoIdFilter = searchParams.get('repoId');
  const searchQuery = searchParams.get('search');

  let runs = (await getAllRunsAsync()).filter((run) => run.ownerId === userId);

  if (statusFilter) {
    runs = runs.filter((run) => run.status === statusFilter);
  }
  if (repoIdFilter) {
    runs = runs.filter((run) => run.repoId === repoIdFilter);
  }
  if (searchQuery) {
    const normalizedQuery = searchQuery.toLowerCase();
    runs = runs.filter(
      (run) =>
        run.repoName.toLowerCase().includes(normalizedQuery) ||
        run.id.toLowerCase().includes(normalizedQuery)
    );
  }

  const total = runs.length;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const paginatedRuns = runs.slice(offset, offset + limit);
  const completedRuns = runs.filter((run) => run.status === 'completed');
  const totalPatches = runs.reduce((sum, run) => sum + run.patches.length, 0);
  const totalIterations = runs.reduce((sum, run) => sum + run.iteration, 0);
  const stats = {
    totalRuns: total,
    passRate: total === 0 ? 0 : (completedRuns.length / total) * 100,
    patchesApplied: totalPatches,
    avgIterations: total === 0 ? 0 : totalIterations / total,
  };

  return NextResponse.json({
    runs: paginatedRuns.map((run) => ({
      id: run.id,
      repoId: run.repoId,
      repoName: run.repoName,
      status: run.status,
      currentAgent: run.currentAgent,
      iteration: run.iteration,
      maxIterations: run.maxIterations,
      testsTotal: run.testSpecs.length,
      testsPassed: run.testResults.filter((result) => result.passed).length,
      patchesApplied: run.patches.length,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
    stats,
  });
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    const body = await request.json();
    const {
      repoId,
      repoName,
      testSpecs = [],
      maxIterations = 5,
      targetUrl,
      cloudMode = false,
      sandboxMode = false,
    } = body;

    if (cloudMode && !repoName) {
      return NextResponse.json({ error: 'Repository is required' }, { status: 400 });
    }

    const githubToken = cloudMode ? session?.accessToken || undefined : undefined;

    if (cloudMode && !githubToken) {
      return NextResponse.json({ error: 'GitHub authentication required' }, { status: 401 });
    }

    if ((cloudMode || sandboxMode) && repoName) {
      if (!session?.user) {
        return NextResponse.json({ error: 'GitHub authentication required' }, { status: 401 });
      }

      const repoAllowed = await isRepoAllowed(session, {
        repoId,
        repoFullName: repoName,
      });

      if (!repoAllowed) {
        return NextResponse.json({ error: 'Repository access is not authorized' }, { status: 403 });
      }
    }

    const resolvedRepoId = repoId || (cloudMode ? repoName : 'local');
    const resolvedRepoName = repoName || 'Demo App';
    const run = createRun({
      ownerId: session?.user?.id,
      repoId: resolvedRepoId,
      repoName: resolvedRepoName,
      testSpecs,
      maxIterations,
    });

    const adHocConfig = {
      mode:
        sandboxMode && repoName && githubToken
          ? ('sandbox' as const)
          : cloudMode && repoName && githubToken
            ? ('code' as const)
            : ('local' as const),
      runId: run.id,
      maxIterations,
      targetUrl: targetUrl || undefined,
      testSpecs,
      githubToken,
    };

    const queuedRun = await enqueueRun({
      repoId: resolvedRepoId,
      repoFullName: resolvedRepoName,
      trigger: 'manual',
      metadata: {
        branch: cloudMode ? 'manual-code' : 'manual-local',
        adHoc: adHocConfig,
      },
    });

    const redisAvailable = await isRedisAvailable();

    if (queuedRun) {
      scheduleQueueProcessing();
    } else if (!redisAvailable) {
      void executeAdHocRun({
        repoId: resolvedRepoId,
        repoName: resolvedRepoName,
        config: adHocConfig,
      });
    }

    return NextResponse.json(
      {
        run,
        queued: Boolean(queuedRun),
        queueId: queuedRun?.id,
        queueUnavailable: !queuedRun && !redisAvailable,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error creating run:', error);
    return NextResponse.json({ error: 'Failed to create run' }, { status: 500 });
  }
}
