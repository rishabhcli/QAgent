import { NextRequest, NextResponse } from 'next/server';
import { getRunAsync } from '@/lib/dashboard/run-store';
import { getSession } from '@/lib/auth/session';
import Browserbase from '@browserbasehq/sdk';

// GET /api/runs/[runId]/session - Get Browserbase session debug URLs
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const session = await getSession();
  const run = await getRunAsync(runId);

  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  const requesterId = session?.user?.id;
  if (requesterId === undefined || run.ownerId !== requesterId) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  if (!run.sessionId) {
    return NextResponse.json({
      hasSession: false,
      message: 'No active browser session',
    });
  }

  try {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Browserbase API key not configured' },
        { status: 500 }
      );
    }

    const browserbase = new Browserbase({ apiKey });

    // Get session debug info using Browserbase SDK
    const sessionInfo = await browserbase.sessions.debug(run.sessionId);

    return NextResponse.json({
      hasSession: true,
      sessionId: run.sessionId,
      debuggerUrl: sessionInfo.debuggerUrl,
      debuggerFullscreenUrl: sessionInfo.debuggerFullscreenUrl,
      wsUrl: sessionInfo.wsUrl,
      isActive: run.status === 'running',
    });
  } catch (error) {
    // Session may have expired or been closed
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({
      hasSession: false,
      sessionId: run.sessionId,
      error: message,
      message: 'Session may have expired',
    });
  }
}
