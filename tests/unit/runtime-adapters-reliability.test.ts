import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitRepository, ProcessRunner, type ProcessOutputChunk } from '@qagent/adapters';
import { describe, expect, it } from 'vitest';
import { git, temporaryDirectory, temporaryFixtureRepository } from '../helpers.js';

describe('ProcessRunner reliability', () => {
  it('streams a complete redacted progress line while the process is still running', async () => {
    const root = await temporaryDirectory('qagent-process-progress-');
    const chunks: ProcessOutputChunk[] = [];
    const runner = new ProcessRunner();
    const managed = await runner.start(
      root,
      {
        executable: process.execPath,
        args: [
          '-e',
          'console.log(`ready token=${process.env.QAGENT_TEST_TOKEN}`); setInterval(() => {}, 1000)',
        ],
        cwd: '.',
        env: { QAGENT_TEST_TOKEN: 'progress-secret-value' },
        timeoutMs: 60_000,
      },
      undefined,
      { onOutput: (chunk) => chunks.push(chunk) }
    );

    try {
      await waitUntil(() => chunks.some((chunk) => chunk.text.includes('ready')), 1_000);
      const streamed = chunks.map((chunk) => chunk.text).join('');
      expect(streamed).toContain('ready');
      expect(streamed).not.toContain('progress-secret-value');
    } finally {
      await managed.stop();
      await managed.result;
    }
  });

  it('streams redacted progress before exit while bounding live and retained output', async () => {
    const root = await temporaryDirectory('qagent-process-stream-');
    const chunks: ProcessOutputChunk[] = [];
    const runner = new ProcessRunner();
    let settled = false;
    const secret = 'ghp_runtime_reliability_secret';
    const resultPromise = runner
      .run(
        root,
        {
          executable: process.execPath,
          args: [
            '-e',
            [
              'process.stdout.write(`booted token=${process.env.QAGENT_TEST_TOKEN}\\n${"x".repeat(1400)}`);',
              'setTimeout(() => process.stderr.write(`diagnostic\\n${"😀".repeat(4096)}`), 200);',
            ].join(''),
          ],
          cwd: '.',
          env: { QAGENT_TEST_TOKEN: secret },
          timeoutMs: 5_000,
        },
        undefined,
        {
          maxOutputBytes: 1_024,
          maxStreamBytes: 512,
          maxChunkCharacters: 63,
          onOutput: (chunk) => chunks.push(chunk),
        }
      )
      .finally(() => {
        settled = true;
      });

    await waitUntil(() => chunks.length > 0);
    expect(settled).toBe(false);
    const result = await resultPromise;
    const streamed = chunks.map((chunk) => chunk.text).join('');
    expect(streamed).not.toContain(secret);
    expect(streamed).not.toContain('\uFFFD');
    expect(result.combined).not.toContain(secret);
    expect(result.combined).toContain('booted');
    expect(Buffer.byteLength(streamed)).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_024);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1_024);
    expect(Buffer.byteLength(result.combined)).toBeLessThanOrEqual(1_024);
    expect(result.truncated).toBe(true);
    expect(result.droppedBytes.streamed).toBeGreaterThan(0);
    expect(chunks.map((chunk) => chunk.sequence)).toEqual(chunks.map((_, index) => index + 1));
  });

  it('returns early-exit diagnostics immediately', async () => {
    const root = await temporaryDirectory('qagent-process-exit-');
    const runner = new ProcessRunner();
    const managed = await runner.start(root, {
      executable: process.execPath,
      args: ['-e', 'console.error("startup exploded"); process.exit(23)'],
      cwd: '.',
      env: {},
      timeoutMs: 30_000,
    });
    const result = await managed.result;

    expect(result).toMatchObject({
      exitCode: 23,
      stderr: 'startup exploded',
      timedOut: false,
    });
    expect(managed.snapshot().stderr).toContain('startup exploded');
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it.skipIf(process.platform === 'win32')(
    'stops TERM-resistant process trees with bounded KILL escalation',
    async () => {
      const root = await temporaryDirectory('qagent-process-tree-');
      const pidFile = join(root, 'grandchild.pid');
      const runner = new ProcessRunner();
      const managed = await runner.start(root, processTreeCommand(pidFile, 60_000), undefined, {
        stopGraceMs: 100,
        stopKillWaitMs: 1_000,
      });
      const grandchildPid = await waitForPid(pidFile);
      try {
        await managed.stop();
        const result = await managed.result;
        expect(result.terminated).toBe(true);
        await waitUntil(() => !pidAlive(grandchildPid), 3_000);
      } finally {
        await managed.stop();
        killIfAlive(grandchildPid);
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'applies command timeouts to the whole process tree',
    async () => {
      const root = await temporaryDirectory('qagent-process-timeout-');
      const pidFile = join(root, 'grandchild.pid');
      const runner = new ProcessRunner();
      // Leave enough time for the instrumented child to publish its PID before timing out.
      const resultPromise = runner.run(root, processTreeCommand(pidFile, 2_000), undefined, {
        stopGraceMs: 100,
        stopKillWaitMs: 1_000,
      });
      const grandchildPid = await waitForPid(pidFile);
      try {
        const result = await resultPromise;
        expect(result.timedOut).toBe(true);
        await waitUntil(() => !pidAlive(grandchildPid), 3_000);
      } finally {
        killIfAlive(grandchildPid);
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'propagates cancellation through the whole process tree',
    async () => {
      const root = await temporaryDirectory('qagent-process-cancel-');
      const pidFile = join(root, 'grandchild.pid');
      const controller = new AbortController();
      const runner = new ProcessRunner();
      const managed = await runner.start(
        root,
        processTreeCommand(pidFile, 60_000),
        controller.signal,
        { stopGraceMs: 100, stopKillWaitMs: 1_000 }
      );
      const grandchildPid = await waitForPid(pidFile);
      try {
        controller.abort(new Error('cancel runtime tree'));
        await expect(managed.result).resolves.toMatchObject({ cancelled: true });
        await waitUntil(() => !pidAlive(grandchildPid), 3_000);
      } finally {
        await managed.stop();
        killIfAlive(grandchildPid);
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a cwd that escapes through a symlink',
    async () => {
      const root = await temporaryDirectory('qagent-process-root-');
      const outside = await temporaryDirectory('qagent-process-outside-');
      await symlink(outside, join(root, 'linked-outside'), 'dir');

      await expect(
        new ProcessRunner().run(root, {
          executable: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: 'linked-outside',
          env: {},
          timeoutMs: 5_000,
        })
      ).rejects.toThrow(/escapes/);
    }
  );
});

describe('GitRepository recovery reconciliation', () => {
  it('adopts worktrees, patches, and commits without duplicating durable work', async () => {
    const repositoryPath = await temporaryFixtureRepository();
    const worktreesRoot = await temporaryDirectory('qagent-recovery-worktrees-');
    const repository = new GitRepository();
    const status = await repository.inspect(repositoryPath);
    const runId = 'aa85c98c-a170-4ec4-a6f2-e41647562199';
    const created = await repository.reconcileWorktree(
      status,
      worktreesRoot,
      runId,
      'Recovered counter'
    );
    const worktree = created.worktree;

    try {
      expect(created.state).toBe('created');
      await expect(
        repository.reconcileWorktree(status, worktreesRoot, runId, 'Recovered counter')
      ).resolves.toMatchObject({ worktree, state: 'restored' });

      const patch = counterPatch();
      await expect(repository.reconcilePatch(worktree, patch, 10_000)).resolves.toMatchObject({
        state: 'applicable',
      });
      await repository.applyPatch(worktree, patch, 10_000);
      await expect(repository.applyPatch(worktree, patch, 10_000)).resolves.toMatchObject({
        files: ['src/counter.mjs'],
      });
      await expect(repository.reconcilePatch(worktree, patch, 10_000)).resolves.toMatchObject({
        state: 'already_applied',
      });

      const committed = await repository.reconcileCommit(
        worktree,
        ['src/counter.mjs'],
        'fix: increment once'
      );
      expect(committed.created).toBe(true);
      const resumed = await repository.reconcileCommit(
        worktree,
        ['src/counter.mjs'],
        'fix: increment once'
      );
      expect(resumed).toMatchObject({
        sha: committed.sha,
        treeSha: committed.treeSha,
        created: false,
      });
      await expect(
        repository.reconcileCommit(worktree, ['src/counter.mjs'], 'fix: unrelated replacement')
      ).rejects.toThrow(/does not match the expected repair commit/);
      await expect(repository.inspectWorktreeState(worktree)).resolves.toMatchObject({
        branch: worktree.branch,
        headSha: committed.sha,
        treeSha: committed.treeSha,
        dirty: false,
        changedFiles: ['src/counter.mjs'],
      });
    } finally {
      await repository.removeWorktree(repositoryPath, worktree.path);
    }
  });

  it('reconciles repeated pushes and uses an exact lease after a rebase', async () => {
    const repositoryPath = await temporaryFixtureRepository();
    const remotePath = await temporaryDirectory('qagent-recovery-remote-');
    const worktreesRoot = await temporaryDirectory('qagent-recovery-worktrees-');
    await git(remotePath, ['init', '--bare', '--initial-branch=main']);
    await git(repositoryPath, ['remote', 'add', 'origin', remotePath]);
    await git(repositoryPath, ['push', '-u', 'origin', 'main']);

    const repository = new GitRepository();
    const status = await repository.inspect(repositoryPath);
    const worktree = await repository.createWorktree(
      status,
      worktreesRoot,
      'bb85c98c-a170-4ec4-a6f2-e41647562199',
      'Recovered push'
    );
    try {
      await repository.applyPatch(worktree, counterPatch(), 10_000);
      await repository.commit(worktree, ['src/counter.mjs'], 'fix: increment once');
      const firstPush = await repository.reconcilePush(worktree, {
        forceWithLease: true,
        expectedRemoteSha: null,
      });
      expect(firstPush).toMatchObject({
        previousRemoteSha: null,
        remoteSha: firstPush.headSha,
        updated: true,
        forced: true,
      });
      await expect(
        repository.reconcilePush(worktree, {
          forceWithLease: true,
          expectedRemoteSha: null,
        })
      ).resolves.toMatchObject({
        headSha: firstPush.headSha,
        remoteSha: firstPush.headSha,
        updated: false,
        forced: false,
      });
      await expect(repository.reconcilePush(worktree)).resolves.toMatchObject({
        headSha: firstPush.headSha,
        remoteSha: firstPush.headSha,
        updated: false,
        forced: false,
      });

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
      const movedStatus = await repository.inspect(repositoryPath);
      await expect(
        repository.reconcileWorktree(
          movedStatus,
          worktreesRoot,
          'bb85c98c-a170-4ec4-a6f2-e41647562199',
          'Recovered push'
        )
      ).resolves.toMatchObject({
        state: 'restored',
        worktree: { baseSha: worktree.baseSha },
      });
      await expect(repository.rebaseOnce(worktree, 'main')).resolves.toBe(true);
      const forcedPush = await repository.reconcilePush(worktree, {
        forceWithLease: true,
        expectedRemoteSha: firstPush.remoteSha,
      });
      expect(forcedPush).toMatchObject({
        previousRemoteSha: firstPush.remoteSha,
        updated: true,
        forced: true,
      });
      expect(await git(remotePath, ['rev-parse', `refs/heads/${worktree.branch}`])).toBe(
        forcedPush.headSha
      );
    } finally {
      await repository.removeWorktree(repositoryPath, worktree.path);
    }
  });

  it('rejects a commit file set that could not be reconciled on retry', async () => {
    const repositoryPath = await temporaryFixtureRepository();
    const worktreesRoot = await temporaryDirectory('qagent-commit-files-worktrees-');
    const repository = new GitRepository();
    const status = await repository.inspect(repositoryPath);
    const worktree = await repository.createWorktree(
      status,
      worktreesRoot,
      'dd85c98c-a170-4ec4-a6f2-e41647562199',
      'Commit file identity'
    );

    try {
      await repository.applyPatch(worktree, counterPatch(), 10_000);
      await expect(
        repository.reconcileCommit(
          worktree,
          ['src/counter.mjs', 'README.md'],
          'fix: increment once'
        )
      ).rejects.toThrow(/missing expected changed paths: README\.md/);
      expect(await git(worktree.path, ['rev-parse', 'HEAD'])).toBe(worktree.baseSha);
    } finally {
      await repository.removeWorktree(repositoryPath, worktree.path);
    }
  });

  it('retains untracked repair files in diffs and idempotent commits', async () => {
    const repositoryPath = await temporaryFixtureRepository();
    const worktreesRoot = await temporaryDirectory('qagent-untracked-worktrees-');
    const repository = new GitRepository();
    const status = await repository.inspect(repositoryPath);
    const worktree = await repository.createWorktree(
      status,
      worktreesRoot,
      'cc85c98c-a170-4ec4-a6f2-e41647562199',
      'New repair file'
    );
    const file = 'src/recovery-note.mjs';
    try {
      await writeFile(join(worktree.path, file), 'export const recovered = true;\n');
      await expect(repository.changedFiles(worktree)).resolves.toEqual([file]);
      await expect(repository.diff(worktree)).resolves.toContain('export const recovered = true;');
      const committed = await repository.reconcileCommit(
        worktree,
        [file],
        'fix: retain recovery file'
      );
      expect(committed.created).toBe(true);
      await expect(
        repository.reconcileCommit(worktree, [file], 'fix: retain recovery file')
      ).resolves.toMatchObject({ sha: committed.sha, created: false });
    } finally {
      await repository.removeWorktree(repositoryPath, worktree.path);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'bounds a stalled Git command and leaves no child process behind',
    async () => {
      const root = await temporaryDirectory('qagent-stalled-git-');
      const binaryDirectory = join(root, 'bin');
      const fakeGit = join(binaryDirectory, 'git');
      await mkdir(binaryDirectory);
      await writeFile(
        fakeGit,
        ['#!/bin/sh', 'printf "gitpid=%s\\n" "$$"', 'sleep 60', ''].join('\n')
      );
      await chmod(fakeGit, 0o700);

      const previousPath = process.env.PATH;
      process.env.PATH = `${binaryDirectory}:${previousPath ?? ''}`;
      let gitPid: number | null = null;
      try {
        const error = await new GitRepository()
          .inspect(root, { timeoutMs: 500 })
          .then(() => null)
          .catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('timed out after 500ms');
        gitPid = Number(/gitpid=(\d+)/.exec((error as Error).message)?.[1]);
        expect(Number.isSafeInteger(gitPid) && gitPid > 0).toBe(true);
        await waitUntil(() => gitPid !== null && !pidAlive(gitPid), 3_000);
      } finally {
        process.env.PATH = previousPath;
        if (gitPid !== null) killIfAlive(gitPid);
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a timed-out Git command even when it traps TERM and exits zero',
    async () => {
      const root = await temporaryDirectory('qagent-zero-exit-git-');
      const binaryDirectory = join(root, 'bin');
      const fakeGit = join(binaryDirectory, 'git');
      await mkdir(binaryDirectory);
      await writeFile(
        fakeGit,
        [
          '#!/bin/sh',
          'trap \'printf "%s\\n" "$QAGENT_FAKE_GIT_ROOT"; exit 0\' TERM',
          'while :; do sleep 1; done',
          '',
        ].join('\n')
      );
      await chmod(fakeGit, 0o700);

      const previousPath = process.env.PATH;
      const previousRoot = process.env.QAGENT_FAKE_GIT_ROOT;
      process.env.PATH = `${binaryDirectory}:${previousPath ?? ''}`;
      process.env.QAGENT_FAKE_GIT_ROOT = root;
      try {
        await expect(new GitRepository().inspect(root, { timeoutMs: 250 })).rejects.toThrow(
          /timed out after 250ms/
        );
      } finally {
        process.env.PATH = previousPath;
        if (previousRoot === undefined) {
          delete process.env.QAGENT_FAKE_GIT_ROOT;
        } else {
          process.env.QAGENT_FAKE_GIT_ROOT = previousRoot;
        }
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'fails visibly instead of parsing truncated Git output',
    async () => {
      const root = await temporaryDirectory('qagent-noisy-git-');
      const binaryDirectory = join(root, 'bin');
      const fakeGit = join(binaryDirectory, 'git');
      await mkdir(binaryDirectory);
      await writeFile(
        fakeGit,
        ['#!/bin/sh', 'printf "%2048s\\n" "oversized"', 'exit 0', ''].join('\n')
      );
      await chmod(fakeGit, 0o700);

      const previousPath = process.env.PATH;
      process.env.PATH = `${binaryDirectory}:${previousPath ?? ''}`;
      try {
        await expect(new GitRepository().inspect(root, { maxOutputBytes: 256 })).rejects.toThrow(
          /output exceeded 256 bytes/
        );
      } finally {
        process.env.PATH = previousPath;
      }
    }
  );
});

function processTreeCommand(pidFile: string, timeoutMs: number) {
  return {
    executable: process.execPath,
    args: [
      '-e',
      [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'writeFileSync(process.env.QAGENT_PID_FILE, String(child.pid));',
        'process.on("SIGTERM", () => {});',
        'setInterval(() => {}, 1000);',
      ].join(''),
    ],
    cwd: '.',
    env: { QAGENT_PID_FILE: pidFile },
    timeoutMs,
  };
}

function counterPatch(): string {
  return [
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
}

async function waitForPid(path: string): Promise<number> {
  let pid: number | null = null;
  await waitUntil(async () => {
    try {
      pid = Number(await readFile(path, 'utf8'));
      return Number.isSafeInteger(pid) && pid > 0;
    } catch {
      return false;
    }
  });
  if (pid === null) throw new Error(`Process did not write a PID to ${path}`);
  return pid;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killIfAlive(pid: number): void {
  if (!pidAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The process exited between the liveness check and the signal.
  }
}
