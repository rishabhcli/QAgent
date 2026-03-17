import { NextRequest, NextResponse } from 'next/server';
import { createRun } from '@/lib/dashboard/run-store';
import { getSession } from '@/lib/auth/session';
import { enqueueRun } from '@/lib/redis/queue';
import { isRedisAvailable } from '@/lib/redis/client';
import { scheduleQueueProcessing } from '@/lib/queue/dispatcher';
import { executeAdHocRun } from '@/lib/queue/ad-hoc-runner';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { repoId, repoName, maxIterations = 5 } = body;

    if (!repoName) {
      return NextResponse.json({ error: 'Repository name is required' }, { status: 400 });
    }

    const session = await getSession();
    if (!session?.accessToken) {
      return NextResponse.json({ error: 'GitHub authentication required' }, { status: 401 });
    }

    const run = createRun({
      ownerId: session?.user?.id,
      repoId: repoId || repoName,
      repoName,
      testSpecs: [],
      maxIterations,
    });

    const adHocConfig = {
      mode: 'analyze' as const,
      runId: run.id,
      maxIterations,
      githubToken: session.accessToken,
    };

    const queuedRun = await enqueueRun({
      repoId: repoId || repoName,
      repoFullName: repoName,
      trigger: 'manual',
      metadata: {
        branch: 'analysis',
        adHoc: adHocConfig,
      },
    });

    const redisAvailable = await isRedisAvailable();

    if (queuedRun) {
      scheduleQueueProcessing();
    } else if (!redisAvailable) {
      void executeAdHocRun({
        repoId: repoId || repoName,
        repoName,
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
    console.error('Error creating analysis run:', error);
    return NextResponse.json({ error: 'Failed to create analysis run' }, { status: 500 });
  }
}
