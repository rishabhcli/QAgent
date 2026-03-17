import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import type { Session, GitHubUser, GitHubRepo, SessionPayload } from '@/lib/types';
import { getSessionSecret } from '@/lib/auth/session-secret';

const SESSION_COOKIE = 'qagent_session';
const key = new TextEncoder().encode(getSessionSecret());

export async function encrypt(payload: SessionPayload): Promise<string> {
  const jti = payload.jti || crypto.randomUUID();
  return await new SignJWT({ ...payload, jti } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(key);
}

export async function decrypt(input: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(input, key, {
    algorithms: ['HS256'],
  });
  return payload as unknown as SessionPayload;
}

export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE)?.value;

  if (!sessionToken) return null;

  try {
    const payload = await decrypt(sessionToken);
    return {
      user: payload.user,
      accessToken: payload.accessToken,
      repos: payload.repos ?? [],
    };
  } catch {
    return null;
  }
}

export async function createSession(data: {
  accessToken: string;
  user: GitHubUser;
  repos: GitHubRepo[];
}): Promise<void> {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const session = await encrypt({ ...data, expiresAt: expiresAt.toISOString() });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: expiresAt,
    path: '/',
  });
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function updateSessionRepos(repos: GitHubRepo[]): Promise<void> {
  const session = await getSession();
  if (!session || !session.user || !session.accessToken) return;

  // We need to create a new session with updated repos
  await createSession({
    accessToken: session.accessToken,
    user: session.user,
    repos,
  });
}
