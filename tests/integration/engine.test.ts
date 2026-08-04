import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  detectProject,
  GitHubPublisher,
  GitRepository,
  writeProjectConfig,
  type GitExecutionOptions,
  type PublicationResult,
  type PullRequestWaitResult,
  type Worktree,
  type WorktreeState,
} from '@qagent/adapters';
import { ArtifactStore, QAgentStorage } from '@qagent/storage';
import { QAgentEngine } from '@qagent/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChromiumTestBrowser,
  DeterministicRepairModel,
  git,
  playwrightBrowserInstallation,
  readCounter,
  temporaryDirectory,
  temporaryFixtureRepository,
} from '../helpers.js';

const openStorage: QAgentStorage[] = [];

afterEach(() => {
  for (const storage of openStorage.splice(0)) storage.close();
});

describe('QAgentEngine fixture workflow', () => {
  it('repairs, verifies, records browser evidence, and preserves the active checkout', async () => {
    const repository = await temporaryFixtureRepository();
    await assignFreeTargetPort(repository);
    const home = await temporaryDirectory('qagent-home-');
    const storage = new QAgentStorage(join(home, 'qagent.sqlite'));
    openStorage.push(storage);
    const artifacts = new ArtifactStore(join(home, 'artifacts'), storage);
    const model = new DeterministicRepairModel();
    const engine = new QAgentEngine({
      storage,
      artifactStore: artifacts,
      qagentHome: home,
      browser: new ChromiumTestBrowser(),
      browserDetector: async () => playwrightBrowserInstallation(),
      modelProviderFactory: () => model,
    });

    const project = await engine.addProject(repository, true);
    const handle = await engine.startRun({ projectId: project.id, requestedBy: 'cli' });
    const streamed = [];
    for await (const event of handle.events()) streamed.push(event);
    const result = await handle.result();

    expect(result.status).toBe('succeeded');
    expect(result.stage).toBe('complete');
    expect(result.branch).toMatch(/^qagent\//);
    expect(result.worktreePath).not.toBe(repository);
    expect(await readCounter(repository)).toContain('value + 2');
    expect(await readCounter(result.worktreePath!)).toContain('value + 1');
    expect(await git(repository, ['status', '--porcelain'])).toBe('');
    expect(model.calls.map((call) => call.purpose)).toEqual(['triage', 'patch']);

    const events = engine.getRunEvents(result.id);
    const streamedIds = new Set(streamed.map((event) => event.id));
    expect(
      events.filter((event) => event.kind !== 'artifact.created' || streamedIds.has(event.id))
    ).toEqual(streamed);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.filter((event) => event.kind === 'evidence.captured')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'run.completed')).toHaveLength(1);

    const storedArtifacts = storage.listArtifacts(result.id);
    expect(storedArtifacts.some((artifact) => artifact.kind === 'patch')).toBe(true);
    expect(storedArtifacts.filter((artifact) => artifact.kind === 'screenshot')).toHaveLength(2);
    expect(storedArtifacts.filter((artifact) => artifact.kind === 'dom')).toHaveLength(2);
    for (const artifact of storedArtifacts) await access(artifact.path);

    const verification = storage.getVerification(result.id);
    expect(verification?.passed).toBe(true);
    expect(verification?.artifactIds.length).toBeGreaterThanOrEqual(4);
    expect(storage.getDiagnosis(result.id)?.confidence).toBe(1);
    expect(storage.getPatch(result.id)?.applied).toBe(true);
    expect(storage.listKnowledgeEntries()).toHaveLength(1);
    expect(storage.listTestCases(project.id).map((test) => test.kind)).toEqual([
      'command',
      'browser',
    ]);

    storage.close();
    openStorage.splice(openStorage.indexOf(storage), 1);
    const reopened = new QAgentStorage(join(home, 'qagent.sqlite'));
    openStorage.push(reopened);
    expect(reopened.getRun(result.id)?.status).toBe('succeeded');
    expect(reopened.listEvents(result.id)).toEqual(events);
    const domArtifact = reopened
      .listArtifacts(result.id)
      .find((artifact) => artifact.kind === 'dom' && artifact.name.endsWith('.html'));
    expect(domArtifact).toBeDefined();
    expect(await readFile(domArtifact!.path, 'utf8')).toContain('id="count"');
  }, 60_000);

  it('blocks untrusted projects without executing their commands', async () => {
    const repository = await temporaryFixtureRepository();
    const { engine } = await testEngine();
    const project = await engine.addProject(repository, false);
    const handle = await engine.startRun({ projectId: project.id, requestedBy: 'mcp' });
    const result = await handle.result();

    expect(result).toMatchObject({
      status: 'waiting_for_intervention',
      failureCode: 'policy_blocked',
      availableActions: ['resolve_intervention', 'cancel'],
      intervention: {
        reason: 'policy_blocked',
        resolutionOptions: ['policy_acknowledged'],
        requiredAction: {
          type: 'application',
          action: 'trust_project',
        },
      },
    });
    expect(result.error).toMatch(/Trust this workspace/);
    expect(engine.getRunEvents(result.id).some((event) => event.kind === 'command.started')).toBe(
      false
    );
    expectNoTerminalEvent(engine, result.id);
  });

  it('preserves a verified branch but blocks publication from a dirty checkout', async () => {
    const repository = await temporaryFixtureRepository();
    await assignFreeTargetPort(repository);
    await readFile(join(repository, 'README.md'), 'utf8').then(async (content) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(repository, 'README.md'), `${content}\nDirty local note.\n`);
    });
    const { engine } = await testEngine();
    const project = await engine.addProject(repository, true);
    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'desktop' })
    ).result();

    expect(result).toMatchObject({
      status: 'waiting_for_intervention',
      failureCode: 'dirty_checkout',
      availableActions: ['resolve_intervention', 'cancel'],
      intervention: {
        reason: 'dirty_checkout',
        resolutionOptions: ['checkout_cleaned'],
        requiredAction: {
          type: 'application',
          action: 'clean_checkout',
        },
      },
    });
    expect(result.error).toMatch(/source checkout is dirty/i);
    expect(result.worktreePath).toBeTruthy();
    expect(await readCounter(result.worktreePath!)).toContain('value + 1');
    expect(await readCounter(repository)).toContain('value + 2');
    expectNoTerminalEvent(engine, result.id);
  }, 60_000);

  it('rebases and reverifies one GitHub conflict, then postverifies the reported merge commit', async () => {
    const repository = await temporaryFixtureRepository();
    await assignFreeTargetPort(repository);
    const detected = await detectProject(repository);
    if (!detected.config) throw new Error('Fixture configuration was not found');
    detected.config.publish = {
      provider: 'github',
      baseBranch: 'main',
      autoMerge: true,
      mergeMethod: 'squash',
    };
    await writeProjectConfig(repository, detected.config, { force: true });
    await git(repository, ['add', '.qagent.yml']);
    await git(repository, [
      '-c',
      'user.name=QAgent tests',
      '-c',
      'user.email=tests@qagent.local',
      'commit',
      '-m',
      'enable GitHub publication',
    ]);
    await git(repository, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);

    const home = await temporaryDirectory('qagent-publication-');
    const storage = new QAgentStorage(join(home, 'qagent.sqlite'));
    openStorage.push(storage);
    const gitRepository = new ConflictRetryGitRepository();
    const publisher = new ConflictPublisher();
    const engine = new QAgentEngine({
      storage,
      artifactStore: new ArtifactStore(join(home, 'artifacts'), storage),
      qagentHome: home,
      browser: new ChromiumTestBrowser(),
      browserDetector: async () => playwrightBrowserInstallation(),
      modelProviderFactory: () => new DeterministicRepairModel(),
      githubToken: 'test-token',
      gitRepository,
      githubPublisherFactory: () => publisher as unknown as GitHubPublisher,
    });

    const project = await engine.addProject(repository, true);
    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'desktop' })
    ).result();

    expect(result.status, result.error ?? undefined).toBe('succeeded');
    expect(gitRepository.rebaseCalls).toBe(2);
    expect(gitRepository.pushCalls).toBe(0);
    expect(publisher.pushCalls).toBe(1);
    expect(gitRepository.preConflictHeadSha).toMatch(/^[a-f0-9]{40}$/);
    expect(publisher.pushOptions).toMatchObject({
      forceWithLease: true,
      expectedRemoteSha: gitRepository.preConflictHeadSha,
    });
    expect(gitRepository.checkedOutCommit).toBe(ConflictPublisher.mergeCommitSha);
    expect(publisher.waitCalls).toBe(1);
    expect(storage.listVerifications(result.id)).toHaveLength(2);
    expect(storage.getIntegration('github')).toMatchObject({
      status: 'end-to-end-verified',
      evidence: [
        {
          sourceUrl: 'https://github.com/owner/repo/pull/7',
          kind: 'end-to-end-workflow',
          authorization: 'verified',
          capturedAt: expect.any(String),
          summary: expect.stringContaining('Pull request #7 exists'),
        },
      ],
    });
    expect(
      engine
        .getRunEvents(result.id)
        .some((event) => event.kind === 'publication.updated' && event.payload.state === 'conflict')
    ).toBe(true);
  }, 60_000);

  it('settles as policy blocked when repository requirements leave the pull request open', async () => {
    const repository = await temporaryFixtureRepository();
    const detected = await detectProject(repository);
    if (!detected.config) throw new Error('Fixture configuration was not found');
    detected.config.test.browserFlows = [];
    detected.config.verify.commands = detected.config.test.commands;
    detected.config.publish = {
      provider: 'github',
      baseBranch: 'main',
      autoMerge: true,
      mergeMethod: 'squash',
    };
    await writeProjectConfig(repository, detected.config, { force: true });
    await git(repository, ['add', '.qagent.yml']);
    await git(repository, [
      '-c',
      'user.name=QAgent tests',
      '-c',
      'user.email=tests@qagent.local',
      'commit',
      '-m',
      'enable protected GitHub publication',
    ]);
    await git(repository, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);

    const home = await temporaryDirectory('qagent-open-publication-');
    const storage = new QAgentStorage(join(home, 'qagent.sqlite'));
    openStorage.push(storage);
    const engine = new QAgentEngine({
      storage,
      artifactStore: new ArtifactStore(join(home, 'artifacts'), storage),
      qagentHome: home,
      modelProviderFactory: () => new DeterministicRepairModel(),
      githubToken: 'test-token',
      gitRepository: new NoRebaseGitRepository(),
      githubPublisherFactory: () => new OpenPublisher() as unknown as GitHubPublisher,
    });

    const project = await engine.addProject(repository, true);
    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'desktop' })
    ).result();

    expect(result).toMatchObject({
      status: 'waiting_for_intervention',
      error: 'Pull request remains open and requires repository action',
      failureCode: 'merge_waiting',
      availableActions: ['reconnect', 'resolve_intervention', 'cancel'],
      intervention: {
        reason: 'merge_waiting',
        resolutionOptions: ['github_requirements_recheck_requested'],
        requiredAction: {
          type: 'external',
          url: 'https://github.com/owner/repo/pull/8',
        },
      },
    });
    expect(storage.listVerifications(result.id)).toHaveLength(1);
    expect(
      engine
        .getRunEvents(result.id)
        .some(
          (event) =>
            event.kind === 'publication.updated' &&
            event.payload.state === 'open' &&
            event.stage === 'wait_checks'
        )
    ).toBe(true);
    expectNoTerminalEvent(engine, result.id);
  }, 60_000);
});

function expectNoTerminalEvent(engine: QAgentEngine, runId: string): void {
  expect(
    engine
      .getRunEvents(runId)
      .filter((event) =>
        ['run.completed', 'run.failed', 'run.cancelled', 'run.policy_blocked'].includes(event.kind)
      )
  ).toHaveLength(0);
}

class ConflictRetryGitRepository extends GitRepository {
  rebaseCalls = 0;
  pushCalls = 0;
  checkedOutCommit: string | null = null;
  preConflictHeadSha: string | null = null;

  override async inspectWorktreeState(
    worktree: Worktree,
    options: GitExecutionOptions = {}
  ): Promise<WorktreeState> {
    const state = await super.inspectWorktreeState(worktree, options);
    this.preConflictHeadSha = state.headSha;
    return state;
  }

  override async rebaseOnce(_worktree: Worktree, _baseBranch: string): Promise<boolean> {
    this.rebaseCalls += 1;
    return this.rebaseCalls > 1;
  }

  override async push(_worktree: Worktree): Promise<void> {
    this.pushCalls += 1;
  }

  override async checkoutMergedCommit(
    _worktree: Worktree,
    _baseBranch: string,
    mergeCommitSha: string
  ): Promise<void> {
    this.checkedOutCommit = mergeCommitSha;
  }
}

class ConflictPublisher {
  static readonly mergeCommitSha = 'b'.repeat(40);
  waitCalls = 0;
  pushCalls = 0;
  pushOptions: {
    forceWithLease?: boolean;
    expectedRemoteSha?: string | null;
    signal?: AbortSignal;
  } | null = null;

  async publish(): Promise<PublicationResult> {
    return {
      url: 'https://github.com/owner/repo/pull/7',
      number: 7,
      state: 'conflict',
      autoMergeEnabled: true,
      mergeCommitSha: null,
      detail: 'GitHub reports a merge conflict.',
    };
  }

  async waitForPull(): Promise<PullRequestWaitResult> {
    this.waitCalls += 1;
    return { state: 'merged', mergeCommitSha: ConflictPublisher.mergeCommitSha };
  }

  async push(
    _worktree: Worktree,
    options: {
      forceWithLease?: boolean;
      expectedRemoteSha?: string | null;
      signal?: AbortSignal;
    } = {}
  ): Promise<void> {
    this.pushCalls += 1;
    this.pushOptions = options;
  }
}

class NoRebaseGitRepository extends GitRepository {
  override async rebaseOnce(_worktree: Worktree, _baseBranch: string): Promise<boolean> {
    return false;
  }
}

class OpenPublisher {
  async publish(): Promise<PublicationResult> {
    return {
      url: 'https://github.com/owner/repo/pull/8',
      number: 8,
      state: 'open',
      autoMergeEnabled: false,
      mergeCommitSha: null,
      detail: null,
    };
  }
}

async function testEngine() {
  const home = await temporaryDirectory('qagent-home-');
  const storage = new QAgentStorage(join(home, 'qagent.sqlite'));
  openStorage.push(storage);
  const model = new DeterministicRepairModel();
  return {
    storage,
    engine: new QAgentEngine({
      storage,
      artifactStore: new ArtifactStore(join(home, 'artifacts'), storage),
      qagentHome: home,
      browser: new ChromiumTestBrowser(),
      browserDetector: async () => playwrightBrowserInstallation(),
      modelProviderFactory: () => model,
    }),
  };
}

async function assignFreeTargetPort(repository: string): Promise<void> {
  const detected = await detectProject(repository);
  if (!detected.config?.target.start) throw new Error('Fixture target start command was not found');
  const port = await allocateFreePort();
  detected.config.target.url = `http://127.0.0.1:${port}`;
  detected.config.target.start.env.PORT = String(port);
  await writeProjectConfig(repository, detected.config, { force: true });
  await git(repository, ['add', '.qagent.yml']);
  await git(repository, [
    '-c',
    'user.name=QAgent tests',
    '-c',
    'user.email=tests@qagent.local',
    'commit',
    '-m',
    'allocate fixture target port',
  ]);
}

async function allocateFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}
