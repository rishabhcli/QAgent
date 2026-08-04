import { access, chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
    expect(parseGitHubRemote('http://github.com/rishabhcli/QAgent')).toBeNull();
    expect(parseGitHubRemote('https://token@github.com/rishabhcli/QAgent')).toBeNull();
    expect(parseGitHubRemote('https://github.com/rishabhcli/QAgent/extra')).toBeNull();
    expect(parseGitHubRemote('ssh://git@gitlab.com/example/repo.git')).toBeNull();
  });

  it('inspects the declared GitHub origin before Git transport URL rewrites', async () => {
    const repositoryPath = await temporaryFixtureRepository();
    const bare = await temporaryDirectory('qagent-git-transport-');
    await git(bare, ['init', '--bare']);
    const declaredOrigin = 'https://github.com/qagent-tests/workflow-fixture.git';
    await git(repositoryPath, ['remote', 'add', 'origin', declaredOrigin]);
    await git(repositoryPath, [
      'config',
      `url.${pathToFileURL(bare).toString()}.insteadOf`,
      declaredOrigin,
    ]);

    expect(await git(repositoryPath, ['remote', 'get-url', 'origin'])).toBe(
      pathToFileURL(bare).toString()
    );
    await expect(new GitRepository().inspect(repositoryPath)).resolves.toMatchObject({
      origin: declaredOrigin,
    });
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
    expect(
      inspectPatch(
        'diff --git a/.qagent.yml b/.qagent.yml\n--- a/.qagent.yml\n+++ b/.qagent.yml\n@@ -1 +1 @@\n-autoMerge: false\n+autoMerge: true'
      )
    ).toEqual({ files: ['.qagent.yml'], highRisk: true });
    expect(() =>
      inspectPatch('diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-A=1\n+A=2\n')
    ).toThrow(/forbidden path/);
    expect(() =>
      inspectPatch(
        'diff --git a/.git/config b/.git/config\n--- a/.git/config\n+++ b/.git/config\n@@ -1 +1 @@\n-a\n+b'
      )
    ).toThrow(/forbidden path/);
    expect(() =>
      inspectPatch(
        'diff --git a/../outside b/../outside\n--- a/../outside\n+++ b/../outside\n@@ -1 +1 @@\n-a\n+b\n'
      )
    ).toThrow(/forbidden path/);
    expect(() =>
      inspectPatch(
        'diff --git /tmp/outside /tmp/outside\n--- /tmp/outside\n+++ /tmp/outside\n@@ -1 +1 @@\n-a\n+b'
      )
    ).toThrow(/forbidden path/);
    expect(() => inspectPatch('not a diff')).toThrow(/empty patch/);
  });

  it('applies a valid model patch missing only its terminal line feed', async () => {
    const repositoryPath = await temporaryFixtureRepository();
    const worktreesRoot = await temporaryDirectory('qagent-worktrees-');
    const repository = new GitRepository();
    const status = await repository.inspect(repositoryPath);
    const worktree = await repository.createWorktree(
      status,
      worktreesRoot,
      'fa85c98c-a170-4ec4-a6f2-e41647562197',
      'Missing terminal line feed'
    );
    const patch = [
      'diff --git a/src/counter.mjs b/src/counter.mjs',
      '--- a/src/counter.mjs',
      '+++ b/src/counter.mjs',
      '@@ -3,1 +3,1 @@',
      '-  return value + 2;',
      '+  return value + 1;',
    ].join('\n');
    const malformedHunk = patch.replace('@@ -3,1 +3,1 @@', '@@ -3,2 +3,2 @@');

    expect(patch.endsWith('\n')).toBe(false);
    await expect(repository.applyPatch(worktree, malformedHunk, 10_000)).rejects.toThrow(
      /cannot be applied or reconciled/
    );
    expect(await readCounter(worktree.path)).toContain('value + 2');
    await expect(repository.applyPatch(worktree, patch, 10_000)).resolves.toEqual({
      files: ['src/counter.mjs'],
      highRisk: false,
    });
    expect(await readCounter(worktree.path)).toContain('value + 1');
    expect(await readCounter(repositoryPath)).toContain('value + 2');

    await repository.removeWorktree(repositoryPath, worktree.path);
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
    const canonicalWorktreesRoot = await realpath(worktreesRoot);
    expect(worktree.path.startsWith(canonicalWorktreesRoot)).toBe(true);
    expect(relativeWorktreePath(canonicalWorktreesRoot, worktree.path)).not.toContain('..');
    const restored = await repository.restoreWorktree(
      worktree.path,
      worktree.branch,
      worktree.baseSha
    );
    expect(restored).toMatchObject({ branch: worktree.branch, baseSha: worktree.baseSha });
    expect(await realpath(restored.path)).toBe(await realpath(worktree.path));
    await expect(
      repository.restoreWorktree(worktree.path, 'wrong-branch', worktree.baseSha)
    ).rejects.toThrow(/no longer matches/);

    const context = await repository.gatherContext(
      worktree.path,
      'Failure in src/counter.mjs and test/counter.test.mjs'
    );
    expect(context).toContain('FILE: src/counter.mjs');
    expect(context).toContain('000003|  return value + 2;');
    expect(context).toContain('FILE: package.json');
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

  it.skipIf(process.platform === 'win32')(
    'pushes through a removed ephemeral helper and verifies the remote branch',
    async () => {
      const root = await temporaryDirectory('qagent-git-helper-');
      const binaryDirectory = join(root, 'bin');
      const logPath = join(root, 'git-arguments.log');
      const statePath = join(root, 'remote-created');
      const fakeGit = join(binaryDirectory, 'git');
      await mkdir(binaryDirectory);
      await writeFile(
        fakeGit,
        [
          '#!/bin/sh',
          'printf "CALL\\n" >> "$QAGENT_TEST_GIT_LOG"',
          'for argument in "$@"; do printf "%s\\n" "$argument"; done >> "$QAGENT_TEST_GIT_LOG"',
          'if [ "$1 $2" = "rev-parse HEAD" ]; then',
          '  printf "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n"',
          '  exit 0',
          'fi',
          'printf "helper=%s\\n" "$GIT_ASKPASS" >> "$QAGENT_TEST_GIT_LOG"',
          'username=$("$GIT_ASKPASS" "Username for github.com")',
          'password=$("$GIT_ASKPASS" "Password for github.com")',
          '[ "$username" = "octocat" ] || exit 21',
          '[ "$password" = "$QAGENT_GITHUB_TOKEN" ] || exit 22',
          'case " $* " in',
          '  *" ls-remote "*)',
          '    [ "$QAGENT_TEST_GIT_SUPPRESS_REMOTE" = "1" ] && exit 0',
          '    if [ -f "$QAGENT_TEST_GIT_STATE" ]; then',
          '      printf "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\trefs/heads/qagent/run\\n"',
          '    fi',
          '    exit 0',
          '    ;;',
          'esac',
          'touch "$QAGENT_TEST_GIT_STATE"',
          'printf "credential-ok\\n" >> "$QAGENT_TEST_GIT_LOG"',
          '',
        ].join('\n')
      );
      await chmod(fakeGit, 0o700);
      const previousPath = process.env.PATH;
      const previousLog = process.env.QAGENT_TEST_GIT_LOG;
      const previousState = process.env.QAGENT_TEST_GIT_STATE;
      const previousSuppressRemote = process.env.QAGENT_TEST_GIT_SUPPRESS_REMOTE;
      process.env.PATH = `${binaryDirectory}:${previousPath ?? ''}`;
      process.env.QAGENT_TEST_GIT_LOG = logPath;
      process.env.QAGENT_TEST_GIT_STATE = statePath;
      try {
        await new GitRepository().push(
          { path: root, branch: 'qagent/run', baseSha: 'abc' },
          {
            github: {
              token: 'ghp_test_only_token',
              username: 'octocat',
              repository: { owner: 'owner', repo: 'repo' },
            },
          }
        );
        await rm(statePath);
        process.env.QAGENT_TEST_GIT_SUPPRESS_REMOTE = '1';
        await expect(
          new GitRepository().push(
            { path: root, branch: 'qagent/run', baseSha: 'abc' },
            {
              github: {
                token: 'ghp_test_only_token',
                username: 'octocat',
                repository: { owner: 'owner', repo: 'repo' },
              },
            }
          )
        ).rejects.toThrow(/does not match the local verified commit/);
      } finally {
        process.env.PATH = previousPath;
        if (previousLog === undefined) delete process.env.QAGENT_TEST_GIT_LOG;
        else process.env.QAGENT_TEST_GIT_LOG = previousLog;
        if (previousState === undefined) delete process.env.QAGENT_TEST_GIT_STATE;
        else process.env.QAGENT_TEST_GIT_STATE = previousState;
        if (previousSuppressRemote === undefined) {
          delete process.env.QAGENT_TEST_GIT_SUPPRESS_REMOTE;
        } else {
          process.env.QAGENT_TEST_GIT_SUPPRESS_REMOTE = previousSuppressRemote;
        }
      }

      const log = await readFile(logPath, 'utf8');
      expect(log).toContain('credential.helper=');
      expect(log).toContain('remote.origin.pushurl=https://github.com/owner/repo.git');
      expect(log).toContain('credential-ok');
      expect(log).not.toContain('ghp_test_only_token');
      const helperPaths = [...log.matchAll(/^helper=(.+)$/gm)];
      const helperPath = helperPaths.at(-1)?.[1];
      expect(helperPath).toBeTruthy();
      await expect(access(helperPath!)).rejects.toThrow();
    }
  );

  it('validates caller-provided remote lease expectations before invoking Git', async () => {
    const repository = new GitRepository();
    const worktree = { path: '/missing', branch: 'qagent/run', baseSha: 'abc' };
    await expect(
      repository.reconcilePush(worktree, {
        expectedRemoteSha: 'a'.repeat(40),
      })
    ).rejects.toThrow(/requires force-with-lease/);
    await expect(
      repository.reconcilePush(worktree, {
        forceWithLease: true,
        expectedRemoteSha: 'not-a-full-commit',
      })
    ).rejects.toThrow(/full commit SHA or null/);
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

  it('only permits an explicit loopback API endpoint in E2E mode', () => {
    const gitRepository = new GitRepository();
    expect(
      () =>
        new GitHubPublisher('credential', gitRepository, {
          apiBaseUrl: 'http://127.0.0.1:4321',
        })
    ).toThrow(/explicitly enabled HTTP loopback/);
    expect(
      () =>
        new GitHubPublisher('credential', gitRepository, {
          apiBaseUrl: 'https://example.com?token=credential',
          allowInsecureLoopback: true,
        })
    ).toThrow(/without credentials, query, or fragment/);
    expect(
      () =>
        new GitHubPublisher('credential', gitRepository, {
          apiBaseUrl: 'http://localhost:4321',
          allowInsecureLoopback: true,
        })
    ).not.toThrow();
  });

  it('probes authenticated identity, role, rules, checks, and merge settings', async () => {
    const { publisher } = publisherFixture({
      activeRules: ['required_status_checks', 'pull_request'],
      protection: 'protected',
      combinedStatus: 'failure',
      checkRuns: 11,
    });
    await expect(publisher.probeRepository(repository, 'main')).resolves.toMatchObject({
      identity: { login: 'octocat' },
      repository: {
        fullName: 'owner/repo',
        defaultBranch: 'main',
        archived: false,
        disabled: false,
      },
      permissions: {
        role: 'admin',
        canPull: true,
        canPush: true,
        canAdminister: true,
        pullRequests: 'write',
      },
      rules: {
        active: ['required_status_checks', 'pull_request'],
        classicProtection: 'protected',
      },
      checks: { checkRuns: 11, combinedStatus: 'failure' },
      merge: {
        allowAutoMerge: true,
        allowedMethods: ['squash', 'merge', 'rebase'],
        mergeQueueRequired: false,
      },
    });
  });

  it('inspects a specified pull request without mutating provider state', async () => {
    const { publisher, client } = publisherFixture({
      snapshots: [
        pullSnapshot({
          checksState: 'SUCCESS',
          queueState: 'QUEUED',
          reviewDecision: 'APPROVED',
        }),
      ],
    });

    await expect(publisher.inspectPullRequest(repository, 7)).resolves.toMatchObject({
      repositoryFullName: 'owner/repo',
      number: 7,
      url: 'https://github.com/owner/repo/pull/7',
      providerState: 'OPEN',
      finalState: 'open',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      mergeEligible: true,
      reviewDecision: 'APPROVED',
      checksState: 'SUCCESS',
      mergeQueueState: 'QUEUED',
      autoMergeEnabled: false,
      mergeCommitSha: null,
    });
    expect(client.rest.pulls.create).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(client.graphql)
        .mock.calls.every(([query]) => !String(query).includes('mutation QAgent'))
    ).toBe(true);
    await expect(publisher.inspectPullRequest(repository, 0)).rejects.toThrow(
      /positive safe integer/
    );
  });

  it('does not report merge eligibility while required checks are failing', async () => {
    const { publisher } = publisherFixture({
      snapshots: [pullSnapshot({ checksState: 'FAILURE', reviewDecision: 'APPROVED' })],
    });

    await expect(publisher.inspectPullRequest(repository, 7)).resolves.toMatchObject({
      finalState: 'open',
      mergeEligible: false,
      checksState: 'FAILURE',
    });
  });

  it('opens a PR with token-scoped Git auth and reports creation immediately', async () => {
    const { publisher, push, client } = publisherFixture();
    const onCreated = vi.fn();
    const result = await publisher.publish({
      ...publicationOptions(),
      autoMerge: false,
      onCreated,
    });
    expect(push).toHaveBeenCalledWith(worktree, {
      github: {
        token: 'ghp_fixture_secret',
        username: 'octocat',
        repository,
      },
      forceWithLease: undefined,
      expectedRemoteSha: undefined,
      signal: undefined,
    });
    expect(client.rest.pulls.create).toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ number: 7, created: true, state: 'open' })
    );
    expect(result).toMatchObject({ state: 'open', autoMergeEnabled: false, created: true });
  });

  it('reuses the existing pull request for the same branch and base', async () => {
    const { publisher, client } = publisherFixture({ existing: 'open' });
    const result = await publisher.publish({
      ...publicationOptions(),
      autoMerge: false,
    });
    expect(client.rest.pulls.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      url: 'https://github.com/owner/repo/pull/9',
      number: 9,
      created: false,
      state: 'open',
    });
  });

  it('uses the newest matching branch pull request instead of preferring an older merge', async () => {
    const newerClosed = {
      html_url: 'https://github.com/owner/repo/pull/10',
      number: 10,
      state: 'closed',
      merged_at: null,
      head: { ref: 'qagent/run', repo: { full_name: 'owner/repo' } },
      base: { ref: 'main' },
    };
    const olderMerged = {
      ...newerClosed,
      html_url: 'https://github.com/owner/repo/pull/9',
      number: 9,
      merged_at: '2026-07-22T12:00:00.000Z',
    };
    const { publisher, client } = publisherFixture({
      existingPulls: [newerClosed, olderMerged],
      snapshots: [pullSnapshot({ state: 'CLOSED' })],
    });

    await expect(
      publisher.publish({
        ...publicationOptions(),
        autoMerge: false,
      })
    ).resolves.toMatchObject({
      url: 'https://github.com/owner/repo/pull/10',
      number: 10,
      created: false,
      state: 'blocked',
    });
    expect(client.rest.pulls.create).not.toHaveBeenCalled();
  });

  it('requires verified pull-request write capability before pushing', async () => {
    const { publisher, push, client } = publisherFixture({ pullRequestWrite: false });
    await expect(publisher.publish(publicationOptions())).rejects.toThrow(
      /verified pull-request write permission/
    );
    expect(push).not.toHaveBeenCalled();
    expect(client.rest.pulls.create).not.toHaveBeenCalled();
  });

  it('forwards the caller-provided remote SHA to an exact force-with-lease push', async () => {
    const { publisher, push } = publisherFixture();
    await publisher.publish({ ...publicationOptions(), autoMerge: false });
    push.mockClear();
    const expectedRemoteSha = 'a'.repeat(40);

    await publisher.push(worktree, { forceWithLease: true, expectedRemoteSha });

    expect(push).toHaveBeenCalledWith(worktree, {
      github: {
        token: 'ghp_fixture_secret',
        username: 'octocat',
        repository,
      },
      forceWithLease: true,
      expectedRemoteSha,
      signal: undefined,
    });
  });

  it('blocks auto-merge for high-risk files', async () => {
    const { publisher } = publisherFixture();
    await expect(
      publisher.publish({
        ...publicationOptions(),
        autoMerge: true,
        highRisk: true,
        mergeMethod: 'merge',
      })
    ).resolves.toMatchObject({ state: 'blocked', autoMergeEnabled: false });
  });

  it('enables auto-merge and records the authoritative merged state', async () => {
    const mergeCommitSha = 'a'.repeat(40);
    const { publisher, client } = publisherFixture({
      snapshots: [pullSnapshot(), pullSnapshot({ state: 'MERGED', merged: true, mergeCommitSha })],
    });
    const result = await publisher.publish({
      ...publicationOptions(),
      mergeMethod: 'rebase',
    });
    expect(
      vi
        .mocked(client.graphql)
        .mock.calls.some(([query]) => String(query).includes('QAgentEnableAutoMerge'))
    ).toBe(true);
    expect(result).toMatchObject({
      state: 'merged',
      autoMergeEnabled: true,
      mergeCommitSha,
      mergeStateStatus: 'CLEAN',
      checksState: 'SUCCESS',
    });
  });

  it('waits for merge queue eligibility, enqueues, and records the final merge', async () => {
    const mergeCommitSha = 'b'.repeat(40);
    const { publisher, client } = publisherFixture({
      activeRules: ['merge_queue', 'required_status_checks'],
      snapshots: [
        pullSnapshot(),
        pullSnapshot(),
        pullSnapshot({ state: 'MERGED', merged: true, mergeCommitSha, queueState: 'QUEUED' }),
      ],
    });
    await expect(publisher.publish(publicationOptions())).resolves.toMatchObject({
      state: 'merged',
      autoMergeEnabled: true,
      mergeCommitSha,
      mergeQueueState: 'QUEUED',
    });
    expect(
      vi
        .mocked(client.graphql)
        .mock.calls.some(([query]) => String(query).includes('QAgentEnqueuePullRequest'))
    ).toBe(true);
  });

  it('reports an authoritative conflict for one engine-level rebase retry', async () => {
    const { publisher } = publisherFixture({
      snapshots: [
        pullSnapshot(),
        pullSnapshot({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
      ],
    });
    await expect(publisher.publish(publicationOptions())).resolves.toMatchObject({
      state: 'conflict',
      autoMergeEnabled: true,
      mergeCommitSha: null,
    });
  });

  it('does not attempt auto-merge when repository settings disable it', async () => {
    const { publisher, client } = publisherFixture({ allowAutoMerge: false });
    const result = await publisher.publish({
      ...publicationOptions(),
    });
    expect(result.detail).toContain('do not allow auto-merge');
    expect(result.autoMergeEnabled).toBe(false);
    expect(
      vi
        .mocked(client.graphql)
        .mock.calls.some(([query]) => String(query).includes('QAgentEnableAutoMerge'))
    ).toBe(false);
  });

  it('preserves a closed unmerged pull request as a blocked final state', async () => {
    const { publisher, client } = publisherFixture({
      existing: 'closed',
      snapshots: [pullSnapshot({ state: 'CLOSED' })],
    });
    const result = await publisher.publish(publicationOptions());
    expect(client.rest.pulls.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      state: 'blocked',
      autoMergeEnabled: false,
      created: false,
      mergeCommitSha: null,
    });
    expect(result.detail).toContain('closed without merge');
  });

  it('keeps enabled auto-merge open on a bounded wait timeout', async () => {
    const fixture = publisherFixture({ waitTimeoutMs: 8, pollIntervalMs: 1 });
    await expect(fixture.publisher.publish(publicationOptions())).resolves.toMatchObject({
      state: 'open',
      autoMergeEnabled: true,
      mergeCommitSha: null,
    });
  });

  it('redacts token-shaped provider errors', async () => {
    const fixture = publisherFixture({
      autoMergeError: new Error('Authorization: Bearer ghp_fixture_secret was rejected'),
    });
    const result = await fixture.publisher.publish(publicationOptions());
    expect(result.detail).toContain('[REDACTED]');
    expect(result.detail).not.toContain('ghp_fixture_secret');
  });

  it('honors cancellation while polling repository requirements', async () => {
    const fixture = publisherFixture({ waitTimeoutMs: 1_000, pollIntervalMs: 1_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('poll cancelled')), 5);
    await expect(
      fixture.publisher.publish({
        ...publicationOptions(),
        signal: controller.signal,
      })
    ).rejects.toThrow('poll cancelled');
  });

  it('bounds stalled authenticated requests and rejects missing push permission', async () => {
    const stalled = publisherFixture({ hangRoute: 'GET /user', requestTimeoutMs: 5 });
    await expect(stalled.publisher.probeRepository(repository, 'main')).rejects.toThrow(
      /authenticated identity timed out/
    );

    const readOnly = publisherFixture({ canPush: false });
    await expect(readOnly.publisher.publish(publicationOptions())).rejects.toThrow(
      /does not have repository push permission/
    );
    expect(readOnly.push).not.toHaveBeenCalled();
  });
});

function publisherFixture(
  options: {
    activeRules?: string[];
    allowAutoMerge?: boolean;
    autoMergeError?: Error;
    canPush?: boolean;
    checkRuns?: number;
    combinedStatus?: string;
    existing?: 'open' | 'closed';
    existingPulls?: Array<{
      html_url: string;
      number: number;
      state: string;
      merged_at?: string | null;
      head: { ref: string; repo?: { full_name?: string | null } | null };
      base: { ref: string };
    }>;
    hangRoute?: string;
    pollIntervalMs?: number;
    protection?: 'protected' | 'unprotected' | 'unavailable';
    pullRequestWrite?: boolean;
    requestTimeoutMs?: number;
    snapshots?: ReturnType<typeof pullSnapshot>[];
    waitTimeoutMs?: number;
  } = {}
) {
  const push = vi.fn(async () => undefined);
  const gitRepository = { push } as unknown as GitRepository;
  const existingPull = options.existing
    ? {
        html_url: 'https://github.com/owner/repo/pull/9',
        number: 9,
        state: options.existing,
        merged_at: null,
        head: { ref: 'qagent/run', repo: { full_name: 'owner/repo' } },
        base: { ref: 'main' },
      }
    : null;
  const request = vi.fn(async (route: string) => {
    if (route === options.hangRoute) return new Promise<never>(() => undefined);
    if (route === 'GET /user') return { data: { login: 'octocat' } };
    if (route === 'GET /repos/{owner}/{repo}') {
      return {
        data: {
          full_name: 'owner/repo',
          default_branch: 'main',
          archived: false,
          disabled: false,
          allow_auto_merge: options.allowAutoMerge ?? true,
          allow_merge_commit: true,
          allow_squash_merge: true,
          allow_rebase_merge: true,
          permissions: {
            pull: true,
            push: options.canPush ?? true,
            admin: options.canPush ?? true,
          },
        },
        headers: { 'x-oauth-scopes': options.pullRequestWrite === false ? '' : 'repo' },
      };
    }
    if (route.includes('/collaborators/{username}/permission')) {
      return {
        data: {
          permission: options.canPush === false ? 'read' : 'admin',
          role_name: options.canPush === false ? 'read' : 'admin',
        },
      };
    }
    if (route === 'GET /repos/{owner}/{repo}/pulls') return { data: [] };
    if (route.includes('/rules/branches/{branch}')) {
      return { data: (options.activeRules ?? []).map((type) => ({ type })) };
    }
    if (route.includes('/check-runs')) {
      return { data: { total_count: options.checkRuns ?? 2 } };
    }
    if (route.endsWith('/status')) {
      return {
        data: { state: options.combinedStatus ?? 'success', total_count: 2 },
      };
    }
    if (route.includes('/protection')) {
      if (options.protection === 'protected') return { data: { required_status_checks: {} } };
      throw Object.assign(new Error('Protection unavailable'), {
        status: options.protection === 'unavailable' ? 403 : 404,
      });
    }
    throw new Error(`Unexpected GitHub route: ${route}`);
  });
  const snapshots = options.snapshots ?? [pullSnapshot()];
  let snapshotIndex = 0;
  const graphql = vi.fn(async (query: string, variables: Record<string, unknown>) => {
    if (query.includes('QAgentEnableAutoMerge')) {
      if (options.autoMergeError) throw options.autoMergeError;
      return {
        enablePullRequestAutoMerge: {
          pullRequest: { autoMergeRequest: { enabledAt: '2026-07-23T00:00:00Z' } },
        },
      };
    }
    if (query.includes('QAgentEnqueuePullRequest')) {
      return { enqueuePullRequest: { mergeQueueEntry: { state: 'QUEUED' } } };
    }
    const snapshot = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
    snapshotIndex += 1;
    const pullNumber = typeof variables.number === 'number' ? variables.number : snapshot?.number;
    return {
      repository: {
        pullRequest: snapshot
          ? {
              ...snapshot,
              number: pullNumber,
              url: `https://github.com/${String(variables.owner)}/${String(
                variables.repo
              )}/pull/${String(pullNumber)}`,
            }
          : null,
      },
    };
  });
  const client = {
    rest: {
      pulls: {
        list: vi.fn(async () => ({
          data: options.existingPulls ?? (existingPull ? [existingPull] : []),
        })),
        create: vi.fn(async () => ({
          data: { html_url: 'https://github.com/owner/repo/pull/7', number: 7 },
        })),
        get: vi.fn(async () => ({
          data: {
            merged: false,
            state: 'open',
            mergeable: true,
            mergeable_state: 'clean',
            merge_commit_sha: null,
          },
        })),
      },
    },
    request,
    graphql,
  } as unknown as GitHubApi;
  return {
    client,
    push,
    publisher: new GitHubPublisher('ghp_fixture_secret', gitRepository, {
      client,
      pollIntervalMs: options.pollIntervalMs ?? 1,
      waitTimeoutMs: options.waitTimeoutMs ?? 10,
      requestTimeoutMs: options.requestTimeoutMs ?? 50,
    }),
  };
}

function publicationOptions() {
  return {
    repository: { owner: 'owner', repo: 'repo' },
    worktree: { path: '/tmp/worktree', branch: 'qagent/run', baseSha: 'abc' },
    baseBranch: 'main',
    title: 'Repair',
    body: 'Evidence',
    autoMerge: true,
    highRisk: false,
    mergeMethod: 'squash' as const,
  };
}

function pullSnapshot(
  options: {
    checksState?: string | null;
    mergeCommitSha?: string;
    mergeable?: string;
    merged?: boolean;
    mergeStateStatus?: string;
    queueState?: string | null;
    reviewDecision?: string | null;
    state?: string;
  } = {}
) {
  return {
    id: 'PR_node',
    number: 7,
    url: 'https://github.com/owner/repo/pull/7',
    state: options.state ?? 'OPEN',
    merged: options.merged ?? false,
    mergeable: options.mergeable ?? 'MERGEABLE',
    mergeStateStatus: options.mergeStateStatus ?? 'CLEAN',
    reviewDecision: options.reviewDecision ?? null,
    mergeCommit: options.mergeCommitSha ? { oid: options.mergeCommitSha } : null,
    autoMergeRequest: null,
    mergeQueueEntry: options.queueState ? { state: options.queueState } : null,
    statusCheckRollup:
      options.checksState === null ? null : { state: options.checksState ?? 'SUCCESS' },
  };
}
