import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GitHubPublisher,
  GitRepository,
  ProcessRunner,
  inspectPatch,
  runCredentialBackedSmoke,
  runDoctor,
  type AdapterSmokeDependencies,
  type DoctorDependencies,
  type GitHubApi,
  type GitHubPullRequestInspection,
  type GitHubRepositoryProbe,
  type Worktree,
} from '@qagent/adapters';
import { QAgentConfigSchema, type QAgentConfig } from '@qagent/contracts';
import { describe, expect, it, vi } from 'vitest';
import { git, temporaryDirectory, temporaryFixtureRepository } from '../helpers.js';

const checkedAt = new Date('2026-07-23T12:00:00.000Z');

describe('GitRepository uncovered recovery and safety paths', () => {
  it('inspects deleted files from their source path and deduplicates patch entries', () => {
    const patch = [
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-old',
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-old',
      '',
    ].join('\n');

    expect(inspectPatch(patch)).toEqual({ files: ['src/old.ts'], highRisk: false });
  });

  it('adopts an existing repair branch after its old worktree was removed', async () => {
    const repositoryPath = await temporaryFixtureRepository();
    const worktreesRoot = await temporaryDirectory('qagent-adopted-worktree-');
    const repository = new GitRepository();
    const status = await repository.inspect(repositoryPath);
    const runId = '11111111-1111-4111-8111-111111111111';
    const first = await repository.reconcileWorktree(
      status,
      worktreesRoot,
      runId,
      'adopt existing branch'
    );
    await repository.removeWorktree(repositoryPath, first.worktree.path);

    const adopted = await repository.reconcileWorktree(
      status,
      worktreesRoot,
      runId,
      'adopt existing branch'
    );
    try {
      expect(adopted).toMatchObject({
        state: 'adopted',
        worktree: { branch: first.worktree.branch, baseSha: status.headSha },
      });
    } finally {
      await repository.removeWorktree(repositoryPath, adopted.worktree.path);
    }
  });

  it('rejects a repair branch registered at another path', async () => {
    const repositoryPath = await temporaryFixtureRepository();
    const worktreesRoot = await temporaryDirectory('qagent-branch-collision-');
    const unexpectedPath = await temporaryDirectory('qagent-unexpected-worktree-');
    await rm(unexpectedPath, { recursive: true, force: true });
    const runId = '22222222-2222-4222-8222-222222222222';
    const branch = 'qagent/22222222-branch-collision';
    await git(repositoryPath, ['worktree', 'add', '-b', branch, unexpectedPath, 'HEAD']);
    const repository = new GitRepository();

    try {
      await expect(
        repository.reconcileWorktree(
          await repository.inspect(repositoryPath),
          worktreesRoot,
          runId,
          'branch collision'
        )
      ).rejects.toThrow(/unexpected path/);
    } finally {
      await repository.removeWorktree(repositoryPath, unexpectedPath);
    }
  });

  it('rejects the wrong branch at the persisted path and an unrecoverable occupied path', async () => {
    const repositoryPath = await temporaryFixtureRepository();
    const repository = new GitRepository();
    const status = await repository.inspect(repositoryPath);
    const worktreesRoot = await temporaryDirectory('qagent-wrong-branch-');
    const wrongRunId = '33333333-3333-4333-8333-333333333333';
    const expectedPath = join(worktreesRoot, wrongRunId);
    await git(repositoryPath, ['worktree', 'add', '-b', 'wrong-branch', expectedPath, 'HEAD']);

    try {
      await expect(
        repository.reconcileWorktree(status, worktreesRoot, wrongRunId, 'expected branch')
      ).rejects.toThrow(/branch no longer matches/);
    } finally {
      await repository.removeWorktree(repositoryPath, expectedPath);
    }

    const occupiedRunId = '44444444-4444-4444-8444-444444444444';
    await mkdir(join(worktreesRoot, occupiedRunId));
    await expect(
      repository.reconcileWorktree(status, worktreesRoot, occupiedRunId, 'occupied path')
    ).rejects.toThrow(/already exists and could not be reconciled/);
  });

  it('restores an explicitly expected detached worktree but rejects another detached head', async () => {
    const repositoryPath = await temporaryFixtureRepository();
    const worktreesRoot = await temporaryDirectory('qagent-detached-worktree-');
    const repository = new GitRepository();
    const status = await repository.inspect(repositoryPath);
    const worktree = await repository.createWorktree(
      status,
      worktreesRoot,
      '55555555-5555-4555-8555-555555555555',
      'detached restore'
    );
    await git(worktree.path, ['checkout', '--detach']);
    const head = await git(worktree.path, ['rev-parse', 'HEAD']);

    try {
      await expect(
        repository.restoreWorktree(worktree.path, worktree.branch, worktree.baseSha, {
          allowDetached: true,
          expectedHeadSha: head,
        })
      ).resolves.toMatchObject({ branch: worktree.branch });
      await expect(
        repository.restoreWorktree(worktree.path, worktree.branch, worktree.baseSha, {
          allowDetached: true,
          expectedHeadSha: 'a'.repeat(40),
        })
      ).rejects.toThrow(/branch no longer matches/);
    } finally {
      await repository.removeWorktree(repositoryPath, worktree.path);
    }
  });

  it('reports irreconcilable patches and rejects them on apply', async () => {
    const fixture = await gitWorktree('66666666-6666-4666-8666-666666666666');
    const conflict = [
      'diff --git a/src/counter.mjs b/src/counter.mjs',
      '--- a/src/counter.mjs',
      '+++ b/src/counter.mjs',
      '@@ -20,1 +20,1 @@',
      '-line-that-does-not-exist',
      '+replacement',
      '',
    ].join('\n');
    try {
      await expect(
        fixture.repository.reconcilePatch(fixture.worktree, conflict, 10_000)
      ).resolves.toMatchObject({ state: 'conflict', detail: expect.any(String) });
      await expect(
        fixture.repository.applyPatch(fixture.worktree, conflict, 10_000)
      ).rejects.toThrow(/cannot be applied or reconciled/);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects empty, unsafe, unexpectedly staged, and extra changed commit sets', async () => {
    const fixture = await gitWorktree('77777777-7777-4777-8777-777777777777');
    try {
      await expect(
        fixture.repository.reconcileCommit(fixture.worktree, [], 'empty')
      ).rejects.toThrow(/empty file set/);
      await expect(
        fixture.repository.reconcileCommit(fixture.worktree, ['.env'], 'unsafe')
      ).rejects.toThrow(/unsafe path/);
      await expect(
        fixture.repository.reconcileCommit(fixture.worktree, ['src/counter.mjs'], 'no changes')
      ).rejects.toThrow(/no changes to commit/);

      await writeFile(join(fixture.worktree.path, 'README.md'), 'staged surprise\n');
      await git(fixture.worktree.path, ['add', 'README.md']);
      await expect(
        fixture.repository.reconcileCommit(
          fixture.worktree,
          ['src/counter.mjs'],
          'unexpected staged'
        )
      ).rejects.toThrow(/unexpected staged paths/);
      await git(fixture.worktree.path, ['reset', '--hard', 'HEAD']);

      await writeFile(join(fixture.worktree.path, 'README.md'), 'extra change\n');
      await writeFile(
        join(fixture.worktree.path, 'src/counter.mjs'),
        'export const changed = true;\n'
      );
      await expect(
        fixture.repository.reconcileCommit(fixture.worktree, ['src/counter.mjs'], 'extra change')
      ).rejects.toThrow(/unexpected changed paths/);
      await git(fixture.worktree.path, ['reset', '--hard', 'HEAD']);

      await writeFile(
        join(fixture.worktree.path, 'src/counter.mjs'),
        'export const fixed = true;\n'
      );
      await fixture.repository.reconcileCommit(
        fixture.worktree,
        ['src/counter.mjs'],
        'expected repair'
      );
      await writeFile(
        join(fixture.worktree.path, 'src/counter.mjs'),
        'export const dirty = true;\n'
      );
      await expect(
        fixture.repository.reconcileCommit(fixture.worktree, ['src/counter.mjs'], 'expected repair')
      ).rejects.toThrow(/additional uncommitted changes/);
    } finally {
      await fixture.cleanup();
    }
  });

  it('detects a moved remote before a force-with-lease update and observes an upstream', async () => {
    const repositoryPath = await temporaryFixtureRepository();
    const remotePath = await temporaryDirectory('qagent-cas-remote-');
    const worktreesRoot = await temporaryDirectory('qagent-cas-worktrees-');
    await git(remotePath, ['init', '--bare', '--initial-branch=main']);
    await git(repositoryPath, ['remote', 'add', 'origin', remotePath]);
    await git(repositoryPath, ['push', '-u', 'origin', 'main']);
    const repository = new GitRepository();
    const status = await repository.inspect(repositoryPath);
    const worktree = await repository.createWorktree(
      status,
      worktreesRoot,
      '88888888-8888-4888-8888-888888888888',
      'remote compare and swap'
    );
    try {
      await writeFile(join(worktree.path, 'src/counter.mjs'), 'export const fixed = true;\n');
      await repository.commit(worktree, ['src/counter.mjs'], 'repair');
      const pushed = await repository.reconcilePush(worktree, {
        forceWithLease: true,
        expectedRemoteSha: null,
      });
      await expect(repository.inspectWorktreeState(worktree)).resolves.toMatchObject({
        upstream: `origin/${worktree.branch}`,
        upstreamSha: pushed.headSha,
      });

      await git(remotePath, ['update-ref', `refs/heads/${worktree.branch}`, status.headSha]);
      await expect(
        repository.reconcilePush(worktree, {
          forceWithLease: true,
          expectedRemoteSha: pushed.remoteSha,
        })
      ).rejects.toThrow(/moved from the expected/);
    } finally {
      await repository.removeWorktree(repositoryPath, worktree.path);
    }
  });

  it.each([
    [{ owner: 'bad owner', repo: 'repo' }, 'qagent/run', 'token', 'user'],
    [{ owner: 'owner', repo: 'bad repo' }, 'qagent/run', 'token', 'user'],
    [{ owner: 'owner', repo: 'repo' }, 'qagent/a..b', 'token', 'user'],
    [{ owner: 'owner', repo: 'repo' }, 'qagent/a@{b', 'token', 'user'],
    [{ owner: 'owner', repo: 'repo' }, 'qagent/a//b', 'token', 'user'],
    [{ owner: 'owner', repo: 'repo' }, 'qagent/run', 'bad\ntoken', 'user'],
    [{ owner: 'owner', repo: 'repo' }, 'qagent/run', 'token', 'bad\nuser'],
  ])(
    'validates every token-scoped GitHub push component',
    async (repositoryRef, branch, token, user) => {
      await expect(
        new GitRepository().reconcilePush(
          { path: '/missing', branch, baseSha: 'a'.repeat(40) },
          {
            github: { repository: repositoryRef, token, username: user },
          }
        )
      ).rejects.toThrow(/push configuration is invalid/);
    }
  );

  it('returns early for an already checked-out merged commit and prunes an absent worktree', async () => {
    const fixture = await gitWorktree('99999999-9999-4999-8999-999999999999');
    const head = await git(fixture.worktree.path, ['rev-parse', 'HEAD']);
    await expect(
      fixture.repository.checkoutMergedCommit(fixture.worktree, 'main', head)
    ).resolves.toBeUndefined();
    await fixture.repository.removeWorktree(fixture.repositoryPath, fixture.worktree.path);
    await expect(
      fixture.repository.removeWorktree(fixture.repositoryPath, fixture.worktree.path)
    ).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'skips missing, oversized, and out-of-root symlink context files',
    async () => {
      const repositoryPath = await temporaryFixtureRepository();
      const outside = await temporaryDirectory('qagent-context-outside-');
      const outsideFile = join(outside, 'outside.txt');
      await writeFile(outsideFile, 'outside context');
      await writeFile(join(repositoryPath, 'missing.txt'), 'remove later\n');
      await writeFile(join(repositoryPath, 'oversized.txt'), 'x'.repeat(61_000));
      await symlink(outsideFile, join(repositoryPath, 'linked.txt'));
      await git(repositoryPath, ['add', 'missing.txt', 'oversized.txt', 'linked.txt']);
      await git(repositoryPath, [
        '-c',
        'user.name=QAgent tests',
        '-c',
        'user.email=tests@qagent.local',
        'commit',
        '-m',
        'add context edge cases',
      ]);
      const fixture = await gitWorktree('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repositoryPath);
      await rm(join(fixture.worktree.path, 'missing.txt'));
      try {
        const context = await fixture.repository.gatherContext(
          fixture.worktree.path,
          'missing.txt oversized.txt linked.txt'
        );
        expect(context).not.toContain('outside context');
        expect(context).not.toContain('x'.repeat(100));
      } finally {
        await fixture.cleanup();
      }
    }
  );
});

describe('GitHubPublisher validation and state branches', () => {
  const repository = { owner: 'owner', repo: 'repo' };
  const worktree: Worktree = {
    path: '/tmp/qagent-worktree',
    branch: 'qagent/run',
    baseSha: 'a'.repeat(40),
  };

  it('requires a successful identity probe before direct push', async () => {
    const fixture = githubFixture();
    await expect(fixture.publisher.push(worktree)).rejects.toThrow(/must be probed/);
    expect(fixture.push).not.toHaveBeenCalled();
  });

  it('infers permissions from a role and applies absent repository defaults', async () => {
    const fixture = githubFixture({
      repositoryData: {
        full_name: 'owner/repo',
        default_branch: 'main',
      },
      permission: { permission: 'maintain' },
      oauthScopes: 42,
      protectionStatus: 404,
    });

    await expect(fixture.publisher.probeRepository(repository)).resolves.toMatchObject({
      repository: { archived: false, disabled: false },
      permissions: {
        role: 'maintain',
        canPull: true,
        canPush: true,
        canAdminister: false,
        pullRequests: 'unverified',
      },
      rules: { classicProtection: 'unprotected' },
      merge: { allowAutoMerge: false, allowedMethods: [] },
    });
  });

  it('reports unavailable protection and propagates unexpected protection failures', async () => {
    await expect(
      githubFixture({ protectionStatus: 403 }).publisher.probeRepository(repository)
    ).resolves.toMatchObject({ rules: { classicProtection: 'unavailable' } });
    await expect(
      githubFixture({ protectionStatus: 500 }).publisher.probeRepository(repository)
    ).rejects.toThrow(/classic branch protection failed/);
  });

  it.each([
    [{ owner: '../owner', repo: 'repo' }, 1],
    [{ owner: 'owner', repo: 'repo/extra' }, 1],
    [{ owner: 'owner', repo: 'repo' }, Number.MAX_SAFE_INTEGER + 1],
  ])('rejects invalid repository or pull-request identifiers', async (repositoryRef, number) => {
    await expect(
      githubFixture().publisher.inspectPullRequest(repositoryRef, number)
    ).rejects.toThrow(/plain path segments|positive safe integer/);
  });

  it.each([
    null,
    {},
    { id: '', number: 7, url: 'https://github.com/owner/repo/pull/7', state: 'OPEN' },
    {
      ...pullSnapshot(),
      number: 8,
    },
    {
      ...pullSnapshot(),
      url: 'https://github.com/other/repo/pull/7',
    },
    {
      ...pullSnapshot(),
      merged: 'false',
    },
    {
      ...pullSnapshot(),
      reviewDecision: 42,
    },
  ])('rejects malformed pull-request snapshot %#', async (snapshot) => {
    await expect(
      githubFixture({ snapshots: [snapshot] }).publisher.inspectPullRequest(repository, 7)
    ).rejects.toThrow(/node was not found|did not match/);
  });

  it('maps merged, closed, conflict, unknown-dirty, and queue-eligible snapshots', async () => {
    const sha = 'b'.repeat(40);
    const cases = [
      {
        snapshot: pullSnapshot({ state: 'MERGED', merged: true, mergeCommitSha: sha }),
        expected: { finalState: 'merged', mergeCommitSha: sha },
      },
      {
        snapshot: pullSnapshot({ state: 'MERGED', merged: true, mergeCommitSha: 'invalid' }),
        expected: { finalState: 'merged', mergeCommitSha: null },
      },
      {
        snapshot: pullSnapshot({ state: 'CLOSED' }),
        expected: { finalState: 'closed-unmerged' },
      },
      {
        snapshot: pullSnapshot({ mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' }),
        expected: { finalState: 'conflict' },
      },
      {
        snapshot: pullSnapshot({ mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' }),
        expected: { finalState: 'open' },
      },
      {
        snapshot: pullSnapshot({
          mergeStateStatus: 'HAS_HOOKS',
          checksState: null,
          reviewDecision: null,
        }),
        expected: { finalState: 'open', mergeEligible: true },
      },
    ];
    for (const scenario of cases) {
      await expect(
        githubFixture({ snapshots: [scenario.snapshot] }).publisher.inspectPullRequest(
          repository,
          7
        )
      ).resolves.toMatchObject(scenario.expected);
    }
  });

  it('returns an explicit unobserved state when a zero-length pull wait makes no request', async () => {
    const fixture = githubFixture({ waitTimeoutMs: 0 });
    await expect(fixture.publisher.waitForPull(repository, 7)).resolves.toEqual({
      state: 'open',
      mergeCommitSha: null,
      detail: 'GitHub pull request state was not observed before the bounded wait ended.',
    });
    expect(fixture.graphql).not.toHaveBeenCalled();
  });

  it('blocks archived repositories and unsupported merge methods before automation', async () => {
    const archived = githubFixture({
      repositoryData: healthyRepositoryData({ archived: true }),
    });
    await expect(archived.publisher.publish(publicationOptions(worktree))).rejects.toThrow(
      /archived or disabled/
    );
    expect(archived.push).not.toHaveBeenCalled();

    const unsupported = githubFixture({
      repositoryData: healthyRepositoryData({
        allow_merge_commit: false,
        allow_rebase_merge: false,
        allow_squash_merge: true,
      }),
    });
    await expect(
      unsupported.publisher.publish({ ...publicationOptions(worktree), mergeMethod: 'merge' })
    ).resolves.toMatchObject({
      state: 'blocked',
      detail: expect.stringContaining('does not allow the requested merge'),
    });
  });

  it('returns an already-terminal initial snapshot without enabling automation', async () => {
    const fixture = githubFixture({ snapshots: [pullSnapshot({ state: 'CLOSED' })] });
    await expect(fixture.publisher.publish(publicationOptions(worktree))).resolves.toMatchObject({
      state: 'blocked',
      created: true,
    });
    expect(fixture.graphql).not.toHaveBeenCalledWith(
      expect.stringContaining('QAgentEnableAutoMerge'),
      expect.anything()
    );
  });

  it('surfaces missing auto-merge and merge-queue confirmations as actionable pending detail', async () => {
    const noAutoMergeConfirmation = githubFixture({
      autoMergeResponse: { enablePullRequestAutoMerge: null },
    });
    await expect(
      noAutoMergeConfirmation.publisher.publish(publicationOptions(worktree))
    ).resolves.toMatchObject({
      state: 'open',
      autoMergeEnabled: false,
      detail: expect.stringContaining('did not confirm auto-merge enablement'),
    });

    const noQueueConfirmation = githubFixture({
      activeRules: ['merge_queue'],
      enqueueResponse: { enqueuePullRequest: null },
    });
    await expect(
      noQueueConfirmation.publisher.publish(publicationOptions(worktree))
    ).resolves.toMatchObject({
      state: 'open',
      detail: expect.stringContaining('did not confirm merge queue enrollment'),
    });
  });

  it('leaves an ineligible required-queue pull request open after the bounded wait', async () => {
    const fixture = githubFixture({
      activeRules: ['merge_queue'],
      snapshots: [pullSnapshot(), pullSnapshot({ checksState: 'FAILURE' })],
      waitTimeoutMs: 0,
    });
    await expect(fixture.publisher.publish(publicationOptions(worktree))).resolves.toMatchObject({
      state: 'open',
      detail: expect.stringContaining('did not become eligible'),
    });
  });

  it('filters unrelated pull requests and accepts a matching head whose repository is absent', async () => {
    const fixture = githubFixture({
      existingPulls: [
        pullListItem({ number: 1, head: 'other' }),
        pullListItem({ number: 2, base: 'develop' }),
        pullListItem({ number: 3, fullName: 'other/repo' }),
        pullListItem({ number: 4, fullName: null, state: 'open' }),
      ],
      snapshots: [
        {
          ...pullSnapshot(),
          number: 4,
          url: 'https://github.com/owner/repo/pull/4',
        },
      ],
    });
    await expect(
      fixture.publisher.publish({ ...publicationOptions(worktree), autoMerge: false })
    ).resolves.toMatchObject({ number: 4, created: false, state: 'open' });
    expect(fixture.createPull).not.toHaveBeenCalled();
  });

  it('forwards caller cancellation while an authenticated request is stalled', async () => {
    const fixture = githubFixture({ hangRoute: 'GET /user', requestTimeoutMs: 1_000 });
    const controller = new AbortController();
    const pending = fixture.publisher.probeRepository(repository, 'main', controller.signal);
    setTimeout(() => controller.abort(new Error('cancel GitHub probe')), 5);
    await expect(pending).rejects.toThrow('cancel GitHub probe');
  });
});

describe('Doctor provider-state and corrective-action branches', () => {
  it('distinguishes partially configured and failed Browserbase connections', async () => {
    const config = browserbaseDoctorConfig();
    const partial = await runDoctor({
      qagentHome: '/qagent',
      config,
      dependencies: doctorDependencies({
        environment: { BROWSERBASE_API_KEY: 'key-only' },
      }),
    });
    expect(partial.checks.find((item) => item.id === 'browser')).toMatchObject({
      code: 'browserbase.unconfigured',
      providerState: 'unconfigured',
      correctiveAction: { action: 'configure_provider' },
    });

    const secret = 'browserbase-private-key';
    const failed = await runDoctor({
      qagentHome: '/qagent',
      config,
      dependencies: doctorDependencies({
        environment: {
          BROWSERBASE_API_KEY: secret,
          BROWSERBASE_PROJECT_ID: 'project',
        },
        probeBrowserbase: async () => {
          throw new Error(`provider rejected ${secret}`);
        },
      }),
    });
    const browser = failed.checks.find((item) => item.id === 'browser');
    expect(browser).toMatchObject({ code: 'browserbase.probe-failed', providerState: 'error' });
    expect(browser?.detail).not.toContain(secret);
  });

  it('requires both a GitHub token and a trusted project path', async () => {
    const config = githubDoctorConfig();
    const noProject = await runDoctor({
      qagentHome: '/qagent',
      config,
      dependencies: doctorDependencies({ environment: { GITHUB_TOKEN: 'token' } }),
    });
    expect(noProject.checks.find((item) => item.id === 'github')).toMatchObject({
      code: 'github.unconfigured',
      detail: expect.stringContaining('trusted project path'),
    });
  });

  it('accepts a complete GitHub capability probe and rejects each missing capability', async () => {
    const config = githubDoctorConfig();
    const ready = await runDoctor({
      qagentHome: '/qagent',
      projectPath: '/repo',
      config,
      dependencies: doctorDependencies({
        environment: { GITHUB_TOKEN: 'token' },
        probeGitHub: async () => githubProbe(),
      }),
    });
    expect(ready.checks.find((item) => item.id === 'github')).toMatchObject({
      code: 'github.healthy',
      providerState: 'healthy',
    });

    const mutations: Array<(probe: GitHubRepositoryProbe) => void> = [
      (probe) => {
        probe.repository.archived = true;
      },
      (probe) => {
        probe.repository.disabled = true;
      },
      (probe) => {
        probe.permissions.canPull = false;
      },
      (probe) => {
        probe.permissions.canPush = false;
      },
      (probe) => {
        probe.permissions.pullRequests = 'unverified';
      },
      (probe) => {
        probe.rules.classicProtection = 'unavailable';
      },
      (probe) => {
        probe.merge.allowedMethods = [];
      },
    ];
    for (const mutate of mutations) {
      const probe = githubProbe();
      mutate(probe);
      const report = await runDoctor({
        qagentHome: '/qagent',
        projectPath: '/repo',
        config,
        dependencies: doctorDependencies({
          environment: { GITHUB_TOKEN: 'token' },
          probeGitHub: async () => probe,
        }),
      });
      expect(report.checks.find((item) => item.id === 'github')).toMatchObject({
        code: 'github.probe-failed',
        providerState: 'error',
        correctiveAction: { action: 'configure_provider' },
      });
    }
  });

  it('covers unconfigured, accepted, and failed Weave states without blocking local work', async () => {
    const config = weaveDoctorConfig();
    const missing = await runDoctor({
      qagentHome: '/qagent',
      config,
      dependencies: doctorDependencies(),
    });
    expect(missing.checks.find((item) => item.id === 'weave')).toMatchObject({
      code: 'weave.unconfigured',
      providerState: 'unconfigured',
    });

    const accepted = await runDoctor({
      qagentHome: '/qagent',
      config,
      dependencies: doctorDependencies({
        environment: {
          WANDB_API_KEY: 'weave-key',
          QAGENT_WEAVE_DISCLOSURE_ACCEPTED: 'YES',
        },
        probeWeave: async () => 'entity/project',
      }),
    });
    expect(accepted.checks.find((item) => item.id === 'weave')).toMatchObject({
      code: 'weave.healthy',
      status: 'pass',
      correctiveAction: null,
    });

    const failed = await runDoctor({
      qagentHome: '/qagent',
      config,
      dependencies: doctorDependencies({
        environment: { WANDB_API_KEY: 'weave-key' },
        probeWeave: async () => {
          throw 'unreachable';
        },
      }),
    });
    expect(failed.checks.find((item) => item.id === 'weave')).toMatchObject({
      code: 'weave.probe-failed',
      status: 'warn',
      providerState: 'error',
    });
  });
});

describe('credential-backed smoke error and provenance branches', () => {
  it('reports partial configurations and honors provider-specific model overrides', async () => {
    const probes = smokeDependencies();
    const report = await runCredentialBackedSmoke(
      {
        OPENAI_API_KEY: 'openai',
        QAGENT_SMOKE_OPENAI_MODEL: 'custom-openai',
        ANTHROPIC_API_KEY: 'anthropic',
        QAGENT_SMOKE_ANTHROPIC_MODEL: 'custom-anthropic',
        GOOGLE_API_KEY: 'google',
        QAGENT_SMOKE_GOOGLE_MODEL: 'custom-google',
        QAGENT_OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
        GITHUB_TOKEN: 'token-only',
        BROWSERBASE_API_KEY: 'key-only',
        VERCEL_TOKEN: 'token-only',
      },
      probes
    );

    expect(vi.mocked(probes.probeModel).mock.calls.map(([config]) => config.model)).toEqual([
      'custom-openai',
      'custom-anthropic',
      'custom-google',
    ]);
    expect(integrationByProvider(report.integrations, 'github').detail).toContain(
      'GITHUB_REPOSITORY'
    );
    expect(integrationByProvider(report.integrations, 'browserbase').detail).toContain(
      'BROWSERBASE_PROJECT_ID'
    );
    expect(integrationByProvider(report.integrations, 'vercel').detail).toContain(
      'VERCEL_PROJECT_ID'
    );
  });

  it('rejects malformed GitHub repository and pull-request settings as probe errors', async () => {
    const malformedRepository = await runCredentialBackedSmoke(
      { GITHUB_TOKEN: 'token', GITHUB_REPOSITORY: 'owner/' },
      smokeDependencies()
    );
    expect(integrationByProvider(malformedRepository.integrations, 'github')).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('owner/repository'),
    });

    const malformedPull = await runCredentialBackedSmoke(
      {
        GITHUB_TOKEN: 'token',
        GITHUB_REPOSITORY: 'owner/repo',
        QAGENT_SMOKE_GITHUB_PR_NUMBER: '0',
      },
      smokeDependencies()
    );
    expect(integrationByProvider(malformedPull.integrations, 'github')).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('positive safe integer'),
    });
  });

  it('rejects every incomplete GitHub publication capability', async () => {
    const mutations: Array<(probe: GitHubRepositoryProbe) => void> = [
      (probe) => {
        probe.repository.archived = true;
      },
      (probe) => {
        probe.repository.disabled = true;
      },
      (probe) => {
        probe.permissions.canPull = false;
      },
      (probe) => {
        probe.permissions.canPush = false;
      },
      (probe) => {
        probe.permissions.pullRequests = 'read';
      },
      (probe) => {
        probe.rules.classicProtection = 'unavailable';
      },
      (probe) => {
        probe.merge.allowedMethods = [];
      },
    ];
    for (const mutate of mutations) {
      const probe = githubProbe();
      mutate(probe);
      const probes = smokeDependencies({
        probeGitHub: async () => ({ repository: probe, pullRequest: null }),
      });
      const report = await runCredentialBackedSmoke(
        { GITHUB_TOKEN: 'token', GITHUB_REPOSITORY: 'owner/repo' },
        probes
      );
      expect(integrationByProvider(report.integrations, 'github').status).toBe('error');
    }
  });

  it('records unavailable pull details and required merge queue state without fabricating values', async () => {
    const probe = githubProbe();
    probe.merge.mergeQueueRequired = true;
    const pullRequest: GitHubPullRequestInspection = {
      capturedAt: checkedAt.toISOString(),
      repositoryFullName: 'owner/repo',
      number: 17,
      url: 'https://github.com/owner/repo/pull/17',
      providerState: 'OPEN',
      finalState: 'open',
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'UNKNOWN',
      mergeEligible: false,
      reviewDecision: null,
      checksState: null,
      mergeQueueState: null,
      autoMergeEnabled: false,
      mergeCommitSha: null,
      detail: 'Provider values remain unavailable.',
    };
    const report = await runCredentialBackedSmoke(
      {
        GITHUB_TOKEN: 'token',
        GITHUB_REPOSITORY: 'owner/repo',
        QAGENT_SMOKE_GITHUB_PR_NUMBER: '17',
      },
      smokeDependencies({
        probeGitHub: async () => ({ repository: probe, pullRequest }),
      })
    );
    const github = integrationByProvider(report.integrations, 'github');
    expect(github).toMatchObject({
      status: 'healthy',
      detail: expect.stringContaining('reviews unavailable; checks unavailable; queue not queued'),
    });
    expect(github.detail).toContain('merge queue required');
  });

  it('turns HTTP failures, non-Error probe failures, and invalid Weave project IDs into errors', async () => {
    const vercel = await runCredentialBackedSmoke(
      { VERCEL_TOKEN: 'token', VERCEL_PROJECT_ID: 'project' },
      smokeDependencies({
        fetch: vi.fn(async () => new Response(null, { status: 503 })),
      })
    );
    expect(integrationByProvider(vercel.integrations, 'vercel')).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('HTTP 503'),
    });

    const nonError = await runCredentialBackedSmoke(
      { REDIS_URL: 'redis://localhost' },
      smokeDependencies({
        probeRedis: async () => {
          throw 'redis unavailable';
        },
      })
    );
    expect(integrationByProvider(nonError.integrations, 'redis')).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('redis unavailable'),
    });

    const weave = await runCredentialBackedSmoke(
      {
        WANDB_API_KEY: 'key',
        QAGENT_SMOKE_WEAVE_DISCLOSURE_ACCEPTED: 'on',
      },
      smokeDependencies({
        probeWeave: async () => 'invalid-project',
      })
    );
    expect(integrationByProvider(weave.integrations, 'weave')).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('valid entity/project'),
    });
  });
});

describe('ProcessRunner option, redaction, and bounded-output branches', () => {
  it('rejects pre-aborted execution and every non-positive execution bound', async () => {
    const root = await temporaryDirectory('qagent-process-options-');
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    await expect(
      new ProcessRunner().run(root, command('process.exit(0)'), controller.signal)
    ).rejects.toThrow('already cancelled');
    await expect(
      new ProcessRunner().start(root, command('process.exit(0)'), controller.signal)
    ).rejects.toThrow('already cancelled');

    for (const options of [
      { maxOutputBytes: 0 },
      { maxStreamBytes: -1 },
      { maxChunkCharacters: 1.5 },
      { stopGraceMs: 0 },
      { stopKillWaitMs: Number.NaN },
    ]) {
      await expect(
        new ProcessRunner().run(root, command('process.exit(0)'), undefined, options)
      ).rejects.toThrow(/positive integer/);
    }
  });

  it('writes stdin, tolerates observer failure, and makes repeated post-exit stop idempotent', async () => {
    const root = await temporaryDirectory('qagent-process-input-');
    const observer = vi.fn(() => {
      throw new Error('observer must not affect execution');
    });
    const managed = await new ProcessRunner().start(
      root,
      command(
        'let value = ""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => console.log(value))'
      ),
      undefined,
      { input: 'grounded input', onOutput: observer }
    );
    await expect(managed.result).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'grounded input',
    });
    await managed.stop();
    await managed.stop();
    expect(observer).toHaveBeenCalled();
  });

  it('redacts a multiline value in pending snapshots and flushes it on termination', async () => {
    const root = await temporaryDirectory('qagent-process-multiline-');
    const secret = 'first-line\nsecond-line';
    const managed = await new ProcessRunner().start(
      root,
      command('process.stdout.write(process.env.VALUE); setInterval(() => {}, 1000)', {
        VALUE: secret,
      }),
      undefined,
      { redactValues: [secret], stopGraceMs: 50, stopKillWaitMs: 200 }
    );
    await waitUntil(() => managed.snapshot().stdout.length > 0);
    expect(managed.snapshot().stdout).not.toContain('first-line');
    await managed.stop();
    const result = await managed.result;
    expect(result.stdout).toBe('*'.repeat(secret.length));
  });

  it('preserves UTF-8 boundaries with tiny retained and streamed budgets', async () => {
    const root = await temporaryDirectory('qagent-process-tiny-output-');
    const chunks: string[] = [];
    const result = await new ProcessRunner().run(
      root,
      command('process.stdout.write("😀abcdef"); process.stderr.write("tail")'),
      undefined,
      {
        maxOutputBytes: 8,
        maxStreamBytes: 1,
        maxChunkCharacters: 1,
        onOutput: (chunk) => chunks.push(chunk.text),
      }
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout).not.toContain('\uFFFD');
    expect(result.stderr).not.toContain('\uFFFD');
    expect(Buffer.byteLength(chunks.join(''))).toBeLessThanOrEqual(1);
    expect(result.droppedBytes.streamed).toBeGreaterThan(0);
  });
});

async function gitWorktree(runId: string, repositoryPath?: string) {
  const projectPath = repositoryPath ?? (await temporaryFixtureRepository());
  const worktreesRoot = await temporaryDirectory('qagent-branch-coverage-worktrees-');
  const repository = new GitRepository();
  const worktree = await repository.createWorktree(
    await repository.inspect(projectPath),
    worktreesRoot,
    runId,
    'coverage workflow'
  );
  return {
    repository,
    repositoryPath: projectPath,
    worktree,
    cleanup: async () => repository.removeWorktree(projectPath, worktree.path),
  };
}

interface GitHubFixtureOptions {
  activeRules?: string[];
  autoMergeResponse?: unknown;
  enqueueResponse?: unknown;
  existingPulls?: ReturnType<typeof pullListItem>[];
  hangRoute?: string;
  oauthScopes?: string | number;
  permission?: { permission: string; role_name?: string };
  protectionStatus?: number;
  repositoryData?: Record<string, unknown>;
  requestTimeoutMs?: number;
  snapshots?: unknown[];
  waitTimeoutMs?: number;
}

function githubFixture(options: GitHubFixtureOptions = {}) {
  const push = vi.fn(async () => undefined);
  const request = vi.fn(async (route: string) => {
    if (route === options.hangRoute) return new Promise<never>(() => undefined);
    if (route === 'GET /user') return { data: { login: 'octocat' } };
    if (route === 'GET /repos/{owner}/{repo}') {
      return {
        data: options.repositoryData ?? healthyRepositoryData(),
        headers: { 'x-oauth-scopes': options.oauthScopes ?? 'repo' },
      };
    }
    if (route.includes('/collaborators/{username}/permission')) {
      return { data: options.permission ?? { permission: 'admin', role_name: 'admin' } };
    }
    if (route === 'GET /repos/{owner}/{repo}/pulls') return { data: [] };
    if (route.includes('/rules/branches/{branch}')) {
      return { data: (options.activeRules ?? []).map((type) => ({ type })) };
    }
    if (route.includes('/check-runs')) return { data: { total_count: 2 } };
    if (route.endsWith('/status')) return { data: { state: 'success', total_count: 1 } };
    if (route.includes('/protection')) {
      if (options.protectionStatus !== undefined) {
        throw Object.assign(new Error(`protection ${options.protectionStatus}`), {
          status: options.protectionStatus,
        });
      }
      return { data: {} };
    }
    throw new Error(`Unexpected route ${route}`);
  });
  const createPull = vi.fn(async () => ({
    data: { html_url: 'https://github.com/owner/repo/pull/7', number: 7 },
  }));
  const snapshots = options.snapshots ?? [pullSnapshot()];
  let snapshotIndex = 0;
  const graphql = vi.fn(async (query: string, _variables: Record<string, unknown>) => {
    if (query.includes('QAgentEnableAutoMerge')) {
      return 'autoMergeResponse' in options
        ? options.autoMergeResponse
        : {
            enablePullRequestAutoMerge: {
              pullRequest: { autoMergeRequest: { enabledAt: checkedAt.toISOString() } },
            },
          };
    }
    if (query.includes('QAgentEnqueuePullRequest')) {
      return 'enqueueResponse' in options
        ? options.enqueueResponse
        : {
            enqueuePullRequest: { mergeQueueEntry: { state: 'QUEUED' } },
          };
    }
    const snapshot = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
    snapshotIndex += 1;
    return { repository: { pullRequest: snapshot } };
  });
  const client = {
    rest: {
      pulls: {
        list: vi.fn(async () => ({ data: options.existingPulls ?? [] })),
        create: createPull,
        get: vi.fn(async () => ({ data: { merged: false, state: 'open' } })),
      },
    },
    request,
    graphql,
  } as unknown as GitHubApi;
  return {
    createPull,
    graphql,
    push,
    publisher: new GitHubPublisher('ghp_fixture_secret', { push } as unknown as GitRepository, {
      client,
      pollIntervalMs: 1,
      waitTimeoutMs: options.waitTimeoutMs ?? 2,
      requestTimeoutMs: options.requestTimeoutMs ?? 50,
    }),
  };
}

function healthyRepositoryData(overrides: Record<string, unknown> = {}) {
  return {
    full_name: 'owner/repo',
    default_branch: 'main',
    archived: false,
    disabled: false,
    allow_auto_merge: true,
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
    permissions: { pull: true, push: true, admin: true },
    ...overrides,
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

function pullListItem(
  options: {
    base?: string;
    fullName?: string | null;
    head?: string;
    number?: number;
    state?: string;
  } = {}
) {
  return {
    html_url: `https://github.com/owner/repo/pull/${options.number ?? 7}`,
    number: options.number ?? 7,
    state: options.state ?? 'closed',
    merged_at: null,
    head: {
      ref: options.head ?? 'qagent/run',
      ...(options.fullName === null
        ? {}
        : { repo: { full_name: options.fullName ?? 'owner/repo' } }),
    },
    base: { ref: options.base ?? 'main' },
  };
}

function publicationOptions(worktree: Worktree) {
  return {
    repository: { owner: 'owner', repo: 'repo' },
    worktree,
    baseBranch: 'main',
    title: 'Repair',
    body: 'Evidence',
    autoMerge: true,
    highRisk: false,
    mergeMethod: 'squash' as const,
  };
}

function doctorDependencies(
  overrides: Partial<DoctorDependencies> = {}
): Partial<DoctorDependencies> {
  return {
    nodeVersion: '24.13.0',
    environment: {},
    gitVersion: async () => ({ exitCode: 0, stdout: 'git version test', stderr: '' }),
    access: async () => undefined,
    detectBrowser: async () => ({
      name: 'Test Chromium',
      executablePath: '/browser',
      source: 'configured',
    }),
    detectProject: async (_path, options) => ({
      name: 'Fixture',
      path: '/repo',
      stack: 'node',
      configPath: options.configPath ?? '/repo/.qagent.yml',
      config: githubDoctorConfig(),
      suggestedTestCommands: [],
      suggestedVerifyCommands: [],
      suggestedStartCommand: null,
      needsConfiguration: false,
    }),
    probeBrowserbase: async () => undefined,
    probeGitHub: async () => githubProbe(),
    probeModel: async () => undefined,
    probeWeave: async () => 'entity/project',
    ...overrides,
  };
}

function browserbaseDoctorConfig(): QAgentConfig {
  return QAgentConfigSchema.parse({
    version: 1,
    test: { commands: [{ executable: 'test' }] },
    browser: { provider: 'browserbase' },
    model: { provider: 'openai-compatible', model: 'local' },
    publish: { provider: 'local' },
  });
}

function githubDoctorConfig(): QAgentConfig {
  return QAgentConfigSchema.parse({
    version: 1,
    test: { commands: [{ executable: 'test' }] },
    model: { provider: 'openai-compatible', model: 'local' },
    publish: { provider: 'github', baseBranch: 'main' },
  });
}

function weaveDoctorConfig(): QAgentConfig {
  return QAgentConfigSchema.parse({
    version: 1,
    test: { commands: [{ executable: 'test' }] },
    model: { provider: 'openai-compatible', model: 'local' },
    publish: { provider: 'local' },
    telemetry: { weave: { enabled: true, project: 'entity/project' } },
  });
}

function githubProbe(): GitHubRepositoryProbe {
  return {
    capturedAt: checkedAt.toISOString(),
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
    rules: { active: ['required_status_checks'], classicProtection: 'protected' },
    checks: { checkRuns: 2, combinedStatus: 'success', statusContexts: 1 },
    merge: {
      allowAutoMerge: true,
      allowedMethods: ['squash'],
      mergeQueueRequired: false,
    },
  };
}

function smokeDependencies(
  overrides: Partial<AdapterSmokeDependencies> = {}
): AdapterSmokeDependencies {
  return {
    now: () => checkedAt,
    fetch: vi.fn(async () => new Response(null, { status: 200 })),
    probeModel: vi.fn(async () => undefined),
    probeGitHub: vi.fn(async (_token, _repository, pullNumber) => ({
      repository: githubProbe(),
      pullRequest:
        pullNumber === null
          ? null
          : {
              capturedAt: checkedAt.toISOString(),
              repositoryFullName: 'owner/repo',
              number: pullNumber,
              url: `https://github.com/owner/repo/pull/${pullNumber}`,
              providerState: 'OPEN',
              finalState: 'open',
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
              mergeEligible: true,
              reviewDecision: 'APPROVED',
              checksState: 'SUCCESS',
              mergeQueueState: null,
              autoMergeEnabled: false,
              mergeCommitSha: null,
              detail: 'Open and eligible.',
            },
    })),
    probeBrowserbase: vi.fn(async () => undefined),
    probeRedis: vi.fn(async () => undefined),
    probeWeave: vi.fn(async () => 'owner/project'),
    ...overrides,
  };
}

function integrationByProvider(
  integrations: Awaited<ReturnType<typeof runCredentialBackedSmoke>>['integrations'],
  provider: string
) {
  const integration = integrations.find((item) => item.provider === provider);
  if (!integration) throw new Error(`Missing ${provider} integration`);
  return integration;
}

function command(source: string, env: Record<string, string> = {}) {
  return {
    executable: process.execPath,
    args: ['-e', source],
    cwd: '.',
    env,
    timeoutMs: 5_000,
  };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition was not met before timeout');
}
