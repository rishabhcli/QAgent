import { NextRequest, NextResponse } from 'next/server';
import { getSession, destroySession, decrypt, updateSelectedRepos } from '@/lib/auth/session';
import { getGitHubRepos } from '@/lib/auth/github';

export async function GET(request: NextRequest) {
  let session = await getSession();

  if (!session) {
    const authHeader = request.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice('Bearer '.length);
      try {
        const payload = await decrypt(token);
        session = {
          user: payload.user,
          accessToken: payload.accessToken,
          repos: payload.repos ?? [],
          selectedRepoIds: payload.selectedRepoIds ?? [],
        };
      } catch {
        session = null;
      }
    }
  }

  if (!session) {
    return NextResponse.json({ authenticated: false });
  }

  // Fetch repos dynamically if we have an access token
  // (repos are not stored in session to keep cookie small)
  let repos = session.repos || [];
  if (session.accessToken && repos.length === 0) {
    try {
      repos = await getGitHubRepos(session.accessToken);
    } catch (error) {
      console.error('Failed to fetch repos:', error);
    }
  }

  return NextResponse.json({
    authenticated: true,
    user: session.user,
    repos,
    selectedRepoIds: session.selectedRepoIds ?? [],
  });
}

export async function PATCH(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const selectedRepoIds = Array.isArray(body.selectedRepoIds)
      ? body.selectedRepoIds
          .map((value: unknown) => Number(value))
          .filter((value: number) => Number.isInteger(value))
      : null;

    if (!selectedRepoIds) {
      return NextResponse.json(
        { error: 'selectedRepoIds must be an array of numeric repository IDs' },
        { status: 400 }
      );
    }

    await updateSelectedRepos(selectedRepoIds);

    return NextResponse.json({ success: true, selectedRepoIds });
  } catch {
    return NextResponse.json({ error: 'Failed to update session' }, { status: 500 });
  }
}

export async function DELETE() {
  await destroySession();
  return NextResponse.json({ success: true });
}
