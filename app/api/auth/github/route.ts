import { NextRequest, NextResponse } from 'next/server';
import { getAppOrigin, getGitHubAuthUrl, isGitHubOAuthConfigured } from '@/lib/auth/github';

const MOBILE_REDIRECT_COOKIE = 'github_oauth_redirect';
const OAUTH_NOT_CONFIGURED_ERROR = 'github_oauth_not_configured';

function getMobileRedirect(rawRedirect: string | null): URL | null {
  if (!rawRedirect) {
    return null;
  }

  try {
    const redirectUrl = new URL(rawRedirect);
    if (redirectUrl.protocol !== 'qagent:') {
      return null;
    }
    return redirectUrl;
  } catch {
    return null;
  }
}

function getAppErrorRedirect(request: NextRequest, error: string): URL {
  const url = new URL('/', request.nextUrl.origin);
  url.searchParams.set('error', error);
  return url;
}

function getRequestOrigin(request: NextRequest): string {
  const protocol = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(/:$/, '');
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || request.nextUrl.host;
  return `${protocol}://${host}`;
}

export async function GET(request: NextRequest) {
  const redirectParam = request.nextUrl.searchParams.get('redirect');
  const mobileRedirect = getMobileRedirect(redirectParam);
  const requestOrigin = getRequestOrigin(request);
  const appOrigin = getAppOrigin(requestOrigin);

  if (requestOrigin !== appOrigin) {
    return NextResponse.redirect(new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, appOrigin));
  }

  if (!isGitHubOAuthConfigured()) {
    if (mobileRedirect) {
      mobileRedirect.searchParams.set('error', OAUTH_NOT_CONFIGURED_ERROR);
      return NextResponse.redirect(mobileRedirect.toString());
    }

    return NextResponse.redirect(getAppErrorRedirect(request, OAUTH_NOT_CONFIGURED_ERROR));
  }

  // Generate a random state for CSRF protection
  const state = crypto.randomUUID();

  // Store state in a cookie for verification in callback
  const response = NextResponse.redirect(getGitHubAuthUrl(state, appOrigin));
  response.cookies.set('github_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600, // 10 minutes
    path: '/',
  });

  if (mobileRedirect) {
    response.cookies.set(MOBILE_REDIRECT_COOKIE, mobileRedirect.toString(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600, // 10 minutes
      path: '/',
    });
  }

  return response;
}
