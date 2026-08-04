import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, relative, resolve } from 'node:path';
import parseDiff from 'parse-diff';
import { assertPathContained, isSafeRelativePath, isSensitivePath } from './paths.js';
import { ProcessRunner, type CommandResult, type ProcessOutputChunk } from './process-runner.js';

const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const DEFAULT_GIT_OUTPUT_BYTES = 256 * 1024;
const gitRunner = new ProcessRunner({
  maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
  maxStreamBytes: DEFAULT_GIT_OUTPUT_BYTES,
});

export interface RepositoryStatus {
  root: string;
  branch: string;
  headSha: string;
  dirty: boolean;
  origin: string | null;
}

export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
}

export interface WorktreeState {
  path: string;
  branch: string | null;
  headSha: string;
  treeSha: string;
  baseSha: string;
  dirty: boolean;
  changedFiles: string[];
  upstream: string | null;
  upstreamSha: string | null;
  ahead: number;
  behind: number;
}

export interface WorktreeReconciliation {
  worktree: Worktree;
  state: 'created' | 'restored' | 'adopted';
}

export interface PatchInspection {
  files: string[];
  highRisk: boolean;
}

export interface PatchReconciliation {
  inspection: PatchInspection;
  state: 'applicable' | 'already_applied' | 'conflict';
  detail: string | null;
}

export interface CommitReconciliation {
  sha: string;
  treeSha: string;
  created: boolean;
}

export interface PushReconciliation {
  headSha: string;
  previousRemoteSha: string | null;
  remoteSha: string;
  updated: boolean;
  forced: boolean;
}

export interface GitExecutionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxStreamBytes?: number;
  onOutput?: (chunk: ProcessOutputChunk) => void;
}

export interface RestoreWorktreeOptions extends GitExecutionOptions {
  allowDetached?: boolean;
  expectedHeadSha?: string;
}

export interface GitHubPushCredentials {
  token: string;
  username: string;
  repository: { owner: string; repo: string };
}

export interface GitPushOptions extends GitExecutionOptions {
  github?: GitHubPushCredentials;
  forceWithLease?: boolean;
  expectedRemoteSha?: string | null;
}

interface GitCommandOptions extends GitExecutionOptions {
  allowedExitCodes?: number[];
  environment?: NodeJS.ProcessEnv;
  input?: string;
  redactions?: string[];
}

interface RegisteredWorktree {
  path: string;
  headSha: string | null;
  branch: string | null;
}

const HIGH_RISK_PATTERNS = [
  /^\.github\/workflows\//,
  /(^|\/)auth([/.]|$)/i,
  /(^|\/)migrations?\//i,
  /(^|\/)(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lockb?)$/,
  /(^|\/)\.qagent\.ya?ml$/,
  /(^|\/)(security|permissions|policy)([/.]|$)/i,
];

function normalizePatch(patch: string): string {
  return patch.length > 0 && !patch.endsWith('\n') ? `${patch}\n` : patch;
}

export function inspectPatch(patch: string): PatchInspection {
  const files = parseDiff(normalizePatch(patch)).map((file) => {
    const candidate = file.to === '/dev/null' ? file.from : file.to;
    if (!candidate) throw new Error('Patch contains a file without a path');
    const normalized = candidate.replace(/^[ab]\//, '').replaceAll('\\', '/');
    if (!normalized || !isSafeRelativePath(normalized) || isSensitivePath(normalized)) {
      throw new Error(`Patch contains a forbidden path: ${candidate}`);
    }
    return normalized;
  });
  if (files.length === 0) throw new Error('Provider returned an empty patch');
  return {
    files: [...new Set(files)],
    highRisk: files.some((file) => HIGH_RISK_PATTERNS.some((pattern) => pattern.test(file))),
  };
}

export class GitRepository {
  async inspect(projectPath: string, options: GitExecutionOptions = {}): Promise<RepositoryStatus> {
    const root = await realpath(await git(projectPath, ['rev-parse', '--show-toplevel'], options));
    const [branch, headSha, status, origin] = await Promise.all([
      git(root, ['branch', '--show-current'], options),
      git(root, ['rev-parse', 'HEAD'], options),
      git(root, ['status', '--porcelain=v1'], options),
      tryGit(root, ['config', '--get', 'remote.origin.url'], options),
    ]);
    return { root, branch, headSha, dirty: status.length > 0, origin: origin || null };
  }

  async createWorktree(
    repository: RepositoryStatus,
    worktreesRoot: string,
    runId: string,
    slug: string,
    options: GitExecutionOptions = {}
  ): Promise<Worktree> {
    return (await this.reconcileWorktree(repository, worktreesRoot, runId, slug, options)).worktree;
  }

  async reconcileWorktree(
    repository: RepositoryStatus,
    worktreesRoot: string,
    runId: string,
    slug: string,
    options: GitExecutionOptions = {}
  ): Promise<WorktreeReconciliation> {
    options.signal?.throwIfAborted();
    const requestedRoot = resolve(worktreesRoot);
    await mkdir(requestedRoot, { recursive: true });
    const root = await realpath(requestedRoot);
    const path = assertPathContained(root, runId);
    const branch = `qagent/${runId.slice(0, 8)}-${slugify(slug)}`;
    const worktree = { path, branch, baseSha: repository.headSha };

    const registered = await listRegisteredWorktrees(repository.root, options);
    const atPath = await registeredWorktreeAtPath(registered, path);
    if (atPath) {
      assertRegisteredBranch(atPath, branch);
      return {
        worktree: await recoveredWorktree(repository, worktree, atPath.headSha, options),
        state: 'restored',
      };
    }
    const atBranch = registered.find((item) => item.branch === branch);
    if (atBranch) {
      throw new Error(
        `QAgent branch ${branch} is already checked out at an unexpected path: ${atBranch.path}`
      );
    }

    if (await pathExists(path)) {
      await tryGit(repository.root, ['worktree', 'repair', path], options);
      const repaired = await registeredWorktreeAtPath(
        await listRegisteredWorktrees(repository.root, options),
        path
      );
      if (repaired) {
        assertRegisteredBranch(repaired, branch);
        return {
          worktree: await recoveredWorktree(repository, worktree, repaired.headSha, options),
          state: 'adopted',
        };
      }
      throw new Error(`QAgent worktree path already exists and could not be reconciled: ${path}`);
    }

    const branchSha = await tryGit(
      repository.root,
      ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`],
      options
    );
    try {
      if (branchSha) {
        await git(repository.root, ['worktree', 'add', path, branch], options);
        return {
          worktree: await recoveredWorktree(repository, worktree, branchSha, options),
          state: 'adopted',
        };
      }
      await git(
        repository.root,
        ['worktree', 'add', '-b', branch, path, repository.headSha],
        options
      );
      return { worktree, state: 'created' };
    } catch (error) {
      const raced = await registeredWorktreeAtPath(
        await listRegisteredWorktrees(repository.root, options),
        path
      );
      if (!raced) throw error;
      assertRegisteredBranch(raced, branch);
      return {
        worktree: await recoveredWorktree(repository, worktree, raced.headSha, options),
        state: 'adopted',
      };
    }
  }

  async restoreWorktree(
    path: string,
    branch: string,
    baseSha: string,
    options: RestoreWorktreeOptions = {}
  ): Promise<Worktree> {
    options.signal?.throwIfAborted();
    const canonicalPath = await realpath(path);
    const actualBranch =
      (await tryGit(canonicalPath, ['symbolic-ref', '--short', '-q', 'HEAD'], options)) || null;
    const headSha = await git(canonicalPath, ['rev-parse', 'HEAD'], options);
    const detachedMatches =
      !actualBranch &&
      options.allowDetached === true &&
      options.expectedHeadSha !== undefined &&
      headSha === options.expectedHeadSha;
    if (actualBranch !== branch && !detachedMatches) {
      throw new Error('Persisted worktree branch no longer matches');
    }
    await git(canonicalPath, ['cat-file', '-e', `${baseSha}^{commit}`], options);
    return { path: canonicalPath, branch, baseSha };
  }

  async inspectWorktreeState(
    worktree: Worktree,
    options: GitExecutionOptions = {}
  ): Promise<WorktreeState> {
    const [branch, headSha, treeSha, status, changedFiles, upstream] = await Promise.all([
      tryGit(worktree.path, ['symbolic-ref', '--short', '-q', 'HEAD'], options),
      git(worktree.path, ['rev-parse', 'HEAD'], options),
      git(worktree.path, ['rev-parse', 'HEAD^{tree}'], options),
      git(worktree.path, ['status', '--porcelain=v1', '-z'], options),
      this.changedFiles(worktree, options),
      tryGit(
        worktree.path,
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        options
      ),
    ]);
    const upstreamSha = upstream
      ? await tryGit(worktree.path, ['rev-parse', `${upstream}^{commit}`], options)
      : null;
    const counts = upstream
      ? await tryGit(
          worktree.path,
          ['rev-list', '--left-right', '--count', `${upstream}...HEAD`],
          options
        )
      : null;
    const [behind = 0, ahead = 0] = counts ? counts.split(/\s+/).map((value) => Number(value)) : [];
    return {
      path: await realpath(worktree.path),
      branch: branch || null,
      headSha,
      treeSha,
      baseSha: worktree.baseSha,
      dirty: status.length > 0,
      changedFiles,
      upstream: upstream || null,
      upstreamSha: upstreamSha || null,
      ahead,
      behind,
    };
  }

  async removeWorktree(
    repositoryRoot: string,
    worktreePath: string,
    options: GitExecutionOptions = {}
  ): Promise<void> {
    await git(repositoryRoot, ['worktree', 'remove', '--force', worktreePath], options).catch(
      async (error) => {
        options.signal?.throwIfAborted();
        const registered = await listRegisteredWorktrees(repositoryRoot, options);
        if (await registeredWorktreeAtPath(registered, worktreePath)) throw error;
        await rm(worktreePath, { recursive: true, force: true });
        await git(repositoryRoot, ['worktree', 'prune'], options);
      }
    );
  }

  async reconcilePatch(
    worktree: Worktree,
    patch: string,
    maxBytes: number,
    options: GitExecutionOptions = {}
  ): Promise<PatchReconciliation> {
    const normalizedPatch = normalizePatch(patch);
    if (Buffer.byteLength(normalizedPatch) > maxBytes) {
      throw new Error('Patch exceeds the configured size limit');
    }
    const inspection = inspectPatch(normalizedPatch);
    const applicable = await gitResult(
      worktree.path,
      ['apply', '--check', '--unidiff-zero', '--whitespace=error-all', '-'],
      { ...options, input: normalizedPatch, allowedExitCodes: [0, 1, 128] }
    );
    if (applicable.exitCode === 0) {
      return { inspection, state: 'applicable', detail: null };
    }
    const reverse = await gitResult(
      worktree.path,
      ['apply', '--reverse', '--check', '--unidiff-zero', '--whitespace=error-all', '-'],
      { ...options, input: normalizedPatch, allowedExitCodes: [0, 1, 128] }
    );
    if (reverse.exitCode === 0) {
      return { inspection, state: 'already_applied', detail: null };
    }
    return {
      inspection,
      state: 'conflict',
      detail: applicable.stderr || applicable.stdout || reverse.stderr || reverse.stdout,
    };
  }

  async applyPatch(
    worktree: Worktree,
    patch: string,
    maxBytes: number,
    options: GitExecutionOptions = {}
  ): Promise<PatchInspection> {
    const normalizedPatch = normalizePatch(patch);
    const reconciliation = await this.reconcilePatch(worktree, normalizedPatch, maxBytes, options);
    if (reconciliation.state === 'already_applied') return reconciliation.inspection;
    if (reconciliation.state === 'conflict') {
      throw new Error(
        `Patch cannot be applied or reconciled: ${reconciliation.detail ?? 'conflict'}`
      );
    }
    try {
      await git(
        worktree.path,
        ['apply', '--unidiff-zero', '--whitespace=fix', '-'],
        options,
        normalizedPatch
      );
    } catch (error) {
      const afterFailure = await this.reconcilePatch(worktree, normalizedPatch, maxBytes, options);
      if (afterFailure.state !== 'already_applied') throw error;
    }
    return reconciliation.inspection;
  }

  async commit(
    worktree: Worktree,
    files: string[],
    message: string,
    options: GitExecutionOptions = {}
  ): Promise<string> {
    return (await this.reconcileCommit(worktree, files, message, options)).sha;
  }

  async reconcileCommit(
    worktree: Worktree,
    files: string[],
    message: string,
    options: GitExecutionOptions = {}
  ): Promise<CommitReconciliation> {
    if (files.length === 0) throw new Error('Cannot commit an empty file set');
    const allowed = new Set(files);
    for (const file of files) {
      if (!isSafeRelativePath(file) || isSensitivePath(file)) {
        throw new Error(`Cannot commit an unsafe path: ${file}`);
      }
      assertPathContained(worktree.path, file);
    }
    const stagedBefore = splitNull(
      await git(worktree.path, ['diff', '--cached', '--name-only', '-z'], options)
    );
    const unexpected = stagedBefore.filter((file) => !allowed.has(file));
    if (unexpected.length > 0) {
      throw new Error(`Worktree has unexpected staged paths: ${unexpected.join(', ')}`);
    }

    const headBefore = await git(worktree.path, ['rev-parse', 'HEAD'], options);
    const status = await git(worktree.path, ['status', '--porcelain=v1', '-z'], options);
    if (headBefore !== worktree.baseSha) {
      if (status) {
        throw new Error('Existing repair commit has additional uncommitted changes');
      }
      const [commitCount, commitMessage, treeSha, changedFiles] = await Promise.all([
        git(worktree.path, ['rev-list', '--count', `${worktree.baseSha}..HEAD`], options),
        git(worktree.path, ['log', '-1', '--format=%B'], options),
        git(worktree.path, ['rev-parse', 'HEAD^{tree}'], options),
        this.changedFiles(worktree, options),
      ]);
      const unexpected = changedFiles.filter((file) => !allowed.has(file));
      const missing = files.filter((file) => !changedFiles.includes(file));
      if (
        commitCount !== '1' ||
        commitMessage.trim() !== message.trim() ||
        unexpected.length > 0 ||
        missing.length > 0
      ) {
        throw new Error('Existing worktree history does not match the expected repair commit');
      }
      return {
        sha: headBefore,
        treeSha,
        created: false,
      };
    }
    if (!status) throw new Error('Verified repair has no changes to commit');

    const changedBeforeCommit = await this.changedFiles(worktree, options);
    const unexpectedChanges = changedBeforeCommit.filter((file) => !allowed.has(file));
    if (unexpectedChanges.length > 0) {
      throw new Error(`Worktree has unexpected changed paths: ${unexpectedChanges.join(', ')}`);
    }

    await git(worktree.path, ['add', '--', ...files], options);
    const staged = splitNull(
      await git(worktree.path, ['diff', '--cached', '--name-only', '-z'], options)
    );
    const unexpectedAfterAdd = staged.filter((file) => !allowed.has(file));
    if (unexpectedAfterAdd.length > 0) {
      throw new Error(`Commit would include unexpected paths: ${unexpectedAfterAdd.join(', ')}`);
    }
    const missingAfterAdd = files.filter((file) => !staged.includes(file));
    if (missingAfterAdd.length > 0) {
      throw new Error(`Commit is missing expected changed paths: ${missingAfterAdd.join(', ')}`);
    }
    if (staged.length === 0) {
      throw new Error('Verified repair has no staged changes to commit');
    }

    await git(
      worktree.path,
      [
        '-c',
        'user.name=QAgent',
        '-c',
        'user.email=qagent@localhost',
        '-c',
        'commit.gpgSign=false',
        '-c',
        `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
        'commit',
        '--no-verify',
        '-m',
        message,
      ],
      options
    );
    const sha = await git(worktree.path, ['rev-parse', 'HEAD'], options);
    return {
      sha,
      treeSha: await git(worktree.path, ['rev-parse', 'HEAD^{tree}'], options),
      created: true,
    };
  }

  async push(worktree: Worktree, options: GitPushOptions = {}): Promise<void> {
    await this.reconcilePush(worktree, options);
  }

  async reconcilePush(
    worktree: Worktree,
    options: GitPushOptions = {}
  ): Promise<PushReconciliation> {
    validateExpectedRemoteSha(options);
    const github = options.github;
    if (github) validateGitHubPush(github, worktree.branch);
    const helper = github ? await createEphemeralCredentialHelper() : null;
    const remoteUrl = github
      ? `https://github.com/${github.repository.owner}/${github.repository.repo}.git`
      : 'origin';
    const environment: NodeJS.ProcessEnv | undefined =
      github && helper
        ? {
            GIT_ASKPASS: helper.path,
            GIT_TERMINAL_PROMPT: '0',
            QAGENT_GITHUB_TOKEN: github.token,
            QAGENT_GITHUB_USERNAME: github.username,
          }
        : undefined;
    const redactions = github ? [github.token] : [];
    const credentialArgs = github
      ? ['-c', 'credential.helper=', '-c', 'credential.useHttpPath=true']
      : [];
    try {
      const headSha = await git(worktree.path, ['rev-parse', 'HEAD'], options);
      const remoteRef = `refs/heads/${worktree.branch}`;
      const observedRemote = parseLsRemote(
        await git(
          worktree.path,
          [...credentialArgs, 'ls-remote', '--heads', remoteUrl, remoteRef],
          {
            ...options,
            environment,
            redactions,
          }
        )
      );
      const expectedRemoteSha =
        options.expectedRemoteSha === undefined ? observedRemote : options.expectedRemoteSha;
      if (observedRemote === headSha) {
        return {
          headSha,
          previousRemoteSha: observedRemote,
          remoteSha: observedRemote,
          updated: false,
          forced: false,
        };
      }
      if (options.forceWithLease && observedRemote !== expectedRemoteSha) {
        throw new Error(
          `Remote branch ${worktree.branch} moved from the expected ${expectedRemoteSha ?? 'missing'} to ${observedRemote ?? 'missing'}`
        );
      }

      const lease = options.forceWithLease
        ? `--force-with-lease=${remoteRef}:${expectedRemoteSha ?? ''}`
        : null;
      const pushPrefix = github
        ? [...credentialArgs, '-c', `remote.origin.pushurl=${remoteUrl}`, 'push']
        : ['push'];
      await git(
        worktree.path,
        [
          ...pushPrefix,
          ...(lease ? [lease] : []),
          '--set-upstream',
          'origin',
          `${worktree.branch}:${worktree.branch}`,
        ],
        {
          ...options,
          environment,
          redactions,
        }
      );
      const remoteSha = parseLsRemote(
        await git(
          worktree.path,
          [...credentialArgs, 'ls-remote', '--heads', remoteUrl, remoteRef],
          {
            ...options,
            environment,
            redactions,
          }
        )
      );
      if (!remoteSha || remoteSha !== headSha) {
        throw new Error(
          `Remote branch ${worktree.branch} does not match the local verified commit`
        );
      }
      return {
        headSha,
        previousRemoteSha: observedRemote,
        remoteSha,
        updated: observedRemote !== remoteSha,
        forced: Boolean(lease),
      };
    } finally {
      await helper?.remove();
    }
  }

  async rebaseOnce(
    worktree: Worktree,
    baseBranch: string,
    options: GitExecutionOptions = {}
  ): Promise<boolean> {
    options.signal?.throwIfAborted();
    await tryGit(worktree.path, ['rebase', '--abort'], cleanupOptions(options));
    const before = await git(worktree.path, ['rev-parse', 'HEAD'], options);
    await git(worktree.path, ['fetch', '--no-tags', 'origin', baseBranch], options);
    try {
      await git(worktree.path, ['rebase', `origin/${baseBranch}`], options);
    } catch (error) {
      await tryGit(worktree.path, ['rebase', '--abort'], cleanupOptions(options));
      throw error;
    }
    const after = await git(worktree.path, ['rev-parse', 'HEAD'], options);
    return before !== after;
  }

  async checkoutMergedCommit(
    worktree: Worktree,
    baseBranch: string,
    mergeCommitSha: string,
    options: GitExecutionOptions = {}
  ): Promise<void> {
    if (!/^[a-f0-9]{40}$/i.test(mergeCommitSha)) {
      throw new Error('GitHub returned an invalid merge commit SHA');
    }
    const current = await git(worktree.path, ['rev-parse', 'HEAD'], options);
    if (current === mergeCommitSha) return;
    await git(worktree.path, ['fetch', '--no-tags', 'origin', baseBranch], options);
    await git(worktree.path, ['cat-file', '-e', `${mergeCommitSha}^{commit}`], options);
    await git(worktree.path, ['checkout', '--detach', mergeCommitSha], options);
  }

  async diff(worktree: Worktree, options: GitExecutionOptions = {}): Promise<string> {
    const tracked = await git(
      worktree.path,
      ['diff', '--no-ext-diff', '--binary', worktree.baseSha],
      options
    );
    const untracked = splitNull(
      await git(worktree.path, ['ls-files', '--others', '--exclude-standard', '-z'], options)
    );
    const additions: string[] = [];
    for (const file of untracked) {
      const result = await gitResult(
        worktree.path,
        ['diff', '--no-index', '--no-ext-diff', '--binary', '--', '/dev/null', file],
        { ...options, allowedExitCodes: [0, 1] }
      );
      if (result.stdout) additions.push(result.stdout);
    }
    return [tracked, ...additions].filter(Boolean).join('\n');
  }

  async gatherContext(
    worktreePath: string,
    failureOutput: string,
    options: GitExecutionOptions = {}
  ): Promise<string> {
    const canonicalRoot = await realpath(worktreePath);
    const rawFiles = await git(canonicalRoot, ['ls-files', '-z'], options);
    const files = splitNull(rawFiles);
    const mentioned = files.filter((file) => failureOutput.includes(file));
    const manifests = files.filter((file) =>
      /(^|\/)(package\.json|pyproject\.toml|go\.mod|Gemfile|pom\.xml|build\.gradle|.*\.csproj)$/.test(
        file
      )
    );
    const candidates = [...new Set([...mentioned, ...manifests])]
      .filter((file) => !isSensitivePath(file))
      .slice(0, 12);
    let budget = 60_000;
    const sections: string[] = [];
    for (const file of candidates) {
      options.signal?.throwIfAborted();
      const contained = assertPathContained(canonicalRoot, file);
      const canonicalPath = await realpath(contained).catch(() => null);
      if (!canonicalPath) continue;
      try {
        assertPathContained(canonicalRoot, canonicalPath);
      } catch {
        continue;
      }
      let content: string;
      try {
        content = await readFile(canonicalPath, {
          encoding: 'utf8',
          signal: options.signal,
        });
      } catch {
        options.signal?.throwIfAborted();
        continue;
      }
      if (!content || Buffer.byteLength(content) > budget) continue;
      budget -= Buffer.byteLength(content);
      const sourceLines = content.split('\n');
      if (sourceLines.at(-1) === '') sourceLines.pop();
      const numberedContent = sourceLines
        .map((line, index) => `${String(index + 1).padStart(6, '0')}|${line}`)
        .join('\n');
      sections.push(`FILE: ${file}\n${numberedContent}`);
    }
    return sections.join('\n\n');
  }

  async changedFiles(worktree: Worktree, options: GitExecutionOptions = {}): Promise<string[]> {
    const [tracked, untracked] = await Promise.all([
      git(worktree.path, ['diff', '--name-only', '-z', worktree.baseSha], options),
      git(worktree.path, ['ls-files', '--others', '--exclude-standard', '-z'], options),
    ]);
    return [...new Set([...splitNull(tracked), ...splitNull(untracked)])];
  }
}

function validateExpectedRemoteSha(options: GitPushOptions): void {
  if (options.expectedRemoteSha === undefined) return;
  if (!options.forceWithLease) {
    throw new Error('An expected remote SHA requires force-with-lease');
  }
  if (options.expectedRemoteSha !== null && !/^[a-f0-9]{40}$/i.test(options.expectedRemoteSha)) {
    throw new Error('Expected remote SHA must be a full commit SHA or null');
  }
}

async function git(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {},
  input?: string
): Promise<string> {
  const result = await gitResult(cwd, args, { ...options, input: input ?? options.input });
  return result.stdout;
}

async function tryGit(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {}
): Promise<string | null> {
  const result = await gitResult(cwd, args, {
    ...options,
    allowedExitCodes: [...new Set([...(options.allowedExitCodes ?? []), 0, 1, 2, 128])],
  });
  return result.exitCode === 0 ? result.stdout : null;
}

async function gitResult(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {}
): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  const environment = compactEnvironment({
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    LC_ALL: 'C',
    ...options.environment,
  });
  const result = await gitRunner.run(
    cwd,
    {
      executable: 'git',
      args,
      cwd: '.',
      env: environment,
      timeoutMs: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    },
    options.signal,
    {
      input: options.input,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_BYTES,
      maxStreamBytes: options.maxStreamBytes ?? DEFAULT_GIT_OUTPUT_BYTES,
      onOutput: options.onOutput,
      redactValues: options.redactions,
    }
  );
  const command = redactGitText(`git ${args.join(' ')}`, options.redactions);
  if (result.timedOut) {
    const detail = result.stderr || result.stdout || result.combined || 'no diagnostic output';
    throw new Error(
      `${command} timed out after ${options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS}ms: ${redactGitText(detail, options.redactions)}`
    );
  }
  if (
    result.droppedBytes.stdout > 0 ||
    result.droppedBytes.stderr > 0 ||
    result.droppedBytes.combined > 0
  ) {
    const detail = result.stderr || result.stdout || result.combined || 'no diagnostic output';
    throw new Error(
      `${command} output exceeded ${options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_BYTES} bytes: ${redactGitText(detail, options.redactions)}`
    );
  }
  if (!allowedExitCodes.includes(result.exitCode ?? -1)) {
    const detail = result.stderr || result.stdout || result.combined || 'no diagnostic output';
    throw new Error(`${command} failed: ${redactGitText(detail, options.redactions)}`);
  }
  return result;
}

async function listRegisteredWorktrees(
  repositoryRoot: string,
  options: GitExecutionOptions
): Promise<RegisteredWorktree[]> {
  const output = await git(repositoryRoot, ['worktree', 'list', '--porcelain', '-z'], options);
  const records: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | null = null;
  for (const field of output.split('\0')) {
    if (!field) {
      if (current) records.push(current);
      current = null;
      continue;
    }
    if (field.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: field.slice('worktree '.length), headSha: null, branch: null };
    } else if (current && field.startsWith('HEAD ')) {
      current.headSha = field.slice('HEAD '.length);
    } else if (current && field.startsWith('branch refs/heads/')) {
      current.branch = field.slice('branch refs/heads/'.length);
    }
  }
  if (current) records.push(current);
  return records;
}

async function registeredWorktreeAtPath(
  worktrees: RegisteredWorktree[],
  path: string
): Promise<RegisteredWorktree | null> {
  const expected = await canonicalPathForComparison(path);
  for (const worktree of worktrees) {
    if ((await canonicalPathForComparison(worktree.path)) === expected) return worktree;
  }
  return null;
}

async function recoveredWorktree(
  repository: RepositoryStatus,
  worktree: Worktree,
  fallbackHeadSha: string | null,
  options: GitExecutionOptions
): Promise<Worktree> {
  const baseSha = await tryGit(
    repository.root,
    ['merge-base', repository.headSha, `refs/heads/${worktree.branch}`],
    options
  );
  return {
    ...worktree,
    baseSha: baseSha ?? fallbackHeadSha ?? repository.headSha,
  };
}

async function canonicalPathForComparison(path: string): Promise<string> {
  return resolve(await realpath(path).catch(() => path));
}

function assertRegisteredBranch(worktree: RegisteredWorktree, expectedBranch: string): void {
  if (worktree.branch !== expectedBranch) {
    throw new Error(
      `Persisted worktree branch no longer matches: expected ${expectedBranch}, found ${worktree.branch ?? 'detached HEAD'}`
    );
  }
}

function cleanupOptions(options: GitExecutionOptions): GitExecutionOptions {
  return {
    ...options,
    signal: undefined,
    timeoutMs: Math.min(options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, 10_000),
  };
}

function splitNull(value: string): string[] {
  return value.split('\0').filter(Boolean);
}

function compactEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function parseLsRemote(output: string): string | null {
  const sha = output.split(/\s+/)[0];
  return sha && /^[a-f0-9]{40}$/i.test(sha) ? sha : null;
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path)
    .then(() => true)
    .catch(() => false);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || basename(value) || 'repair';
}

export function relativeWorktreePath(root: string, path: string): string {
  return relative(resolve(root), resolve(path));
}

function validateGitHubPush(credentials: GitHubPushCredentials, branch: string): void {
  const component = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
  if (
    !component.test(credentials.repository.owner) ||
    !component.test(credentials.repository.repo) ||
    !/^[a-z0-9][a-z0-9._/-]*$/i.test(branch) ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.includes('//') ||
    /[\r\n]/.test(credentials.token) ||
    /[\r\n]/.test(credentials.username)
  ) {
    throw new Error('GitHub push configuration is invalid');
  }
}

async function createEphemeralCredentialHelper(): Promise<{
  path: string;
  remove(): Promise<void>;
}> {
  const directory = await mkdtemp(resolve(tmpdir(), 'qagent-github-credential-'));
  const windows = process.platform === 'win32';
  const path = resolve(directory, windows ? 'askpass.cmd' : 'askpass.sh');
  const source = windows
    ? [
        '@echo off',
        'echo %~1 | findstr /I "username" >nul',
        'if %errorlevel%==0 (',
        '  echo %QAGENT_GITHUB_USERNAME%',
        ') else (',
        '  echo %QAGENT_GITHUB_TOKEN%',
        ')',
        '',
      ].join('\r\n')
    : [
        '#!/bin/sh',
        'case "$1" in',
        '  *sername*) printf "%s\\n" "$QAGENT_GITHUB_USERNAME" ;;',
        '  *) printf "%s\\n" "$QAGENT_GITHUB_TOKEN" ;;',
        'esac',
        '',
      ].join('\n');
  await writeFile(path, source, { encoding: 'utf8', mode: 0o700 });
  if (!windows) await chmod(path, 0o700);
  return {
    path,
    remove: async () => rm(directory, { recursive: true, force: true }),
  };
}

function redactGitText(value: string, redactions: string[] = []): string {
  let redacted = value;
  for (const secret of redactions) {
    if (secret) redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  return redacted
    .replace(/https:\/\/[^/\s:@]+:[^@\s/]+@github\.com/gi, 'https://[REDACTED]@github.com')
    .replace(/\b(?:github_pat_|gh[pousr]_)[a-z0-9_]+\b/gi, '[REDACTED]');
}
