'use client';

import useSWR from 'swr';
import type { GitHubRepo, GitHubUser } from '@/lib/types';

interface SessionResponse {
  authenticated: boolean;
  user?: GitHubUser;
  repos?: GitHubRepo[];
  selectedRepoIds?: number[];
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('Failed to fetch session');
  }
  return res.json();
};

export function useSession() {
  const { data, error, isLoading, mutate } = useSWR<SessionResponse>(
    '/api/auth/session',
    fetcher,
    {
      dedupingInterval: 30000,
    }
  );

  const isAuthenticated = Boolean(data?.authenticated && data?.user);
  const repos = data?.repos ?? [];
  const selectedRepoIds = data?.selectedRepoIds ?? [];
  const selectedRepos =
    selectedRepoIds.length > 0
      ? repos.filter((repo) => selectedRepoIds.includes(repo.id))
      : repos;
  const primaryRepo = selectedRepos[0] ?? repos[0] ?? null;

  const disconnect = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    await mutate(undefined, { revalidate: true });
  };

  return {
    isAuthenticated,
    user: data?.user ?? null,
    repos,
    selectedRepoIds,
    selectedRepos,
    primaryRepo,
    isLoading,
    error,
    mutate,
    disconnect,
  };
}
