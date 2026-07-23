import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  detectProject,
  GitHubPublisher,
  GitRepository,
  writeProjectConfig,
  type PublicationResult,
  type PullRequestWaitResult,
  type Worktree,
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
    expect(streamed).toEqual(events);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.filter((event) => event.kind === 'evidence.captured')).toHaveLength(2);
    expect(events.at(-1)?.kind).toBe('run.completed');

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
    const { engine, storage } = await testEngine();
    const project = await engine.addProject(repository, false);
    const handle = await engine.startRun({ projectId: project.id, requestedBy: 'mcp' });
    const result = await handle.result();

    expect(result.status).toBe('policy_blocked');
    expect(result.error).toMatch(/Trust this workspace/);
    expect(storage.listArtifacts(result.id)).toEqual([]);
    expect(engine.getRunEvents(result.id).at(-1)?.kind).toBe('run.policy_blocked');
  });

  it('preserves a verified branch but blocks publication from a dirty checkout', async () => {
    const repository = await temporaryFixtureRepository();
    await readFile(join(repository, 'README.md'), 'utf8').then(async (content) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(repository, 'README.md'), `${content}\nDirty local note.\n`);
    });
    const { engine } = await testEngine();
    const project = await engine.addProject(repository, true);
    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'desktop' })
    ).result();

    expect(result.status).toBe('policy_blocked');
    expect(result.error).toMatch(/source checkout is dirty/i);
    expect(result.worktreePath).toBeTruthy();
    expect(await readCounter(result.worktreePath!)).toContain('value + 1');
    expect(await readCounter(repository)).toContain('value + 2');
  }, 60_000);

  it('rebases and reverifies one GitHub conflict, then postverifies the reported merge commit', async () => {
    const repository = await temporaryFixtureRepository();
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

    expect(result.status).toBe('succeeded');
    expect(gitRepository.rebaseCalls).toBe(2);
    expect(gitRepository.pushCalls).toBe(1);
    expect(gitRepository.checkedOutCommit).toBe(ConflictPublisher.mergeCommitSha);
    expect(publisher.waitCalls).toBe(1);
    expect(storage.listVerifications(result.id)).toHaveLength(2);
    expect(
      engine
        .getRunEvents(result.id)
        .some((event) => event.kind === 'publication.updated' && event.payload.state === 'conflict')
    ).toBe(true);
  }, 60_000);

  it('stops as policy-blocked when repository requirements leave the pull request open', async () => {
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
      status: 'policy_blocked',
      error: 'Pull request remains open and requires repository action',
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
  }, 60_000);
});

class ConflictRetryGitRepository extends GitRepository {
  rebaseCalls = 0;
  pushCalls = 0;
  checkedOutCommit: string | null = null;

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
