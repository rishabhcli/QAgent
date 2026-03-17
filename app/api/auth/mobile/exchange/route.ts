import { NextRequest, NextResponse } from 'next/server';

/**
 * Mobile OAuth code exchange endpoint
 * 
 * The mobile app uses expo-auth-session for GitHub OAuth, which returns
 * a code to the app. This endpoint exchanges that code for an access token
 * and returns a session token that the mobile app can use for API requests.
 */
export async function POST(request: NextRequest) {
  void request;

  return NextResponse.json(
    {
      error:
        'Direct mobile code exchange is disabled. Use /api/auth/github to initiate the OAuth flow.'
    },
    { status: 410 }
  );
}
