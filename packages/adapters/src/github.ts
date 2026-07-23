import { Octokit } from '@octokit/rest';
import type { GitRepository, Worktree } from './git.js';

export interface PublicationResult {
  url: string;
  number: number;
  state: 'open' | 'merged' | 'blocked' | 'conflict';
  autoMergeEnabled: boolean;
  mergeCommitSha: string | null;
  detail?: string;
}

export interface PullRequestWaitResult {
  state: 'open' | 'merged' | 'conflict';
  mergeCommitSha: string | null;
}

export interface GitHubRepositoryRef {
  owner: string;
  repo: string;
}

export interface GitHubApi {
  rest: {
    pulls: {
      create(options: Record<string, unknown>): Promise<{
        data: { html_url: string; number: number };
      }>;
      get(options: Record<string, unknown>): Promise<{
        data: {
          merged: boolean;
          state: string;
          mergeable?: boolean | null;
          mergeable_state?: string;
          merge_commit_sha?: string | null;
        };
      }>;
    };
  };
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export function parseGitHubRemote(remote: string): GitHubRepositoryRef | null {
  const ssh = remote.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  const https = remote.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  const match = ssh ?? https;
  return match?.[1] && match[2] ? { owner: match[1], repo: match[2].replace(/\.git$/, '') } : null;
}

export class GitHubPublisher {
  private readonly octokit: GitHubApi;
  private readonly pollIntervalMs: number;
  private readonly waitTimeoutMs: number;

  constructor(
    token: string,
    private readonly gitRepository: GitRepository,
    options: { client?: GitHubApi; pollIntervalMs?: number; waitTimeoutMs?: number } = {}
  ) {
    this.octokit =
      options.client ??
      (new Octokit({ auth: token, userAgent: 'qagent/0.2.0-beta.1' }) as unknown as GitHubApi);
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.waitTimeoutMs = options.waitTimeoutMs ?? 15 * 60_000;
  }

  async publish(options: {
    repository: GitHubRepositoryRef;
    worktree: Worktree;
    baseBranch: string;
    title: string;
    body: string;
    autoMerge: boolean;
    highRisk: boolean;
    mergeMethod: 'squash' | 'merge' | 'rebase';
    signal?: AbortSignal;
  }): Promise<PublicationResult> {
    await this.gitRepository.push(options.worktree);
    const pull = await this.octokit.rest.pulls.create({
      ...options.repository,
      title: options.title,
      head: options.worktree.branch,
      base: options.baseBranch,
      body: options.body,
      draft: false,
    });
    const base: PublicationResult = {
      url: pull.data.html_url,
      number: pull.data.number,
      state: 'open',
      autoMergeEnabled: false,
      mergeCommitSha: null,
    };

    if (!options.autoMerge || options.highRisk) {
      return {
        ...base,
        state: options.highRisk ? 'blocked' : 'open',
        detail: options.highRisk
          ? 'High-risk files require human review; the pull request was not auto-merged.'
          : 'Auto-merge is disabled by project policy.',
      };
    }

    try {
      const node = await this.octokit.graphql<{
        repository: { pullRequest: { id: string } | null };
      }>(
        `query QAgentPullRequest($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } }
        }`,
        { ...options.repository, number: pull.data.number }
      );
      if (!node.repository.pullRequest) throw new Error('Pull request node was not found');
      await this.octokit.graphql(
        `mutation QAgentEnableAutoMerge($id: ID!, $method: PullRequestMergeMethod!) {
          enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $method}) {
            pullRequest { autoMergeRequest { enabledAt } }
          }
        }`,
        {
          id: node.repository.pullRequest.id,
          method: options.mergeMethod.toUpperCase(),
        }
      );
    } catch (error) {
      return {
        ...base,
        detail: `GitHub did not enable auto-merge: ${messageFrom(error)}`,
      };
    }

    const result = await this.waitForPull(options.repository, pull.data.number, options.signal);
    return {
      ...base,
      state: result.state,
      autoMergeEnabled: true,
      mergeCommitSha: result.mergeCommitSha,
      detail:
        result.state === 'merged'
          ? 'GitHub merged the pull request after repository requirements passed.'
          : result.state === 'conflict'
            ? 'GitHub reports a merge conflict; QAgent will rebase and reverify once.'
            : 'Auto-merge is enabled and waiting for repository requirements.',
    };
  }

  async waitForPull(
    repository: GitHubRepositoryRef,
    pullNumber: number,
    signal?: AbortSignal
  ): Promise<PullRequestWaitResult> {
    const deadline = Date.now() + this.waitTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason;
      const pull = await this.octokit.rest.pulls.get({ ...repository, pull_number: pullNumber });
      if (pull.data.merged) {
        return { state: 'merged', mergeCommitSha: pull.data.merge_commit_sha ?? null };
      }
      if (pull.data.mergeable === false || pull.data.mergeable_state === 'dirty') {
        return { state: 'conflict', mergeCommitSha: null };
      }
      if (pull.data.state === 'closed') return { state: 'open', mergeCommitSha: null };
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, this.pollIntervalMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            reject(signal.reason);
          },
          { once: true }
        );
      });
    }
    return { state: 'open', mergeCommitSha: null };
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
