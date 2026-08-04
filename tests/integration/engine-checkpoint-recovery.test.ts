import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  detectProject,
  GitHubPublisher,
  GitRepository,
  type GitExecutionOptions,
  type PublicationResult,
  type PullRequestWaitResult,
  writeProjectConfig,
} from '@qagent/adapters';
import { QAgentEngine, RuntimeShutdownError } from '@qagent/core';
import {
  ArtifactStore,
  QAgentStorage,
  type RunCheckpoint,
  type RunCheckpointKind,
  type RunCheckpointPayloads,
} from '@qagent/storage';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DeterministicRepairModel,
  git,
  temporaryDirectory,
  temporaryFixtureRepository,
} from '../helpers.js';

const openStorages = new Set<QAgentStorage>();

afterEach(() => {
  for (const storage of openStorages) storage.close();
  openStorages.clear();
});

describe.sequential('QAgentEngine durable checkpoint recovery', () => {
  it.each([
    'worktree_created',
    'patch_applied',
    'verification_passed',
    'commit_created',
  ] satisfies RunCheckpointKind[])(
    'recovers a local run after crashing at %s without repeating irreversible work',
    async (checkpoint) => {
      const proof = await crashAndRecover(checkpoint, 'local');

      expect(proof.result).toMatchObject({
        id: proof.runId,
        status: 'succeeded',
        recoveryCount: 1,
      });
      expect(proof.publisher.createCount).toBe(0);
      expect(proof.publisher.publishCalls).toBe(0);
      expect(proof.storage.getRunCheckpoint(proof.runId)?.kind).toBe('commit_created');
      assertCommonRecoveryProof(proof);
    },
    60_000
  );

  it.each([
    'branch_pushed',
    'pull_request_created',
    'merge_observed',
    'postverify_passed',
  ] satisfies RunCheckpointKind[])(
    'recovers a GitHub publication after crashing at %s without duplicating its branch or PR',
    async (checkpoint) => {
      const proof = await crashAndRecover(checkpoint, 'github');

      expect(proof.result).toMatchObject({
        id: proof.runId,
        status: 'succeeded',
        recoveryCount: 1,
      });
      expect(proof.publisher.createCount).toBe(1);
      expect(proof.publisher.pullNumbers).toEqual([17]);
      expect(proof.storage.getRunCheckpoint(proof.runId)?.kind).toBe('postverify_passed');
      expect(
        proof.storage
          .listEvents(proof.runId)
          .filter((event) => event.kind === 'publication.created')
      ).toHaveLength(
        checkpoint === 'branch_pushed' ? 1 : checkpoint === 'pull_request_created' ? 0 : 1
      );
      assertCommonRecoveryProof(proof);
    },
    60_000
  );
});

type PublicationMode = 'local' | 'github';

interface RecoveryProof {
  runId: string;
  result: NonNullable<ReturnType<QAgentStorage['getRun']>>;
  storage: QAgentStorage;
  repository: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
  bareRepository: string;
  model: DeterministicRepairModel;
  publisher: IdempotentPublisher;
}

async function crashAndRecover(
  checkpoint: RunCheckpointKind,
  publicationMode: PublicationMode
): Promise<RecoveryProof> {
  const repository = await temporaryFixtureRepository();
  const detected = await detectProject(repository);
  if (!detected.config) throw new Error('Fixture config was not detected');
  detected.config.test.browserFlows = [];
  detected.config.publish.provider = publicationMode;
  detected.config.publish.autoMerge = false;
  await writeProjectConfig(repository, detected.config, { force: true });
  await git(repository, ['add', '.qagent.yml']);
  await git(repository, [
    '-c',
    'user.name=QAgent tests',
    '-c',
    'user.email=tests@qagent.local',
    'commit',
    '-m',
    `configure ${publicationMode} checkpoint recovery`,
  ]);
  const bareRepository = await temporaryDirectory(`qagent-checkpoint-remote-${checkpoint}-`);
  await git(bareRepository, ['init', '--bare', '--initial-branch=main']);
  await git(repository, ['remote', 'add', 'origin', bareRepository]);
  await git(repository, ['push', '--set-upstream', 'origin', 'main']);

  const home = await temporaryDirectory(`qagent-checkpoint-${checkpoint}-`);
  const databasePath = join(home, 'qagent.sqlite');
  const gitRepository = new RecoveryGitRepository();
  const model = new DeterministicRepairModel();
  const publisher = new IdempotentPublisher(gitRepository, bareRepository);
  const crashingStorage = trackStorage(new CrashAfterCheckpointStorage(databasePath, checkpoint));
  const crashingEngine = createEngine({
    home,
    storage: crashingStorage,
    gitRepository,
    model,
    publisher,
    publicationMode,
  });
  const project = await crashingEngine.addProject(repository, true);
  const crashed = await (
    await crashingEngine.startRun({ projectId: project.id, requestedBy: 'cli' })
  ).result();

  expect(crashingStorage.didCrash).toBe(true);
  expect(crashingStorage.getRunCheckpoint(crashed.id)?.kind).toBe(checkpoint);
  expect(crashed.status).toBe('running');
  expect(terminalEvents(crashingStorage, crashed.id)).toHaveLength(0);
  expect(crashed.worktreePath).toBeTruthy();
  expect(crashed.branch).toBeTruthy();
  expect(crashed.baseSha).toBeTruthy();

  closeStorage(crashingStorage);
  const storage = trackStorage(new QAgentStorage(databasePath));
  const resumedEngine = createEngine({
    home,
    storage,
    gitRepository,
    model,
    publisher,
    publicationMode,
  });
  const handles = await resumedEngine.resumeInterruptedRuns();
  expect(handles).toHaveLength(1);
  expect(handles[0]?.id).toBe(crashed.id);
  const result = await handles[0]!.result();

  return {
    runId: crashed.id,
    result,
    storage,
    repository,
    worktreePath: crashed.worktreePath!,
    branch: crashed.branch!,
    baseSha: crashed.baseSha!,
    bareRepository,
    model,
    publisher,
  };
}

function createEngine(options: {
  home: string;
  storage: QAgentStorage;
  gitRepository: GitRepository;
  model: DeterministicRepairModel;
  publisher: IdempotentPublisher;
  publicationMode: PublicationMode;
}): QAgentEngine {
  return new QAgentEngine({
    storage: options.storage,
    artifactStore: new ArtifactStore(join(options.home, 'artifacts'), options.storage),
    qagentHome: options.home,
    gitRepository: options.gitRepository,
    modelProviderFactory: () => options.model,
    browserDetector: async () => null,
    ...(options.publicationMode === 'github'
      ? {
          githubToken: 'checkpoint-test-token',
          githubPublisherFactory: () => options.publisher,
        }
      : {}),
  });
}

function assertCommonRecoveryProof(proof: RecoveryProof): void {
  const events = proof.storage.listEvents(proof.runId);
  expect(events.filter((event) => event.kind === 'recovery.started')).toHaveLength(1);
  expect(events.filter((event) => event.kind === 'recovery.completed')).toHaveLength(1);
  expect(events.filter((event) => event.kind === 'run.interrupted')).toHaveLength(1);
  expect(events.filter((event) => event.kind === 'run.resumed')).toHaveLength(1);
  expect(terminalEvents(proof.storage, proof.runId)).toHaveLength(1);
  expect(proof.storage.listDiagnoses(proof.runId)).toHaveLength(1);
  expect(proof.storage.listPatches(proof.runId)).toHaveLength(1);
  expect(proof.storage.listVerifications(proof.runId)).toHaveLength(1);
  expect(proof.storage.listProviderCalls(proof.runId)).toHaveLength(2);
  expect(proof.model.calls).toHaveLength(2);

  const commandEvents = events.filter(
    (event) =>
      event.kind === 'command.started' ||
      event.kind === 'command.completed' ||
      event.kind === 'command.failed'
  );
  expect(commandEvents.some((event) => event.kind === 'command.started')).toBe(true);
  expect(commandEvents.filter((event) => event.kind === 'command.started')).toHaveLength(
    commandEvents.filter(
      (event) => event.kind === 'command.completed' || event.kind === 'command.failed'
    ).length
  );

  const repairCommitCount = Number.parseInt(
    execGit(proof.worktreePath, ['rev-list', '--count', `${proof.baseSha}..HEAD`]),
    10
  );
  expect(repairCommitCount).toBe(1);
  const registeredWorktrees = execGit(proof.repository, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line === `worktree ${proof.worktreePath}`);
  expect(registeredWorktrees).toHaveLength(1);
  expect(
    execGit(proof.worktreePath, ['branch', '--format=%(refname:short)', '--list', proof.branch])
  ).toBe(proof.branch);
  if (proof.publisher.createCount > 0) {
    expect(
      execGit(proof.bareRepository, [
        'for-each-ref',
        '--format=%(refname:short)',
        `refs/heads/${proof.branch}`,
      ])
    ).toBe(proof.branch);
    expect(execGit(proof.bareRepository, ['rev-parse', proof.branch])).toBe(
      execGit(proof.worktreePath, ['rev-parse', 'HEAD'])
    );
  }
}

function terminalEvents(storage: QAgentStorage, runId: string) {
  return storage
    .listEvents(runId)
    .filter((event) =>
      ['run.completed', 'run.failed', 'run.cancelled', 'run.policy_blocked'].includes(event.kind)
    );
}

function execGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function trackStorage<T extends QAgentStorage>(storage: T): T {
  openStorages.add(storage);
  return storage;
}

function closeStorage(storage: QAgentStorage): void {
  if (!openStorages.delete(storage)) return;
  storage.close();
}

class CrashAfterCheckpointStorage extends QAgentStorage {
  didCrash = false;

  constructor(
    databasePath: string,
    private readonly crashAt: RunCheckpointKind
  ) {
    super(databasePath);
  }

  override saveRunCheckpoint<K extends RunCheckpointKind>(
    runId: string,
    kind: K,
    data: RunCheckpointPayloads[K]
  ): RunCheckpoint<K> {
    const checkpoint = super.saveRunCheckpoint(runId, kind, data);
    if (!this.didCrash && kind === this.crashAt) {
      this.didCrash = true;
      throw new RuntimeShutdownError(`Injected runtime crash after ${kind}`);
    }
    return checkpoint;
  }
}

class RecoveryGitRepository extends GitRepository {
  override async inspect(
    projectPath: string,
    options: GitExecutionOptions = {}
  ): Promise<Awaited<ReturnType<GitRepository['inspect']>>> {
    return {
      ...(await super.inspect(projectPath, options)),
      origin: 'https://github.com/qagent/checkpoint-recovery.git',
    };
  }
}

class IdempotentPublisher extends GitHubPublisher {
  publishCalls = 0;
  pushCalls = 0;
  createCount = 0;
  waitCalls = 0;
  readonly pullNumbers: number[] = [];
  private readonly publications = new Map<string, PublicationResult>();

  constructor(
    gitRepository: GitRepository,
    private readonly bareRepository: string
  ) {
    super('checkpoint-test-token', gitRepository);
  }

  override async publish(
    options: Parameters<GitHubPublisher['publish']>[0]
  ): Promise<PublicationResult> {
    options.signal?.throwIfAborted();
    this.publishCalls += 1;
    this.pushCalls += 1;
    execGit(options.worktree.path, [
      'push',
      this.bareRepository,
      `HEAD:refs/heads/${options.worktree.branch}`,
    ]);
    let publication = this.publications.get(options.worktree.branch);
    if (!publication) {
      this.createCount += 1;
      const headSha = execGit(options.worktree.path, ['rev-parse', 'HEAD']);
      publication = {
        url: 'https://github.com/qagent/checkpoint-recovery/pull/17',
        number: 17,
        state: 'merged',
        autoMergeEnabled: false,
        mergeCommitSha: headSha,
        created: true,
        detail: 'The test publisher observed the existing merged repair.',
      };
      this.publications.set(options.worktree.branch, publication);
      this.pullNumbers.push(publication.number);
    }
    await options.onCreated?.({ ...publication, created: this.createCount === 1 });
    return publication;
  }

  override async waitForPull(
    _repository: Parameters<GitHubPublisher['waitForPull']>[0],
    pullNumber: number,
    signal?: AbortSignal
  ): Promise<PullRequestWaitResult> {
    signal?.throwIfAborted();
    this.waitCalls += 1;
    const publication = [...this.publications.values()].find(
      (candidate) => candidate.number === pullNumber
    );
    if (!publication?.mergeCommitSha) throw new Error(`Pull request #${pullNumber} was not seeded`);
    return {
      state: 'merged',
      mergeCommitSha: publication.mergeCommitSha,
      detail: 'The existing pull request is merged.',
    };
  }
}
