import { NextRequest, NextResponse } from 'next/server';
import { decrypt } from '@/lib/auth/session';
import { blacklistSession, revokeRefreshToken } from '@/lib/auth/token-store';

async function revokeTokens(request: NextRequest): Promise<void> {
  // Blacklist current JWT
  const sessionToken = request.cookies.get('qagent_session')?.value;
  if (sessionToken) {
    try {
      const payload = await decrypt(sessionToken);
      if (payload.jti) {
        await blacklistSession(payload.jti);
      }
    } catch {
      // Token already invalid, nothing to blacklist
    }
  }

  // Revoke refresh token
  const refreshToken = request.cookies.get('qagent_refresh')?.value;
  if (refreshToken) {
    await revokeRefreshToken(refreshToken);
  }
}

function clearCookies(response: NextResponse): void {
  response.cookies.delete('qagent_session');
  response.cookies.delete('qagent_refresh');
  response.cookies.delete('github_oauth_state');
}

export async function GET(request: NextRequest) {
  await revokeTokens(request);
  const response = NextResponse.redirect(new URL('/', request.nextUrl.origin));
  clearCookies(response);
  return response;
}

export async function POST(request: NextRequest) {
  await revokeTokens(request);
  const response = NextResponse.json({ success: true });
  clearCookies(response);
  return response;
}
