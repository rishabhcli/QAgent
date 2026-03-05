import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForToken, getGitHubUser } from '@/lib/auth/github';
import { encrypt } from '@/lib/auth/session';
import { createRefreshToken } from '@/lib/auth/token-store';

/**
 * Mobile OAuth code exchange endpoint
 * 
 * The mobile app uses expo-auth-session for GitHub OAuth, which returns
 * a code to the app. This endpoint exchanges that code for an access token
 * and returns a session token that the mobile app can use for API requests.
 */
export async function POST(request: NextRequest) {
  try {
    const { code, redirectUri } = await request.json();

    if (!code) {
      return NextResponse.json(
        { error: 'Missing authorization code' },
        { status: 400 }
      );
    }

    // Exchange code for GitHub access token
    const accessToken = await exchangeCodeForToken(code);
    
    if (!accessToken) {
      return NextResponse.json(
        { error: 'Failed to exchange code for token' },
        { status: 400 }
      );
    }

    // Get user info
    const user = await getGitHubUser(accessToken);
    
    if (!user) {
      return NextResponse.json(
        { error: 'Failed to get user info' },
        { status: 400 }
      );
    }

    // Create session token (24h) and refresh token (7d)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const sessionToken = await encrypt({
      accessToken,
      user,
      expiresAt: expiresAt.toISOString(),
    });
    const refreshToken = await createRefreshToken(
      user.id,
      JSON.stringify({ accessToken, user })
    );

    return NextResponse.json({
      token: sessionToken,
      refreshToken,
      user: {
        id: user.id,
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    console.error('Mobile OAuth exchange error:', error);
    return NextResponse.json(
      { error: 'Authentication failed' },
      { status: 500 }
    );
  }
}
