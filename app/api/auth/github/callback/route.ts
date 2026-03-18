import { NextRequest, NextResponse } from 'next/server';
import {
  exchangeCodeForToken,
  getGitHubCallbackUrl,
  getGitHubUser,
  isGitHubOAuthConfigured,
} from '@/lib/auth/github';
import { encrypt } from '@/lib/auth/session';
import { createRefreshToken } from '@/lib/auth/token-store';

const SESSION_COOKIE = 'qagent_session';
const MOBILE_REDIRECT_COOKIE = 'github_oauth_redirect';
const OAUTH_NOT_CONFIGURED_ERROR = 'github_oauth_not_configured';

function getMobileRedirect(request: NextRequest): URL | null {
  const rawRedirect = request.cookies.get(MOBILE_REDIRECT_COOKIE)?.value;
  if (!rawRedirect) return null;
  try {
    const redirectUrl = new URL(rawRedirect);
    if (redirectUrl.protocol !== 'qagent:') return null;
    return redirectUrl;
  } catch {
    return null;
  }
}

function getAppRedirect(request: NextRequest, pathname: string, params?: Record<string, string>): URL {
  const url = new URL(pathname, request.nextUrl.origin);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  return url;
}

function clearOAuthCookies(response: NextResponse): void {
  response.cookies.set('github_oauth_state', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: new Date(0),
    path: '/',
  });

  response.cookies.set(MOBILE_REDIRECT_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: new Date(0),
    path: '/',
  });
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const storedState = request.cookies.get('github_oauth_state')?.value;
  const mobileRedirect = getMobileRedirect(request);

  if (!isGitHubOAuthConfigured()) {
    if (mobileRedirect) {
      mobileRedirect.searchParams.set('error', OAUTH_NOT_CONFIGURED_ERROR);
      const response = NextResponse.redirect(mobileRedirect.toString());
      clearOAuthCookies(response);
      return response;
    }

    return NextResponse.redirect(
      getAppRedirect(request, '/', { error: OAUTH_NOT_CONFIGURED_ERROR })
    );
  }

  // Verify state to prevent CSRF
  if (!state || state !== storedState) {
    if (mobileRedirect) {
      mobileRedirect.searchParams.set('error', 'invalid_state');
      const response = NextResponse.redirect(mobileRedirect.toString());
      clearOAuthCookies(response);
      return response;
    }
    return NextResponse.redirect(getAppRedirect(request, '/', { error: 'invalid_state' }));
  }

  if (!code) {
    if (mobileRedirect) {
      mobileRedirect.searchParams.set('error', 'no_code');
      const response = NextResponse.redirect(mobileRedirect.toString());
      clearOAuthCookies(response);
      return response;
    }
    return NextResponse.redirect(getAppRedirect(request, '/', { error: 'no_code' }));
  }

  try {
    const accessToken = await exchangeCodeForToken({
      code,
      redirectUri: getGitHubCallbackUrl(request.nextUrl.origin),
    });
    const user = await getGitHubUser(accessToken);

    // Create session token - ONLY store user and accessToken, NOT repos
    // This keeps the cookie small (under 4KB limit)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const sessionToken = await encrypt({ accessToken, user, expiresAt: expiresAt.toISOString() });
    const refreshToken = await createRefreshToken(
      user.id,
      JSON.stringify({ accessToken, user })
    );

    if (mobileRedirect) {
      mobileRedirect.searchParams.set('token', sessionToken);
      const response = NextResponse.redirect(mobileRedirect.toString());
      clearOAuthCookies(response);
      return response;
    }

    const redirectUrl = getAppRedirect(request, '/dashboard', { connected: 'true' });
    const response = NextResponse.redirect(redirectUrl);

    response.cookies.set(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      expires: expiresAt,
      path: '/',
    });

    response.cookies.set('qagent_refresh', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60,
      path: '/',
    });

    clearOAuthCookies(response);

    return response;
  } catch (error) {
    console.error('GitHub OAuth error:', error);
    if (mobileRedirect) {
      mobileRedirect.searchParams.set('error', 'oauth_failed');
      const response = NextResponse.redirect(mobileRedirect.toString());
      clearOAuthCookies(response);
      return response;
    }
    return NextResponse.redirect(getAppRedirect(request, '/', { error: 'oauth_failed' }));
  }
}
