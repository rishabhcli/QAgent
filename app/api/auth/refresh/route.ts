import { NextRequest, NextResponse } from 'next/server';
import { decrypt, encrypt } from '@/lib/auth/session';
import {
  validateRefreshToken,
  revokeRefreshToken,
  createRefreshToken,
} from '@/lib/auth/token-store';

const SESSION_COOKIE = 'qagent_session';
const REFRESH_COOKIE = 'qagent_refresh';

export async function POST(request: NextRequest) {
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;

  if (!refreshToken) {
    return NextResponse.json({ error: 'No refresh token' }, { status: 401 });
  }

  const tokenData = await validateRefreshToken(refreshToken);
  if (!tokenData) {
    return NextResponse.json(
      { error: 'Invalid or expired refresh token' },
      { status: 401 }
    );
  }

  try {
    const sessionData = JSON.parse(tokenData.sessionData);
    const currentSessionToken = request.cookies.get(SESSION_COOKIE)?.value;
    const selectedRepoIds = currentSessionToken
      ? await decrypt(currentSessionToken)
          .then((payload) => payload.selectedRepoIds ?? [])
          .catch(() => [])
      : [];

    // Rotate: revoke old, create new
    await revokeRefreshToken(refreshToken);
    const newRefreshToken = await createRefreshToken(
      tokenData.userId,
      tokenData.sessionData
    );

    // Issue new JWT
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const sessionToken = await encrypt({
      accessToken: sessionData.accessToken,
      user: sessionData.user,
      selectedRepoIds,
      expiresAt: expiresAt.toISOString(),
    });

    const response = NextResponse.json({
      success: true,
      expiresAt: expiresAt.toISOString(),
    });

    response.cookies.set(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      expires: expiresAt,
      path: '/',
    });

    response.cookies.set(REFRESH_COOKIE, newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60,
      path: '/',
    });

    return response;
  } catch {
    return NextResponse.json({ error: 'Refresh failed' }, { status: 500 });
  }
}
