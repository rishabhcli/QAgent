import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GitHubPublisher,
  GitRepository,
  ProcessRunner,
  inspectPatch,
  parseGitHubRemote,
  relativeWorktreePath,
  type GitHubApi,
  type Worktree,
} from '@qagent/adapters';
import { describe, expect, it, vi } from 'vitest';
import { git, readCounter, temporaryDirectory, temporaryFixtureRepository } from '../helpers.js';

describe('Git safety and worktrees', () => {
  it('parses GitHub remotes without accepting other hosts', () => {
    expect(parseGitHubRemote('git@github.com:rishabhcli/QAgent.git')).toEqual({
      owner: 'rishabhcli',
      repo: 'QAgent',
    });
    expect(parseGitHubRemote('https://github.com/rishabhcli/QAgent')).toEqual({
      owner: 'rishabhcli',
      repo: 'QAgent',
    });
    expect(parseGitHubRemote('ssh://git@gitlab.com/example/repo.git')).toBeNull();
  });

  it('rejects unsafe patch paths and classifies high-risk changes', () => {
    const normal =
      'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n';
    expect(inspectPatch(normal)).toEqual({ files: ['src/app.ts'], highRisk: false });
    expect(
      inspectPatch(
        'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{"private":true}\n'
      )
    ).toEqual({ files: ['package.json'], highRisk: true });
    expect(() =>
      inspectPatch('diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-A=1\n+A=2\n')
    ).toThrow(/forbidden path/);
    expect(() =>
      inspectPatch(
        'diff --git a/../outside b/../outside\n--- a/../outside\n+++ b/../outside\n@@ -1 +1 @@\n-a\n+b\n'
      )
    ).toThrow(/forbidden path/);
    expect(() => inspectPatch('not a diff')).toThrow(/empty patch/);
  });

  it('creates, restores, patches, commits, and removes an isolated worktree', async () => {
    const repositoryPath = await temporaryFixtureRepository();
    const worktreesRoot = await temporaryDirectory('qagent-worktrees-');
    const repository = new GitRepository();
    const status = await repository.inspect(repositoryPath);
    expect(status).toMatchObject({ branch: 'main', dirty: false, origin: null });

    const worktree = await repository.createWorktree(
      status,
      worktreesRoot,
      'fa85c98c-a170-4ec4-a6f2-e41647562199',
      'Sample counter'
    );
    expect(worktree.path.startsWith(worktreesRoot)).toBe(true);
    expect(relativeWorktreePath(worktreesRoot, worktree.path)).not.toContain('..');
    expect(
      await repository.restoreWorktree(worktree.path, worktree.branch, worktree.baseSha)
    ).toEqual(worktree);
    await expect(
      repository.restoreWorktree(worktree.path, 'wrong-branch', worktree.baseSha)
    ).rejects.toThrow(/no longer matches/);

    const context = await repository.gatherContext(
      worktree.path,
      'Failure in src/counter.mjs and test/counter.test.mjs'
    );
    expect(context).toContain('--- src/counter.mjs ---');
    expect(context).toContain('--- package.json ---');
    const patch = [
      'diff --git a/src/counter.mjs b/src/counter.mjs',
      '--- a/src/counter.mjs',
      '+++ b/src/counter.mjs',
      '@@ -1,4 +1,4 @@',
      ' export function increment(value) {',
      '   // Intentional fixture defect: QAgent should repair this to `value + 1`.',
      '-  return value + 2;',
      '+  return value + 1;',
      ' }',
      '',
    ].join('\n');
    await expect(repository.applyPatch(worktree, patch, 10)).rejects.toThrow(/size limit/);
    expect(await repository.applyPatch(worktree, patch, 10_000)).toEqual({
      files: ['src/counter.mjs'],
      highRisk: false,
    });
    expect(await repository.changedFiles(worktree)).toEqual(['src/counter.mjs']);
    expect(await repository.diff(worktree)).toContain('return value + 1');
    const commit = await repository.commit(worktree, ['src/counter.mjs'], 'fix: increment once');
    expect(commit).toMatch(/^[a-f0-9]{40}$/);
    expect(await readCounter(repositoryPath)).toContain('value + 2');
    expect(await readCounter(worktree.path)).toContain('value + 1');

    await repository.removeWorktree(repositoryPath, worktree.path);
    await expect(access(worktree.path)).rejects.toThrow();
    expect(await git(repositoryPath, ['worktree', 'list', '--porcelain'])).not.toContain(
      worktree.path
    );
  });

  it('rebases onto a moving base and checks out the authoritative merged commit', async () => {
    const repositoryPath = await temporaryFixtureRepository();
    const remotePath = await temporaryDirectory('qagent-remote-');
    const worktreesRoot = await temporaryDirectory('qagent-worktrees-');
    await git(remotePath, ['init', '--bare', '--initial-branch=main']);
    await git(repositoryPath, ['remote', 'add', 'origin', remotePath]);
    await git(repositoryPath, ['push', '-u', 'origin', 'main']);

    const repository = new GitRepository();
    const status = await repository.inspect(repositoryPath);
    const worktree = await repository.createWorktree(
      status,
      worktreesRoot,
      'fa85c98c-a170-4ec4-a6f2-e41647562198',
      'Moving base'
    );
    const patch = [
      'diff --git a/src/counter.mjs b/src/counter.mjs',
      '--- a/src/counter.mjs',
      '+++ b/src/counter.mjs',
      '@@ -1,4 +1,4 @@',
      ' export function increment(value) {',
      '   // Intentional fixture defect: QAgent should repair this to `value + 1`.',
      '-  return value + 2;',
      '+  return value + 1;',
      ' }',
      '',
    ].join('\n');
    await repository.applyPatch(worktree, patch, 10_000);
    await repository.commit(worktree, ['src/counter.mjs'], 'fix: increment once');

    const readme = join(repositoryPath, 'README.md');
    await writeFile(readme, `${await readFile(readme, 'utf8')}\nBase advanced.\n`);
    await git(repositoryPath, ['add', 'README.md']);
    await git(repositoryPath, [
      '-c',
      'user.name=QAgent tests',
      '-c',
      'user.email=tests@qagent.local',
      'commit',
      '-m',
      'advance base',
    ]);
    await git(repositoryPath, ['push', 'origin', 'main']);

    await expect(repository.rebaseOnce(worktree, 'main')).resolves.toBe(true);
    expect(await readCounter(worktree.path)).toContain('value + 1');

    await git(repositoryPath, [
      '-c',
      'user.name=QAgent tests',
      '-c',
      'user.email=tests@qagent.local',
      'merge',
      '--no-ff',
      worktree.branch,
      '-m',
      'merge repair',
    ]);
    await git(repositoryPath, ['push', 'origin', 'main']);
    const mergeCommit = await git(repositoryPath, ['rev-parse', 'HEAD']);
    await expect(repository.checkoutMergedCommit(worktree, 'main', 'not-a-commit')).rejects.toThrow(
      /invalid merge commit/
    );
    await repository.checkoutMergedCommit(worktree, 'main', mergeCommit);
    expect(await git(worktree.path, ['rev-parse', 'HEAD'])).toBe(mergeCommit);
    expect(await git(worktree.path, ['branch', '--show-current'])).toBe('');
  });
});

describe('ProcessRunner', () => {
  it('runs structured commands, captures failures, and contains cwd', async () => {
    const root = await temporaryDirectory('qagent-process-');
    await mkdir(join(root, 'subdir'));
    const runner = new ProcessRunner();
    const success = await runner.run(root, {
      executable: process.execPath,
      args: ['-e', 'console.log(process.env.QAGENT_TEST_VALUE)'],
      cwd: 'subdir',
      env: { QAGENT_TEST_VALUE: 'grounded' },
      timeoutMs: 5_000,
    });
    expect(success).toMatchObject({ exitCode: 0, timedOut: false });
    expect(success.combined).toBe('grounded');

    const failure = await runner.run(root, {
      executable: process.execPath,
      args: ['-e', 'console.error("failed"); process.exit(7)'],
      cwd: '.',
      env: {},
      timeoutMs: 5_000,
    });
    expect(failure.exitCode).toBe(7);
    expect(failure.stderr).toBe('failed');
    await expect(
      runner.run(root, {
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: '../outside',
        env: {},
        timeoutMs: 5_000,
      })
    ).rejects.toThrow(/escapes/);
  });

  it('starts and stops a managed child process', async () => {
    const root = await temporaryDirectory('qagent-process-');
    const runner = new ProcessRunner();
    const managed = await runner.start(root, {
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: '.',
      env: {},
      timeoutMs: 60_000,
    });
    await managed.stop();
    const result = await managed.result;
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('GitHubPublisher policy integration', () => {
  const repository = { owner: 'owner', repo: 'repo' };
  const worktree: Worktree = { path: '/tmp/worktree', branch: 'qagent/run', baseSha: 'abc' };

  it('opens a PR without auto-merge when project policy disables it', async () => {
    const { publisher, push, client } = publisherFixture();
    const result = await publisher.publish({
      repository,
      worktree,
      baseBranch: 'main',
      title: 'Repair',
      body: 'Evidence',
      autoMerge: false,
      highRisk: false,
      mergeMethod: 'squash',
    });
    expect(push).toHaveBeenCalledWith(worktree);
    expect(client.rest.pulls.create).toHaveBeenCalled();
    expect(result).toMatchObject({ state: 'open', autoMergeEnabled: false });
  });

  it('blocks auto-merge for high-risk files', async () => {
    const { publisher } = publisherFixture();
    await expect(
      publisher.publish({
        repository,
        worktree,
        baseBranch: 'main',
        title: 'Repair',
        body: 'Evidence',
        autoMerge: true,
        highRisk: true,
        mergeMethod: 'merge',
      })
    ).resolves.toMatchObject({ state: 'blocked', autoMergeEnabled: false });
  });

  it('enables auto-merge and records the authoritative merged state', async () => {
    const mergeCommitSha = 'a'.repeat(40);
    const { publisher, client } = publisherFixture({ merged: true, mergeCommitSha });
    const result = await publisher.publish({
      repository,
      worktree,
      baseBranch: 'main',
      title: 'Repair',
      body: 'Evidence',
      autoMerge: true,
      highRisk: false,
      mergeMethod: 'rebase',
    });
    expect(client.graphql).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      state: 'merged',
      autoMergeEnabled: true,
      mergeCommitSha,
    });
  });

  it('reports an authoritative conflict for one engine-level rebase retry', async () => {
    const { publisher } = publisherFixture({ conflict: true });
    await expect(
      publisher.publish({
        repository,
        worktree,
        baseBranch: 'main',
        title: 'Repair',
        body: 'Evidence',
        autoMerge: true,
        highRisk: false,
        mergeMethod: 'squash',
      })
    ).resolves.toMatchObject({
      state: 'conflict',
      autoMergeEnabled: true,
      mergeCommitSha: null,
    });
  });

  it('leaves the PR open when GitHub rejects auto-merge', async () => {
    const { publisher, client } = publisherFixture();
    vi.mocked(client.graphql)
      .mockReset()
      .mockResolvedValueOnce({ repository: { pullRequest: { id: 'PR_node' } } })
      .mockRejectedValueOnce(new Error('merge queue required'));
    const result = await publisher.publish({
      repository,
      worktree,
      baseBranch: 'main',
      title: 'Repair',
      body: 'Evidence',
      autoMerge: true,
      highRisk: false,
      mergeMethod: 'squash',
    });
    expect(result.detail).toContain('merge queue required');
    expect(result.autoMergeEnabled).toBe(false);
  });

  it('reports missing PR nodes and non-Error provider failures', async () => {
    const missing = publisherFixture();
    vi.mocked(missing.client.graphql)
      .mockReset()
      .mockResolvedValueOnce({
        repository: { pullRequest: null },
      });
    const missingResult = await missing.publisher.publish({
      repository,
      worktree,
      baseBranch: 'main',
      title: 'Repair',
      body: 'Evidence',
      autoMerge: true,
      highRisk: false,
      mergeMethod: 'squash',
    });
    expect(missingResult.detail).toContain('Pull request node was not found');

    const rejected = publisherFixture();
    vi.mocked(rejected.client.graphql).mockReset().mockRejectedValueOnce('provider offline');
    const rejectedResult = await rejected.publisher.publish({
      repository,
      worktree,
      baseBranch: 'main',
      title: 'Repair',
      body: 'Evidence',
      autoMerge: true,
      highRisk: false,
      mergeMethod: 'rebase',
    });
    expect(rejectedResult.detail).toContain('provider offline');
  });

  it('keeps enabled auto-merge open on timeout or a closed unmerged PR', async () => {
    const waiting = publisherFixture({ waitTimeoutMs: 8, pollIntervalMs: 1 });
    await expect(
      waiting.publisher.publish({
        repository,
        worktree,
        baseBranch: 'main',
        title: 'Repair',
        body: 'Evidence',
        autoMerge: true,
        highRisk: false,
        mergeMethod: 'merge',
      })
    ).resolves.toMatchObject({ state: 'open', autoMergeEnabled: true });
    expect(waiting.client.rest.pulls.get).toHaveBeenCalled();

    const closed = publisherFixture({ closed: true, waitTimeoutMs: 20, pollIntervalMs: 1 });
    await expect(
      closed.publisher.publish({
        repository,
        worktree,
        baseBranch: 'main',
        title: 'Repair',
        body: 'Evidence',
        autoMerge: true,
        highRisk: false,
        mergeMethod: 'merge',
      })
    ).resolves.toMatchObject({ state: 'open', autoMergeEnabled: true });
  });

  it('honors cancellation while polling repository requirements', async () => {
    const fixture = publisherFixture({ waitTimeoutMs: 1_000, pollIntervalMs: 1_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('poll cancelled')), 5);
    await expect(
      fixture.publisher.publish({
        repository,
        worktree,
        baseBranch: 'main',
        title: 'Repair',
        body: 'Evidence',
        autoMerge: true,
        highRisk: false,
        mergeMethod: 'squash',
        signal: controller.signal,
      })
    ).rejects.toThrow('poll cancelled');
  });
});

function publisherFixture(
  options: {
    merged?: boolean;
    closed?: boolean;
    conflict?: boolean;
    mergeCommitSha?: string;
    pollIntervalMs?: number;
    waitTimeoutMs?: number;
  } = {}
) {
  const push = vi.fn(async () => undefined);
  const gitRepository = { push } as unknown as GitRepository;
  const graphql = vi
    .fn()
    .mockResolvedValueOnce({ repository: { pullRequest: { id: 'PR_node' } } })
    .mockResolvedValueOnce({});
  const client = {
    rest: {
      pulls: {
        create: vi.fn(async () => ({
          data: { html_url: 'https://github.com/owner/repo/pull/7', number: 7 },
        })),
        get: vi.fn(async () => ({
          data: {
            merged: options.merged ?? false,
            state: options.merged || options.closed ? 'closed' : 'open',
            mergeable: options.conflict ? false : true,
            mergeable_state: options.conflict ? 'dirty' : 'clean',
            merge_commit_sha: options.mergeCommitSha ?? null,
          },
        })),
      },
    },
    graphql,
  } as unknown as GitHubApi;
  return {
    client,
    push,
    publisher: new GitHubPublisher('token', gitRepository, {
      client,
      pollIntervalMs: options.pollIntervalMs ?? 1,
      waitTimeoutMs: options.waitTimeoutMs ?? 2,
    }),
  };
}
