import type { GitHubUser, GitHubRepo } from '@/lib/types';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

export function getGitHubAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${APP_URL}/api/auth/github/callback`,
    scope: 'repo read:user',
    state,
  });

  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(
  params: string | { code: string; redirectUri?: string; codeVerifier?: string; state?: string }
): Promise<string> {
  const requestParams =
    typeof params === 'string'
      ? { code: params }
      : params;

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code: requestParams.code,
      ...(requestParams.redirectUri ? { redirect_uri: requestParams.redirectUri } : {}),
      ...(requestParams.codeVerifier ? { code_verifier: requestParams.codeVerifier } : {}),
      ...(requestParams.state ? { state: requestParams.state } : {}),
    }),
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error_description || 'Failed to exchange code for token');
  }

  return data.access_token;
}

export async function getGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch GitHub user');
  }

  const data = await response.json();

  return {
    id: data.id,
    login: data.login,
    name: data.name,
    avatarUrl: data.avatar_url,
  };
}

export async function getGitHubRepos(accessToken: string): Promise<GitHubRepo[]> {
  const response = await fetch('https://api.github.com/user/repos?sort=updated&per_page=100', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch GitHub repos');
  }

  const data = await response.json();

  return data.map((repo: Record<string, unknown>) => ({
    id: repo.id as number,
    name: repo.name as string,
    fullName: repo.full_name as string,
    url: repo.html_url as string,
    defaultBranch: repo.default_branch as string,
  }));
}

export async function createPullRequest(
  accessToken: string,
  owner: string,
  repo: string,
  options: {
    title: string;
    body: string;
    head: string;
    base: string;
  }
): Promise<{ url: string; number: number }> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to create pull request');
  }

  const data = await response.json();

  return {
    url: data.html_url,
    number: data.number,
  };
}
