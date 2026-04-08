import { getGitHubRepos } from '@/lib/auth/github';
import type { GitHubRepo, Session } from '@/lib/types';

function normalizeRepoId(repoId: string | number | null | undefined): string | null {
  if (repoId === null || repoId === undefined) {
    return null;
  }

  const normalized = String(repoId).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeRepoFullName(repoFullName: string | null | undefined): string | null {
  const normalized = repoFullName?.trim();
  return normalized ? normalized.toLowerCase() : null;
}

export async function getAccessibleRepos(session: Session): Promise<GitHubRepo[]> {
  if (session.repos.length > 0) {
    return session.repos;
  }

  if (!session.accessToken) {
    return [];
  }

  try {
    return await getGitHubRepos(session.accessToken);
  } catch {
    return [];
  }
}

export async function getAllowedRepos(session: Session): Promise<GitHubRepo[]> {
  const repos = await getAccessibleRepos(session);
  const selectedRepoIds = session.selectedRepoIds ?? [];

  if (selectedRepoIds.length === 0) {
    return repos;
  }

  return repos.filter((repo) => selectedRepoIds.includes(repo.id));
}

export async function isRepoAllowed(
  session: Session,
  options: { repoId?: string | number | null; repoFullName?: string | null }
): Promise<boolean> {
  const allowedRepos = await getAllowedRepos(session);
  const normalizedRepoId = normalizeRepoId(options.repoId);
  const normalizedRepoFullName = normalizeRepoFullName(options.repoFullName);

  if (!normalizedRepoId && !normalizedRepoFullName) {
    return false;
  }

  return allowedRepos.some((repo) => {
    if (normalizedRepoId && String(repo.id) === normalizedRepoId) {
      return true;
    }

    if (normalizedRepoFullName && repo.fullName.toLowerCase() === normalizedRepoFullName) {
      return true;
    }

    return false;
  });
}
