import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import type { SessionPayload } from '@/lib/types';

const SESSION_COOKIE = 'qagent_session';
const SECRET_KEY = process.env.SESSION_SECRET;
if (!SECRET_KEY && process.env.NODE_ENV === 'production') {
  throw new Error('SESSION_SECRET environment variable is required in production');
}
const key = new TextEncoder().encode(SECRET_KEY || 'default-dev-secret-do-not-use-in-prod');

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Public paths that don't require auth
  const publicPaths = [
    '/_next',
    '/api/auth',
    '/static',
    '/favicon.ico',
  ];

  // Allow public paths
  if (publicPaths.some(p => path.startsWith(p)) || path === '/') {
    return NextResponse.next();
  }

  // Check if it's the dashboard or protected API
  const isProtectedPath = path.startsWith('/dashboard') || (path.startsWith('/api') && !path.startsWith('/api/auth'));

  if (!isProtectedPath) {
    return NextResponse.next();
  }

  const sessionToken = request.cookies.get(SESSION_COOKIE)?.value;

  if (!sessionToken) {
    if (path.startsWith('/api')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    } else {
      return NextResponse.redirect(new URL('/', request.url));
    }
  }

  try {
    await jwtVerify(sessionToken, key, { algorithms: ['HS256'] });
    return NextResponse.next();
  } catch {
    if (path.startsWith('/api')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    } else {
      return NextResponse.redirect(new URL('/', request.url));
    }
  }
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
