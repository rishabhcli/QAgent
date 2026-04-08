import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  destroySession: vi.fn(),
  validateSessionToken: vi.fn(),
  updateSelectedRepos: vi.fn(),
  getGitHubRepos: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  getSession: mocks.getSession,
  destroySession: mocks.destroySession,
  validateSessionToken: mocks.validateSessionToken,
  updateSelectedRepos: mocks.updateSelectedRepos,
}));

vi.mock('@/lib/auth/github', () => ({
  getGitHubRepos: mocks.getGitHubRepos,
}));

import { GET as getSessionRoute } from '@/app/api/auth/session/route';

describe('Auth session route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue(null);
    mocks.validateSessionToken.mockResolvedValue({
      user: { id: 42, login: 'owner', name: 'Owner', avatarUrl: 'https://example.com/avatar.png' },
      accessToken: 'token',
      repos: [],
      selectedRepoIds: [123],
    });
    mocks.getGitHubRepos.mockResolvedValue([]);
  });

  it('returns unauthenticated when a bearer token is revoked', async () => {
    mocks.validateSessionToken.mockRejectedValueOnce(new Error('Session revoked'));

    const response = await getSessionRoute(
      new NextRequest('http://localhost/api/auth/session', {
        headers: {
          authorization: 'Bearer revoked-token',
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: false });
  });

  it('returns authenticated when the bearer token is valid', async () => {
    const response = await getSessionRoute(
      new NextRequest('http://localhost/api/auth/session', {
        headers: {
          authorization: 'Bearer valid-token',
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authenticated: true,
      user: expect.objectContaining({ id: 42 }),
      selectedRepoIds: [123],
    });
  });
});
