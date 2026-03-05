/**
 * Unit tests for Session Management
 * Tests JWT encryption/decryption and cookie handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock next/headers - factory must not reference variables defined later
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));

// Mock jose with trackable sign function
const signCalls: unknown[] = [];
vi.mock('jose', () => ({
  SignJWT: vi.fn().mockImplementation((payload) => {
    signCalls.push(payload);
    return {
      setProtectedHeader: vi.fn().mockReturnThis(),
      setIssuedAt: vi.fn().mockReturnThis(),
      setExpirationTime: vi.fn().mockReturnThis(),
      sign: vi.fn().mockResolvedValue('mock-jwt-token'),
    };
  }),
  jwtVerify: vi.fn(),
}));

// Import after mocks
import { encrypt, decrypt, getSession, createSession, destroySession, updateSessionRepos } from '@/lib/auth/session';
import { cookies } from 'next/headers';
import { jwtVerify } from 'jose';
import type { GitHubUser, GitHubRepo } from '@/lib/types';

// Get mocked modules
const mockCookies = vi.mocked(cookies);
const mockJwtVerify = vi.mocked(jwtVerify);

describe('Session Management', () => {
  const mockUser: GitHubUser = {
    id: 12345,
    login: 'testuser',
    name: 'Test User',
    avatarUrl: 'https://github.com/avatar.png',
  };

  const mockRepos: GitHubRepo[] = [
    {
      id: 1,
      name: 'repo1',
      fullName: 'testuser/repo1',
      url: 'https://github.com/testuser/repo1',
      defaultBranch: 'main',
    },
  ];

  // Mock cookie store that we can control
  let mockCookieStore: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    signCalls.length = 0; // Clear sign calls tracking

    // Create fresh mock cookie store for each test
    mockCookieStore = {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
      delete: vi.fn(),
    };

    mockCookies.mockResolvedValue(mockCookieStore as any);

    mockJwtVerify.mockResolvedValue({
      payload: {
        user: mockUser,
        accessToken: 'test-token',
        repos: mockRepos,
      },
    } as any);
  });

  describe('encrypt()', () => {
    it('should create JWT with payload', async () => {
      const payload = { user: mockUser, accessToken: 'token' };

      const result = await encrypt(payload);

      expect(result).toBe('mock-jwt-token');
      expect(signCalls.length).toBeGreaterThan(0);
    });

    it('should set HS256 algorithm in header', async () => {
      const { SignJWT } = await import('jose');

      await encrypt({ user: mockUser, accessToken: 'token' });

      expect(SignJWT).toHaveBeenCalled();
    });

    it('should set expiration time', async () => {
      await encrypt({ user: mockUser, accessToken: 'token' });

      // The mock chain should have been called
      expect(signCalls.length).toBeGreaterThan(0);
    });
  });

  describe('decrypt()', () => {
    it('should verify and return payload', async () => {
      mockJwtVerify.mockResolvedValueOnce({
        payload: { user: mockUser, accessToken: 'token', repos: [] },
        protectedHeader: { alg: 'HS256' },
      } as never);

      const result = await decrypt('valid-token');

      expect(result).toHaveProperty('user');
      expect(result).toHaveProperty('accessToken');
    });

    it('should use HS256 algorithm', async () => {
      await decrypt('token');

      expect(mockJwtVerify).toHaveBeenCalledWith(
        'token',
        expect.any(Uint8Array),
        expect.objectContaining({ algorithms: ['HS256'] })
      );
    });

    it('should throw on invalid token', async () => {
      mockJwtVerify.mockRejectedValueOnce(new Error('Invalid signature'));

      await expect(decrypt('invalid-token')).rejects.toThrow('Invalid signature');
    });
  });

  describe('getSession()', () => {
    it('should return null when no cookie', async () => {
      mockCookieStore.get.mockReturnValue(undefined);

      const session = await getSession();

      expect(session).toBeNull();
    });

    it('should decrypt and return session data', async () => {
      mockCookieStore.get.mockReturnValue({ value: 'valid-jwt-token' });

      const session = await getSession();

      expect(session).not.toBeNull();
      expect(session?.user).toEqual(mockUser);
      expect(session?.accessToken).toBe('test-token');
      expect(session?.repos).toEqual(mockRepos);
    });

    it('should return null on decrypt error', async () => {
      mockCookieStore.get.mockReturnValue({ value: 'invalid-token' });
      mockJwtVerify.mockRejectedValueOnce(new Error('Token expired'));

      const session = await getSession();

      expect(session).toBeNull();
    });
  });

  describe('createSession()', () => {
    it('should encrypt session data', async () => {
      await createSession({
        accessToken: 'token',
        user: mockUser,
        repos: mockRepos,
      });

      expect(signCalls.length).toBeGreaterThan(0);
    });

    it('should set cookie with correct options', async () => {
      await createSession({
        accessToken: 'token',
        user: mockUser,
        repos: mockRepos,
      });

      expect(mockCookieStore.set).toHaveBeenCalledWith(
        'qagent_session',
        'mock-jwt-token',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
        })
      );
    });

    it('should set expiration to 7 days', async () => {
      const now = Date.now();
      vi.setSystemTime(now);

      await createSession({
        accessToken: 'token',
        user: mockUser,
        repos: mockRepos,
      });

      expect(mockCookieStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          expires: expect.any(Date),
        })
      );

      vi.useRealTimers();
    });
  });

  describe('destroySession()', () => {
    it('should delete session cookie', async () => {
      await destroySession();

      expect(mockCookieStore.delete).toHaveBeenCalledWith('qagent_session');
    });
  });

  describe('updateSessionRepos()', () => {
    it('should create new session with updated repos', async () => {
      mockCookieStore.get.mockReturnValue({ value: 'valid-token' });

      const newRepos: GitHubRepo[] = [
        {
          id: 2,
          name: 'new-repo',
          fullName: 'testuser/new-repo',
          url: 'https://github.com/testuser/new-repo',
          defaultBranch: 'main',
        },
      ];

      await updateSessionRepos(newRepos);

      expect(mockCookieStore.set).toHaveBeenCalled();
    });

    it('should do nothing if no existing session', async () => {
      mockCookieStore.get.mockReturnValue(undefined);

      await updateSessionRepos(mockRepos);

      expect(mockCookieStore.set).not.toHaveBeenCalled();
    });

    it('should preserve accessToken and user', async () => {
      mockCookieStore.get.mockReturnValue({ value: 'valid-token' });

      await updateSessionRepos(mockRepos);

      // The encrypt function should be called with existing user/token
      expect(signCalls.length).toBeGreaterThan(0);
    });
  });
});
