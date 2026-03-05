import { NextRequest, NextResponse } from 'next/server';
import { getSession, destroySession, decrypt } from '@/lib/auth/session';
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
  });
}

export async function DELETE() {
  await destroySession();
  return NextResponse.json({ success: true });
}
