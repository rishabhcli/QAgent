/**
 * Unit tests for GitHub OAuth Authentication
 * Tests OAuth URL generation, token exchange, and user/repo fetching
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Set env vars BEFORE importing the module
process.env.GITHUB_CLIENT_ID = 'test-client-id';
process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after setting env vars
import {
  getAppOrigin,
  getGitHubAuthUrl,
  getGitHubCallbackUrl,
  isGitHubOAuthConfigured,
  exchangeCodeForToken,
  getGitHubUser,
  getGitHubRepos,
  createPullRequest,
} from '@/lib/auth/github';

describe('GitHub Auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up
  });

  describe('getGitHubAuthUrl()', () => {
    it('should construct correct OAuth URL', () => {
      const url = getGitHubAuthUrl('random-state', 'http://localhost:3000');

      expect(url).toContain('https://github.com/login/oauth/authorize');
      expect(url).toContain('client_id=');
    });

    it('should include all required parameters', () => {
      const url = getGitHubAuthUrl('test-state', 'http://localhost:3000');

      expect(url).toContain('client_id=');
      expect(url).toContain('redirect_uri=');
      expect(url).toContain('scope=');
      expect(url).toContain('state=');
    });

    it('should encode state parameter', () => {
      const url = getGitHubAuthUrl('state-with-special=chars&more', 'http://localhost:3000');

      // State should be URL encoded
      expect(url).toContain('state=');
      expect(url).not.toContain('state=state-with-special=chars&more');
    });

    it('should include repo and read:user scope', () => {
      const url = getGitHubAuthUrl('state', 'http://localhost:3000');

      expect(url).toContain('scope=repo');
      expect(url).toContain('read%3Auser');
    });

    it('should use correct redirect URI', () => {
      const url = getGitHubAuthUrl('state', 'http://localhost:3000');

      expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fauth%2Fgithub%2Fcallback');
    });
  });

  describe('origin helpers', () => {
    it('should normalize the provided origin', () => {
      const previousAppUrl = process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.NEXT_PUBLIC_APP_URL;

      try {
        expect(getAppOrigin('http://localhost:3000/dashboard')).toBe('http://localhost:3000');
      } finally {
        process.env.NEXT_PUBLIC_APP_URL = previousAppUrl;
      }
    });

    it('should build the callback URL from the provided origin', () => {
      const previousAppUrl = process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.NEXT_PUBLIC_APP_URL;

      try {
        expect(getGitHubCallbackUrl('https://qagent.dev')).toBe(
          'https://qagent.dev/api/auth/github/callback'
        );
      } finally {
        process.env.NEXT_PUBLIC_APP_URL = previousAppUrl;
      }
    });

    it('should report OAuth as configured when both GitHub credentials are present', () => {
      expect(isGitHubOAuthConfigured()).toBe(true);
    });

    it('should prefer NEXT_PUBLIC_APP_URL when it is configured', () => {
      expect(getAppOrigin('https://qagent.dev')).toBe('http://localhost:3000');
    });
  });

  describe('exchangeCodeForToken()', () => {
    it('should exchange code for access token', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'test-access-token' }),
      });

      const token = await exchangeCodeForToken('auth-code');

      expect(token).toBe('test-access-token');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://github.com/login/oauth/access_token',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Accept: 'application/json',
          }),
        })
      );
    });

    it('should throw on error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            error: 'bad_verification_code',
            error_description: 'The code has expired',
          }),
      });

      await expect(exchangeCodeForToken('expired-code')).rejects.toThrow('The code has expired');
    });

    it('should include client credentials in request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'token' }),
      });

      await exchangeCodeForToken('code');

      // Verify the request body structure includes client_id and client_secret
      expect(mockFetch).toHaveBeenCalledWith(
        'https://github.com/login/oauth/access_token',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('client_id'),
        })
      );
    });

    it('should include an explicit redirect URI when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'token' }),
      });

      await exchangeCodeForToken({
        code: 'code',
        redirectUri: 'http://localhost:3000/api/auth/github/callback',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://github.com/login/oauth/access_token',
        expect.objectContaining({
          body: expect.stringContaining('"redirect_uri":"http://localhost:3000/api/auth/github/callback"'),
        })
      );
    });

    it('should handle missing error_description', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            error: 'unknown_error',
          }),
      });

      await expect(exchangeCodeForToken('code')).rejects.toThrow(
        'Failed to exchange code for token'
      );
    });
  });

  describe('getGitHubUser()', () => {
    it('should fetch and return user info', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 12345,
            login: 'testuser',
            name: 'Test User',
            avatar_url: 'https://github.com/avatar.png',
          }),
      });

      const user = await getGitHubUser('access-token');

      expect(user.id).toBe(12345);
      expect(user.login).toBe('testuser');
      expect(user.name).toBe('Test User');
      expect(user.avatarUrl).toBe('https://github.com/avatar.png');
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      await expect(getGitHubUser('invalid-token')).rejects.toThrow('Failed to fetch GitHub user');
    });

    it('should include authorization header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 1,
            login: 'user',
            name: 'User',
            avatar_url: 'url',
          }),
      });

      await getGitHubUser('my-token');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/user',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer my-token',
          }),
        })
      );
    });
  });

  describe('getGitHubRepos()', () => {
    it('should fetch and map repositories', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              id: 1,
              name: 'repo1',
              full_name: 'user/repo1',
              html_url: 'https://github.com/user/repo1',
              default_branch: 'main',
            },
            {
              id: 2,
              name: 'repo2',
              full_name: 'user/repo2',
              html_url: 'https://github.com/user/repo2',
              default_branch: 'master',
            },
          ]),
      });

      const repos = await getGitHubRepos('token');

      expect(repos).toHaveLength(2);
      expect(repos[0].name).toBe('repo1');
      expect(repos[0].fullName).toBe('user/repo1');
      expect(repos[1].defaultBranch).toBe('master');
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
      });

      await expect(getGitHubRepos('token')).rejects.toThrow('Failed to fetch GitHub repos');
    });

    it('should handle empty repo list', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const repos = await getGitHubRepos('token');

      expect(repos).toHaveLength(0);
    });

    it('should use correct API endpoint with pagination', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      await getGitHubRepos('token');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('per_page=100'),
        expect.any(Object)
      );
    });
  });

  describe('createPullRequest()', () => {
    it('should create PR via API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            html_url: 'https://github.com/owner/repo/pull/42',
            number: 42,
          }),
      });

      const result = await createPullRequest('token', 'owner', 'repo', {
        title: 'Fix bug',
        body: 'This fixes the bug',
        head: 'feature-branch',
        base: 'main',
      });

      expect(result.url).toBe('https://github.com/owner/repo/pull/42');
      expect(result.number).toBe(42);
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () =>
          Promise.resolve({
            message: 'Validation Failed',
          }),
      });

      await expect(
        createPullRequest('token', 'owner', 'repo', {
          title: 'PR',
          body: 'Body',
          head: 'head',
          base: 'base',
        })
      ).rejects.toThrow('Validation Failed');
    });
  });
});
