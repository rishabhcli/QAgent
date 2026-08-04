import { Octokit } from '@octokit/rest';
import type { GitRepository, Worktree } from './git.js';

const GITHUB_API_VERSION = '2026-03-10';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface PublicationResult {
  url: string;
  number: number;
  state: 'open' | 'merged' | 'blocked' | 'conflict';
  autoMergeEnabled: boolean;
  mergeCommitSha: string | null;
  created?: boolean;
  checksState?: string | null;
  mergeQueueState?: string | null;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  detail?: string;
}

export interface PullRequestWaitResult {
  state: 'open' | 'merged' | 'blocked' | 'conflict';
  mergeCommitSha: string | null;
  checksState?: string | null;
  mergeQueueState?: string | null;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  detail?: string;
}

export interface GitHubRepositoryRef {
  owner: string;
  repo: string;
}

export interface GitHubRepositoryProbe {
  capturedAt: string;
  identity: { login: string };
  repository: {
    fullName: string;
    defaultBranch: string;
    archived: boolean;
    disabled: boolean;
  };
  permissions: {
    role: string;
    canPull: boolean;
    canPush: boolean;
    canAdminister: boolean;
    pullRequests: 'read' | 'write' | 'unverified';
  };
  rules: {
    active: string[];
    classicProtection: 'protected' | 'unprotected' | 'unavailable';
  };
  checks: {
    checkRuns: number;
    combinedStatus: string;
    statusContexts: number;
  };
  merge: {
    allowAutoMerge: boolean;
    allowedMethods: Array<'squash' | 'merge' | 'rebase'>;
    mergeQueueRequired: boolean;
  };
}

export interface GitHubPullRequestInspection {
  capturedAt: string;
  repositoryFullName: string;
  number: number;
  url: string;
  providerState: string;
  finalState: 'open' | 'merged' | 'closed-unmerged' | 'conflict';
  mergeable: string;
  mergeStateStatus: string;
  mergeEligible: boolean;
  reviewDecision: string | null;
  checksState: string | null;
  mergeQueueState: string | null;
  autoMergeEnabled: boolean;
  mergeCommitSha: string | null;
  detail: string;
}

interface GitHubResponse<T> {
  data: T;
  headers?: Record<string, string | number | undefined>;
}

interface PullListItem {
  html_url: string;
  number: number;
  state: string;
  merged_at?: string | null;
  head: { ref: string; repo?: { full_name?: string | null } | null };
  base: { ref: string };
}

interface PullSnapshot {
  id: string;
  number: number;
  url: string;
  state: string;
  merged: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  mergeCommit: { oid: string } | null;
  autoMergeRequest: { enabledAt: string } | null;
  mergeQueueEntry: { state: string } | null;
  statusCheckRollup: { state: string } | null;
}

export interface GitHubApi {
  rest: {
    pulls: {
      list(options: Record<string, unknown>): Promise<GitHubResponse<PullListItem[]>>;
      create(
        options: Record<string, unknown>
      ): Promise<GitHubResponse<{ html_url: string; number: number }>>;
      get(options: Record<string, unknown>): Promise<
        GitHubResponse<{
          merged: boolean;
          state: string;
          mergeable?: boolean | null;
          mergeable_state?: string;
          merge_commit_sha?: string | null;
        }>
      >;
    };
  };
  request<T>(route: string, options: Record<string, unknown>): Promise<GitHubResponse<T>>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export interface GitHubPublisherOptions {
  client?: GitHubApi;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
  requestTimeoutMs?: number;
  apiBaseUrl?: string;
  allowInsecureLoopback?: boolean;
}

export function parseGitHubRemote(remote: string): GitHubRepositoryRef | null {
  const ssh = remote.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  const https = remote.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  const match = ssh ?? https;
  return match?.[1] && match[2] ? { owner: match[1], repo: match[2].replace(/\.git$/i, '') } : null;
}

export class GitHubPublisher {
  private readonly octokit: GitHubApi;
  private readonly pollIntervalMs: number;
  private readonly waitTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private pushContext: { repository: GitHubRepositoryRef; username: string } | null = null;

  constructor(
    private readonly token: string,
    private readonly gitRepository: GitRepository,
    options: GitHubPublisherOptions = {}
  ) {
    const apiBaseUrl = options.apiBaseUrl
      ? validateGitHubApiBaseUrl(options.apiBaseUrl, options.allowInsecureLoopback ?? false)
      : undefined;
    this.octokit =
      options.client ??
      (new Octokit({
        auth: token,
        userAgent: 'qagent/0.2.0-beta.1',
        ...(apiBaseUrl ? { baseUrl: apiBaseUrl } : {}),
        request: { headers: { 'X-GitHub-Api-Version': GITHUB_API_VERSION } },
      }) as unknown as GitHubApi);
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.waitTimeoutMs = options.waitTimeoutMs ?? 15 * 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async probeRepository(
    repository: GitHubRepositoryRef,
    baseBranch?: string,
    signal?: AbortSignal
  ): Promise<GitHubRepositoryProbe> {
    validateRepositoryRef(repository);
    const [identityResponse, repositoryResponse] = await Promise.all([
      this.request<GitHubResponse<{ login: string }>>(
        'authenticated identity',
        signal,
        (requestSignal) =>
          this.octokit.request('GET /user', {
            request: { signal: requestSignal },
          })
      ),
      this.request<
        GitHubResponse<{
          full_name: string;
          default_branch: string;
          archived?: boolean;
          disabled?: boolean;
          allow_auto_merge?: boolean;
          allow_merge_commit?: boolean;
          allow_squash_merge?: boolean;
          allow_rebase_merge?: boolean;
          permissions?: {
            pull?: boolean;
            push?: boolean;
            admin?: boolean;
            maintain?: boolean;
            triage?: boolean;
          };
        }>
      >('repository access', signal, (requestSignal) =>
        this.octokit.request('GET /repos/{owner}/{repo}', {
          ...repository,
          request: { signal: requestSignal },
        })
      ),
    ]);

    const branch = baseBranch ?? repositoryResponse.data.default_branch;
    const [permissionResponse, pullsResponse, rulesResponse, checkRunsResponse, statusResponse] =
      await Promise.all([
        this.request<GitHubResponse<{ permission: string; role_name?: string }>>(
          'repository permission',
          signal,
          (requestSignal) =>
            this.octokit.request('GET /repos/{owner}/{repo}/collaborators/{username}/permission', {
              ...repository,
              username: identityResponse.data.login,
              request: { signal: requestSignal },
            })
        ),
        this.request<GitHubResponse<PullListItem[]>>(
          'pull request read permission',
          signal,
          (requestSignal) =>
            this.octokit.request('GET /repos/{owner}/{repo}/pulls', {
              ...repository,
              state: 'open',
              per_page: 1,
              request: { signal: requestSignal },
            })
        ),
        this.request<GitHubResponse<Array<{ type: string }>>>(
          'branch rules',
          signal,
          (requestSignal) =>
            this.octokit.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
              ...repository,
              branch,
              request: { signal: requestSignal },
            })
        ),
        this.request<GitHubResponse<{ total_count: number }>>(
          'check runs',
          signal,
          (requestSignal) =>
            this.octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
              ...repository,
              ref: branch,
              filter: 'latest',
              per_page: 1,
              request: { signal: requestSignal },
            })
        ),
        this.request<GitHubResponse<{ state: string; total_count: number }>>(
          'commit statuses',
          signal,
          (requestSignal) =>
            this.octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/status', {
              ...repository,
              ref: branch,
              per_page: 1,
              request: { signal: requestSignal },
            })
        ),
      ]);

    void pullsResponse;
    const classicProtection = await this.probeClassicProtection(repository, branch, signal);
    const repositoryPermissions = repositoryResponse.data.permissions ?? {};
    const role = permissionResponse.data.role_name ?? permissionResponse.data.permission;
    const canPush = repositoryPermissions.push ?? roleAllowsPush(role);
    const oauthScopes = parseOAuthScopes(repositoryResponse.headers?.['x-oauth-scopes']);
    const pullRequestWrite = canPush && (oauthScopes.has('repo') || oauthScopes.has('public_repo'));
    const activeRules = rulesResponse.data.map((rule) => rule.type);
    const allowedMethods: Array<'squash' | 'merge' | 'rebase'> = [];
    if (repositoryResponse.data.allow_squash_merge) allowedMethods.push('squash');
    if (repositoryResponse.data.allow_merge_commit) allowedMethods.push('merge');
    if (repositoryResponse.data.allow_rebase_merge) allowedMethods.push('rebase');

    return {
      capturedAt: new Date().toISOString(),
      identity: { login: identityResponse.data.login },
      repository: {
        fullName: repositoryResponse.data.full_name,
        defaultBranch: repositoryResponse.data.default_branch,
        archived: repositoryResponse.data.archived ?? false,
        disabled: repositoryResponse.data.disabled ?? false,
      },
      permissions: {
        role,
        canPull: repositoryPermissions.pull ?? role !== 'none',
        canPush,
        canAdminister: repositoryPermissions.admin ?? role === 'admin',
        pullRequests: pullRequestWrite ? 'write' : canPush ? 'unverified' : 'read',
      },
      rules: { active: activeRules, classicProtection },
      checks: {
        checkRuns: checkRunsResponse.data.total_count,
        combinedStatus: statusResponse.data.state,
        statusContexts: statusResponse.data.total_count,
      },
      merge: {
        allowAutoMerge: repositoryResponse.data.allow_auto_merge ?? false,
        allowedMethods,
        mergeQueueRequired: activeRules.includes('merge_queue'),
      },
    };
  }

  async inspectPullRequest(
    repository: GitHubRepositoryRef,
    pullNumber: number,
    signal?: AbortSignal
  ): Promise<GitHubPullRequestInspection> {
    validateRepositoryRef(repository);
    if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
      throw new Error('GitHub pull request number must be a positive safe integer');
    }

    const snapshot = await this.getPullSnapshot(repository, pullNumber, signal);
    const result = resultFromSnapshot(snapshot);
    return {
      capturedAt: new Date().toISOString(),
      repositoryFullName: `${repository.owner}/${repository.repo}`,
      number: snapshot.number,
      url: snapshot.url,
      providerState: snapshot.state,
      finalState: result.state === 'blocked' ? 'closed-unmerged' : result.state,
      mergeable: snapshot.mergeable,
      mergeStateStatus: snapshot.mergeStateStatus,
      mergeEligible: isQueueEligible(snapshot),
      reviewDecision: snapshot.reviewDecision,
      checksState: snapshot.statusCheckRollup?.state ?? null,
      mergeQueueState: snapshot.mergeQueueEntry?.state ?? null,
      autoMergeEnabled: snapshot.autoMergeRequest !== null,
      mergeCommitSha: result.mergeCommitSha,
      detail: result.detail ?? 'GitHub returned no pull request state detail.',
    };
  }

  async push(
    worktree: Worktree,
    options: {
      forceWithLease?: boolean;
      expectedRemoteSha?: string | null;
      signal?: AbortSignal;
    } = {}
  ): Promise<void> {
    if (!this.pushContext) {
      throw new Error('GitHub repository identity must be probed before pushing');
    }
    await this.gitRepository.push(worktree, {
      github: {
        token: this.token,
        username: this.pushContext.username,
        repository: this.pushContext.repository,
      },
      forceWithLease: options.forceWithLease,
      expectedRemoteSha: options.expectedRemoteSha,
      signal: options.signal,
    });
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
    onCreated?: (publication: PublicationResult) => Promise<void> | void;
  }): Promise<PublicationResult> {
    const probe = await this.probeRepository(
      options.repository,
      options.baseBranch,
      options.signal
    );
    if (probe.repository.archived || probe.repository.disabled) {
      throw new Error('GitHub repository is archived or disabled and cannot accept publication');
    }
    if (!probe.permissions.canPush) {
      throw new Error(
        `GitHub identity ${probe.identity.login} does not have repository push permission`
      );
    }
    if (probe.permissions.pullRequests !== 'write') {
      throw new Error(
        `GitHub identity ${probe.identity.login} does not have verified pull-request write permission`
      );
    }

    this.pushContext = { repository: options.repository, username: probe.identity.login };
    await this.push(options.worktree, { signal: options.signal });
    const existing = await this.findPullRequest(
      options.repository,
      options.worktree.branch,
      options.baseBranch,
      options.signal
    );
    const pull =
      existing ??
      (
        await this.request<GitHubResponse<{ html_url: string; number: number }>>(
          'pull request creation',
          options.signal,
          (requestSignal) =>
            this.octokit.rest.pulls.create({
              ...options.repository,
              title: options.title,
              head: options.worktree.branch,
              base: options.baseBranch,
              body: options.body,
              draft: false,
              request: { signal: requestSignal },
            })
        )
      ).data;
    const base: PublicationResult = {
      url: pull.html_url,
      number: pull.number,
      state: 'open',
      autoMergeEnabled: false,
      mergeCommitSha: null,
      created: !existing,
    };
    await options.onCreated?.(base);

    const initialSnapshot = await this.getPullSnapshot(
      options.repository,
      pull.number,
      options.signal
    );
    const initial = resultFromSnapshot(initialSnapshot);
    if (initial.state !== 'open') {
      return { ...base, ...initial, created: !existing };
    }

    if (!options.autoMerge || options.highRisk) {
      return {
        ...base,
        ...initial,
        state: options.highRisk ? 'blocked' : 'open',
        detail: options.highRisk
          ? 'High-risk files require human review; the pull request was not auto-merged.'
          : 'Auto-merge is disabled by project policy.',
      };
    }

    if (!probe.merge.allowedMethods.includes(options.mergeMethod)) {
      return {
        ...base,
        ...initial,
        state: 'blocked',
        detail: `GitHub does not allow the requested ${options.mergeMethod} merge method.`,
      };
    }

    let automation: { enabled: boolean; queueState: string | null };
    try {
      if (probe.merge.mergeQueueRequired) {
        const eligible = await this.waitForEligibility(
          options.repository,
          pull.number,
          options.signal
        );
        const eligibleResult = resultFromSnapshot(eligible);
        if (!isQueueEligible(eligible)) {
          return {
            ...base,
            ...eligibleResult,
            detail: `GitHub requires a merge queue, but the pull request did not become eligible before the bounded wait ended. ${eligibleResult.detail}`,
          };
        }
        automation = await this.enqueuePullRequest(
          options.repository,
          pull.number,
          eligible.id,
          options.signal
        );
      } else {
        if (!probe.merge.allowAutoMerge) {
          return {
            ...base,
            ...initial,
            detail:
              'GitHub repository settings do not allow auto-merge; the pull request remains open.',
          };
        }
        automation = await this.enableAutoMerge(
          initialSnapshot.id,
          options.mergeMethod,
          options.signal
        );
      }
    } catch (error) {
      return {
        ...base,
        ...initial,
        detail: `GitHub did not enable repository-controlled merge: ${safeError(error, this.token)}`,
      };
    }

    const result = await this.waitForPull(options.repository, pull.number, options.signal);
    return {
      ...base,
      ...result,
      autoMergeEnabled: automation.enabled,
      mergeQueueState: result.mergeQueueState ?? automation.queueState,
      detail:
        result.state === 'merged'
          ? 'GitHub reports the pull request merged after repository requirements passed.'
          : result.state === 'conflict'
            ? 'GitHub reports a merge conflict; QAgent will rebase and reverify once.'
            : result.state === 'blocked'
              ? (result.detail ?? 'GitHub closed the pull request without merging it.')
              : `Repository-controlled merge remains pending. ${result.detail ?? ''}`.trim(),
    };
  }

  async waitForPull(
    repository: GitHubRepositoryRef,
    pullNumber: number,
    signal?: AbortSignal
  ): Promise<PullRequestWaitResult> {
    const deadline = Date.now() + this.waitTimeoutMs;
    let latest: PullRequestWaitResult | null = null;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const snapshot = await this.getPullSnapshot(repository, pullNumber, signal);
      latest = resultFromSnapshot(snapshot);
      if (latest.state !== 'open') return latest;
      await delay(Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())), signal);
    }
    return (
      latest ?? {
        state: 'open',
        mergeCommitSha: null,
        detail: 'GitHub pull request state was not observed before the bounded wait ended.',
      }
    );
  }

  private async waitForEligibility(
    repository: GitHubRepositoryRef,
    pullNumber: number,
    signal?: AbortSignal
  ): Promise<PullSnapshot> {
    const deadline = Date.now() + this.waitTimeoutMs;
    let latest = await this.getPullSnapshot(repository, pullNumber, signal);
    while (Date.now() < deadline && resultFromSnapshot(latest).state === 'open') {
      if (isQueueEligible(latest)) return latest;
      await delay(Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())), signal);
      latest = await this.getPullSnapshot(repository, pullNumber, signal);
    }
    return latest;
  }

  private async findPullRequest(
    repository: GitHubRepositoryRef,
    branch: string,
    baseBranch: string,
    signal?: AbortSignal
  ): Promise<PullListItem | null> {
    const response = await this.request<GitHubResponse<PullListItem[]>>(
      'pull request lookup',
      signal,
      (requestSignal) =>
        this.octokit.rest.pulls.list({
          ...repository,
          state: 'all',
          head: `${repository.owner}:${branch}`,
          base: baseBranch,
          sort: 'updated',
          direction: 'desc',
          per_page: 100,
          request: { signal: requestSignal },
        })
    );
    const fullName = `${repository.owner}/${repository.repo}`.toLowerCase();
    const matches = response.data.filter(
      (pull) =>
        pull.head.ref === branch &&
        pull.base.ref === baseBranch &&
        (!pull.head.repo?.full_name || pull.head.repo.full_name.toLowerCase() === fullName)
    );
    return matches.find((pull) => pull.state === 'open') ?? matches[0] ?? null;
  }

  private async getPullSnapshot(
    repository: GitHubRepositoryRef,
    pullNumber: number,
    signal?: AbortSignal
  ): Promise<PullSnapshot> {
    const response = await this.request<{ repository: { pullRequest: PullSnapshot | null } }>(
      'pull request state',
      signal,
      (requestSignal) =>
        this.octokit.graphql(
          `query QAgentPullRequestState($owner: String!, $repo: String!, $number: Int!) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $number) {
                id
                number
                url
                state
                merged
                mergeable
                mergeStateStatus
                reviewDecision
                mergeCommit { oid }
                autoMergeRequest { enabledAt }
                mergeQueueEntry { state }
                statusCheckRollup { state }
              }
            }
          }`,
          {
            ...repository,
            number: pullNumber,
            request: { signal: requestSignal },
          }
        )
    );
    return validatePullSnapshot(response.repository?.pullRequest, repository, pullNumber);
  }

  private async enableAutoMerge(
    pullRequestId: string,
    mergeMethod: 'squash' | 'merge' | 'rebase',
    signal?: AbortSignal
  ): Promise<{ enabled: boolean; queueState: null }> {
    const response = await this.request<{
      enablePullRequestAutoMerge: {
        pullRequest: { autoMergeRequest: { enabledAt: string } | null } | null;
      } | null;
    }>('auto-merge enablement', signal, (requestSignal) =>
      this.octokit.graphql(
        `mutation QAgentEnableAutoMerge($id: ID!, $method: PullRequestMergeMethod!) {
          enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $method}) {
            pullRequest { autoMergeRequest { enabledAt } }
          }
        }`,
        {
          id: pullRequestId,
          method: mergeMethod.toUpperCase(),
          request: { signal: requestSignal },
        }
      )
    );
    if (!response.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest) {
      throw new Error('GitHub did not confirm auto-merge enablement');
    }
    return { enabled: true, queueState: null };
  }

  private async enqueuePullRequest(
    _repository: GitHubRepositoryRef,
    _pullNumber: number,
    pullRequestId: string,
    signal?: AbortSignal
  ): Promise<{ enabled: boolean; queueState: string | null }> {
    const response = await this.request<{
      enqueuePullRequest: { mergeQueueEntry: { state: string } | null } | null;
    }>('merge queue enrollment', signal, (requestSignal) =>
      this.octokit.graphql(
        `mutation QAgentEnqueuePullRequest($id: ID!) {
          enqueuePullRequest(input: {pullRequestId: $id}) {
            mergeQueueEntry { state }
          }
        }`,
        { id: pullRequestId, request: { signal: requestSignal } }
      )
    );
    const queueState = response.enqueuePullRequest?.mergeQueueEntry?.state ?? null;
    if (!queueState) throw new Error('GitHub did not confirm merge queue enrollment');
    return { enabled: true, queueState };
  }

  private async probeClassicProtection(
    repository: GitHubRepositoryRef,
    branch: string,
    signal?: AbortSignal
  ): Promise<'protected' | 'unprotected' | 'unavailable'> {
    try {
      await this.request<GitHubResponse<Record<string, unknown>>>(
        'classic branch protection',
        signal,
        (requestSignal) =>
          this.octokit.request('GET /repos/{owner}/{repo}/branches/{branch}/protection', {
            ...repository,
            branch,
            request: { signal: requestSignal },
          })
      );
      return 'protected';
    } catch (error) {
      if (error instanceof GitHubOperationError && error.status === 404) return 'unprotected';
      if (error instanceof GitHubOperationError && error.status === 403) return 'unavailable';
      throw error;
    }
  }

  private async request<T>(
    label: string,
    signal: AbortSignal | undefined,
    operation: (requestSignal: AbortSignal) => Promise<T>
  ): Promise<T> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`GitHub ${label} timed out`));
    }, this.requestTimeoutMs);
    const forwardAbort = () =>
      controller.abort(signal?.reason ?? new Error(`GitHub ${label} was cancelled`));
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(controller.signal.reason ?? new Error(`GitHub ${label} was cancelled`)),
        { once: true }
      );
    });
    try {
      return await Promise.race([operation(controller.signal), aborted]);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (timedOut) {
        throw new GitHubOperationError(
          `GitHub ${label} timed out after ${this.requestTimeoutMs}ms`
        );
      }
      throw new GitHubOperationError(
        `GitHub ${label} failed: ${safeError(error, this.token)}`,
        statusFrom(error)
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }
}

function validateGitHubApiBaseUrl(value: string, allowInsecureLoopback: boolean): string {
  const url = new URL(value);
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  const isPublicGitHub = url.protocol === 'https:' && url.hostname === 'api.github.com';
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!isPublicGitHub && !(allowInsecureLoopback && isLoopback && url.protocol === 'http:'))
  ) {
    throw new Error(
      'GitHub API base URL must be api.github.com over HTTPS or an explicitly enabled HTTP loopback endpoint without credentials, query, or fragment'
    );
  }
  return url.toString().replace(/\/$/, '');
}

class GitHubOperationError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'GitHubOperationError';
  }
}

function resultFromSnapshot(snapshot: PullSnapshot): PullRequestWaitResult {
  const detail = [
    `merge=${snapshot.mergeStateStatus}`,
    `mergeable=${snapshot.mergeable}`,
    `reviews=${snapshot.reviewDecision ?? 'not-required-or-unavailable'}`,
    `checks=${snapshot.statusCheckRollup?.state ?? 'unavailable'}`,
    `queue=${snapshot.mergeQueueEntry?.state ?? 'not-enqueued'}`,
  ].join(', ');
  const common = {
    checksState: snapshot.statusCheckRollup?.state ?? null,
    mergeQueueState: snapshot.mergeQueueEntry?.state ?? null,
    mergeStateStatus: snapshot.mergeStateStatus,
    reviewDecision: snapshot.reviewDecision,
  };
  if (snapshot.merged || snapshot.state === 'MERGED') {
    return {
      ...common,
      state: 'merged',
      mergeCommitSha: validCommitSha(snapshot.mergeCommit?.oid),
      detail: `GitHub final state is merged; ${detail}.`,
    };
  }
  if (snapshot.state === 'CLOSED') {
    return {
      ...common,
      state: 'blocked',
      mergeCommitSha: null,
      detail: `GitHub final state is closed without merge; ${detail}.`,
    };
  }
  if (
    snapshot.mergeable === 'CONFLICTING' ||
    (snapshot.mergeable !== 'UNKNOWN' && snapshot.mergeStateStatus === 'DIRTY')
  ) {
    return {
      ...common,
      state: 'conflict',
      mergeCommitSha: null,
      detail: `GitHub reports a merge conflict; ${detail}.`,
    };
  }
  return { ...common, state: 'open', mergeCommitSha: null, detail: `${detail}.` };
}

function isQueueEligible(snapshot: PullSnapshot): boolean {
  return (
    snapshot.state === 'OPEN' &&
    snapshot.mergeable === 'MERGEABLE' &&
    (snapshot.mergeStateStatus === 'CLEAN' || snapshot.mergeStateStatus === 'HAS_HOOKS') &&
    (!snapshot.statusCheckRollup || snapshot.statusCheckRollup.state === 'SUCCESS') &&
    snapshot.reviewDecision !== 'CHANGES_REQUESTED' &&
    snapshot.reviewDecision !== 'REVIEW_REQUIRED'
  );
}

function validCommitSha(value: string | undefined): string | null {
  return value && /^[a-f0-9]{40}$/i.test(value) ? value : null;
}

function validateRepositoryRef(repository: GitHubRepositoryRef): void {
  const segment = /^[a-z0-9_.-]{1,100}$/i;
  if (!segment.test(repository.owner) || !segment.test(repository.repo)) {
    throw new Error('GitHub repository owner and name must be plain path segments');
  }
}

function validatePullSnapshot(
  value: unknown,
  repository: GitHubRepositoryRef,
  pullNumber: number
): PullSnapshot {
  if (!value || typeof value !== 'object') {
    throw new Error('GitHub pull request node was not found');
  }
  const pull = value as Partial<PullSnapshot>;
  const expectedUrl =
    `https://github.com/${repository.owner}/${repository.repo}/pull/${pullNumber}`.toLowerCase();
  if (
    typeof pull.id !== 'string' ||
    pull.id.length === 0 ||
    pull.number !== pullNumber ||
    typeof pull.url !== 'string' ||
    pull.url.toLowerCase() !== expectedUrl ||
    typeof pull.state !== 'string' ||
    typeof pull.merged !== 'boolean' ||
    typeof pull.mergeable !== 'string' ||
    typeof pull.mergeStateStatus !== 'string' ||
    (pull.reviewDecision !== null && typeof pull.reviewDecision !== 'string')
  ) {
    throw new Error('GitHub pull request response did not match the requested pull request');
  }
  return pull as PullSnapshot;
}

function roleAllowsPush(role: string): boolean {
  return role === 'admin' || role === 'maintain' || role === 'write';
}

function parseOAuthScopes(value: string | number | undefined): Set<string> {
  if (typeof value !== 'string') return new Set();
  return new Set(
    value
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean)
  );
}

function statusFrom(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

function safeError(error: unknown, token: string): string {
  const value = error instanceof Error ? error.message : String(error);
  return value
    .replaceAll(token, '[REDACTED]')
    .replace(/authorization:\s*(?:bearer|token)\s+\S+/gi, 'authorization: [REDACTED]')
    .replace(/\b(?:github_pat_|gh[pousr]_)[a-z0-9_]+\b/gi, '[REDACTED]')
    .replace(/https:\/\/[^/\s:@]+:[^@\s/]+@github\.com/gi, 'https://[REDACTED]@github.com');
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  signal?.throwIfAborted();
  const abortSignal = signal;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      abortSignal?.removeEventListener('abort', onAbort);
      reject(abortSignal?.reason ?? new Error('GitHub wait was cancelled'));
    };
    function done(): void {
      abortSignal?.removeEventListener('abort', onAbort);
      resolve();
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}
