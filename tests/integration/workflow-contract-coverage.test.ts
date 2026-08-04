import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  BrowserInstallation,
  GitHubRepositoryProbe,
  ModelCompletion,
  ModelProvider,
  ModelRequest,
} from '@qagent/adapters';
import { GitHubPublisher, WeaveTraceSink } from '@qagent/adapters';
import type {
  InterventionResolution,
  Run,
  RunAttentionReason,
  RunEvent,
  RunIntervention,
} from '@qagent/contracts';
import { QAgentEngine, type RunHandle } from '@qagent/core';
import { ArtifactStore, QAgentStorage } from '@qagent/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { git, temporaryDirectory, temporaryFixtureRepository } from '../helpers.js';

const openStorages = new Set<QAgentStorage>();
const environmentNames = [
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID',
  'GITHUB_TOKEN',
  'QAGENT_BROWSER_PATH',
  'WANDB_API_KEY',
  'WEAVE_PROJECT',
] as const;
const originalEnvironment = new Map(
  environmentNames.map((name) => [name, process.env[name]] as const)
);

afterEach(() => {
  for (const storage of openStorages) storage.close();
  openStorages.clear();
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('workflow contract branch coverage', () => {
  it('projects pending, ready, observed, and unavailable launch isolation', async () => {
    const repository = await temporaryFixtureRepository();
    const { engine, storage } = await createEngine();
    const project = await engine.addProject(repository, true);

    await expect(engine.waitForRunLaunch(randomUUID(), 100)).rejects.toThrow(/was not found/);

    const queued = storage.createRun({ projectId: project.id, requestedBy: 'desktop' });
    const pending = await engine.waitForRunLaunch(queued.id, 0);
    expect(pending).toMatchObject({
      run: { id: queued.id },
      isolation: {
        state: 'pending',
        canonicalProjectPath: project.path,
        worktreePath: null,
      },
      policyBoundary: {
        mutationMode: 'dedicated-worktree',
        publicationAllowed: false,
        baseBranch: 'main',
      },
      commands: {
        test: expect.arrayContaining([expect.objectContaining({ executable: 'node' })]),
        start: expect.objectContaining({ executable: 'node' }),
      },
    });

    storage.updateRun(queued.id, {
      branch: 'qagent/ready',
      worktreePath: join(repository, '.qagent-worktree'),
      baseSha: 'a'.repeat(40),
    });
    expect(await engine.waitForRunLaunch(queued.id, 0)).toMatchObject({
      isolation: {
        state: 'ready',
        branch: 'qagent/ready',
        baseSha: 'a'.repeat(40),
      },
    });

    const observed = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    storage.appendEvent(observed.id, {
      kind: 'run.isolation_ready',
      stage: 'preflight',
      payload: {
        isolation: {
          state: 'ready',
          canonicalProjectPath: repository,
          worktreePath: join(repository, '.observed-worktree'),
          branch: 'qagent/observed',
          baseSha: 'b'.repeat(40),
        },
        policyBoundary: policyBoundary('github', 'develop'),
      },
      provenance: localProvenance(),
      artifactIds: [],
    });
    expect(await engine.waitForRunLaunch(observed.id)).toMatchObject({
      isolation: { state: 'ready', branch: 'qagent/observed' },
      policyBoundary: { publishProvider: 'github', baseBranch: 'develop' },
    });

    const terminal = storage.createRun({ projectId: project.id, requestedBy: 'mcp' });
    storage.updateRun(terminal.id, {
      status: 'failed',
      stage: 'complete',
      failureCode: 'unexpected_failure',
      error: 'seeded terminal run',
      availableActions: ['retry'],
      completedAt: new Date().toISOString(),
    });
    expect(await engine.waitForRunLaunch(terminal.id)).toMatchObject({
      isolation: { state: 'unavailable' },
    });

    const plainPath = await temporaryDirectory('qagent-no-config-');
    const plainProject = storage.createProject({
      name: 'No config',
      path: plainPath,
      trusted: true,
    });
    const plainRun = storage.createRun({ projectId: plainProject.id, requestedBy: 'desktop' });
    storage.updateRun(plainRun.id, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      availableActions: [],
    });
    expect(await engine.waitForRunLaunch(plainRun.id)).toMatchObject({
      isolation: { state: 'unavailable' },
      policyBoundary: {
        publishProvider: 'local',
        baseBranch: 'unknown',
        autoMergeRequested: false,
      },
      commands: { test: [], verify: [], start: null },
    });
  });

  it('distinguishes model, local browser, Browserbase, GitHub, and Weave verification states', async () => {
    const repository = await temporaryFixtureRepository();
    await git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);

    let browserInstallation: BrowserInstallation | null = null;
    let modelFailure: unknown = null;
    let githubProbe: GitHubRepositoryProbe | Error = healthyGitHubProbe();
    const model: ModelProvider = {
      provider: 'test-provider',
      model: 'structured-probe',
      async complete<T>(request: ModelRequest<T>): Promise<ModelCompletion<T>> {
        if (modelFailure) throw modelFailure;
        return {
          value: request.schema.parse({ ok: true }),
          inputTokens: null,
          outputTokens: null,
        };
      },
    };
    const { engine } = await createEngine({
      githubToken: 'github-test-token',
      browserDetector: async () => browserInstallation,
      modelProviderFactory: () => model,
      githubPublisherFactory: () =>
        ({
          probeRepository: async () => {
            if (githubProbe instanceof Error) throw githubProbe;
            return githubProbe;
          },
        }) as unknown as GitHubPublisher,
    });
    const project = await engine.addProject(repository, true);

    const modelUnconfigured = await engine.verifyIntegration({
      provider: 'model',
      requestedBy: 'desktop',
    });
    expect(modelUnconfigured).toMatchObject({
      integration: { status: 'unconfigured' },
      correctiveAction: { type: 'application', action: 'configure_provider' },
    });
    const modelVerified = await engine.verifyIntegration({
      provider: 'model',
      projectId: project.id,
      requestedBy: 'cli',
    });
    expect(modelVerified).toMatchObject({
      integration: { status: 'end-to-end-verified' },
      correctiveAction: null,
    });
    expect(
      (
        await engine.verifyIntegration({
          provider: 'model',
          projectId: project.id,
          requestedBy: 'mcp',
        })
      ).integration.id
    ).toBe(modelVerified.integration.id);
    modelFailure = new Error('Bearer secret-provider-token structured output failed');
    const modelError = await engine.verifyIntegration({
      provider: 'model',
      projectId: project.id,
      requestedBy: 'desktop',
    });
    expect(modelError).toMatchObject({
      integration: {
        status: 'error',
        detail: expect.stringContaining('Bearer [REDACTED]'),
      },
      correctiveAction: { type: 'application', action: 'configure_provider' },
    });

    delete process.env.BROWSERBASE_API_KEY;
    delete process.env.BROWSERBASE_PROJECT_ID;
    delete process.env.QAGENT_BROWSER_PATH;
    expect(
      await engine.verifyIntegration({
        provider: 'browser',
        projectId: project.id,
        requestedBy: 'desktop',
      })
    ).toMatchObject({
      integration: { status: 'unconfigured' },
      correctiveAction: { type: 'application', action: 'install_browser' },
    });
    browserInstallation = {
      name: 'Configured Chromium',
      executablePath: '/Applications/Chromium.app/Contents/MacOS/Chromium',
      source: 'configured',
    };
    expect(
      await engine.verifyIntegration({
        provider: 'browser',
        projectId: project.id,
        requestedBy: 'desktop',
      })
    ).toMatchObject({
      integration: {
        status: 'configured',
        detail: expect.stringContaining('startup and a configured flow are not yet verified'),
      },
    });

    process.env.BROWSERBASE_API_KEY = 'browserbase-test-key';
    process.env.BROWSERBASE_PROJECT_ID = 'project-123';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 'project-123' }), { status: 200 }))
    );
    expect(
      await engine.verifyIntegration({ provider: 'browser', requestedBy: 'desktop' })
    ).toMatchObject({
      integration: { provider: 'browserbase', status: 'healthy' },
      correctiveAction: null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 'wrong-project' }), { status: 200 }))
    );
    expect(
      await engine.verifyIntegration({ provider: 'browser', requestedBy: 'desktop' })
    ).toMatchObject({
      integration: { provider: 'browserbase', status: 'error' },
    });

    await expect(
      engine.verifyIntegration({
        provider: 'github',
        projectId: randomUUID(),
        requestedBy: 'desktop',
      })
    ).rejects.toThrow(/was not found/);
    const githubUnconfigured = await engine.verifyIntegration({
      provider: 'github',
      requestedBy: 'desktop',
    });
    expect(githubUnconfigured.integration).toMatchObject({
      status: 'unconfigured',
      detail: expect.stringContaining('a GitHub origin'),
    });
    const githubHealthy = await engine.verifyIntegration({
      provider: 'github',
      projectId: project.id,
      requestedBy: 'desktop',
    });
    expect(githubHealthy).toMatchObject({
      integration: {
        status: 'healthy',
        provenance: { sourceUrl: 'https://github.com/acme/widgets' },
      },
      correctiveAction: null,
    });
    githubProbe = {
      ...healthyGitHubProbe(),
      permissions: {
        ...healthyGitHubProbe().permissions,
        canPush: false,
        pullRequests: 'read',
      },
      rules: { active: [], classicProtection: 'unprotected' },
      merge: {
        ...healthyGitHubProbe().merge,
        allowedMethods: ['merge'],
      },
    };
    expect(
      await engine.verifyIntegration({
        provider: 'github',
        projectId: project.id,
        requestedBy: 'desktop',
      })
    ).toMatchObject({
      integration: {
        status: 'configured',
        detail: expect.stringContaining('classic protection unprotected'),
      },
      correctiveAction: { type: 'application', action: 'configure_provider' },
    });
    githubProbe = new Error('ghp_notarealtoken repository probe failed');
    expect(
      await engine.verifyIntegration({
        provider: 'github',
        projectId: project.id,
        requestedBy: 'desktop',
      })
    ).toMatchObject({
      integration: {
        status: 'error',
        detail: expect.not.stringContaining('ghp_notarealtoken'),
      },
    });

    delete process.env.WANDB_API_KEY;
    expect(
      await engine.verifyIntegration({ provider: 'weave', requestedBy: 'desktop' })
    ).toMatchObject({
      disclosureRequired: true,
      integration: { status: 'unconfigured' },
      correctiveAction: {
        label: 'Review Weave disclosure',
        type: 'application',
      },
    });

    process.env.WANDB_API_KEY = 'wandb-test-key';
    process.env.WEAVE_PROJECT = 'team/project';
    vi.spyOn(WeaveTraceSink.prototype, 'probeProject').mockResolvedValue('team/project');
    expect(
      await engine.verifyIntegration({
        provider: 'weave',
        requestedBy: 'desktop',
        weaveDisclosureAccepted: false,
      })
    ).toMatchObject({
      disclosureRequired: true,
      integration: { status: 'configured' },
      correctiveAction: { label: 'Review Weave disclosure' },
    });
    vi.spyOn(WeaveTraceSink.prototype, 'send').mockImplementation(async function () {
      this.resolvedProject = 'team/project';
      this.state = 'synced';
      return 'synced';
    });
    expect(
      await engine.verifyIntegration({
        provider: 'weave',
        requestedBy: 'desktop',
        weaveDisclosureAccepted: true,
      })
    ).toMatchObject({
      disclosureRequired: false,
      integration: {
        status: 'end-to-end-verified',
        detail: expect.stringContaining('delivered and flushed'),
      },
      correctiveAction: null,
    });
    vi.mocked(WeaveTraceSink.prototype.probeProject).mockRejectedValueOnce(
      new Error('Weave provider unavailable')
    );
    expect(
      await engine.verifyIntegration({
        provider: 'weave',
        requestedBy: 'desktop',
        weaveDisclosureAccepted: false,
      })
    ).toMatchObject({
      integration: { status: 'error' },
      correctiveAction: { label: 'Review Weave disclosure' },
    });
  });

  it('projects all durable publication waiting and terminal states', async () => {
    const { engine, storage } = await createEngine();
    const projectPath = await temporaryDirectory('qagent-publication-project-');
    const project = storage.createProject({
      name: 'Publication',
      path: projectPath,
      trusted: true,
    });

    expect(
      engine.getRunDetail(storage.createRun({ projectId: project.id, requestedBy: 'desktop' }).id)
        .publication
    ).toBeNull();

    for (const [observed, expected] of [
      [undefined, 'waiting_for_checks'],
      ['checks pending', 'waiting_for_checks'],
      ['review required', 'waiting_for_review'],
      ['merge queue pending', 'merge_queue'],
      ['conflict', 'merge_conflict'],
      ['closed', 'closed'],
      ['blocked', 'closed'],
      ['merged', 'merged'],
    ] as const) {
      const run = storage.createRun({ projectId: project.id, requestedBy: 'desktop' });
      storage.updateRun(run.id, { branch: 'qagent/publication' });
      storage.appendEvent(run.id, {
        kind: 'run.isolation_ready',
        stage: 'preflight',
        payload: {
          isolation: {
            state: 'ready',
            canonicalProjectPath: project.path,
            worktreePath: join(project.path, '.worktree'),
            branch: 'qagent/publication',
            baseSha: 'c'.repeat(40),
          },
          policyBoundary: policyBoundary('github', 'release'),
        },
        provenance: localProvenance(),
        artifactIds: [],
      });
      storage.appendEvent(run.id, {
        kind: 'publication.created',
        stage: 'publish',
        payload: {
          url: 'https://github.com/acme/widgets/pull/42',
          number: 42,
          autoMerge: false,
        },
        provenance: {
          source: 'github',
          provider: 'acme/widgets',
          capturedAt: new Date().toISOString(),
        },
        artifactIds: [],
      });
      if (observed) {
        storage.appendEvent(run.id, {
          kind: 'publication.updated',
          stage: 'wait_checks',
          payload: { state: observed },
          provenance: localProvenance(),
          artifactIds: [],
        });
      }
      expect(engine.getRunDetail(run.id).publication).toMatchObject({
        repository: 'acme/widgets',
        number: 42,
        headBranch: 'qagent/publication',
        baseBranch: 'release',
        state: expected,
        requiredAction:
          expected === 'merged'
            ? null
            : expect.objectContaining({
                type: 'application',
                action: 'review_pull_request',
              }),
      });
    }

    const fallback = storage.createRun({ projectId: project.id, requestedBy: 'desktop' });
    storage.appendEvent(fallback.id, {
      kind: 'publication.created',
      stage: 'publish',
      payload: {
        url: 'https://github.com/acme/widgets/pull/7',
        number: 7,
        autoMerge: false,
      },
      provenance: localProvenance(),
      artifactIds: [],
    });
    expect(engine.getRunDetail(fallback.id).publication).toMatchObject({
      repository: 'unknown',
      headBranch: 'unknown',
      baseBranch: 'unknown',
    });
  });

  it('dispatches every accepted run action and rejects stale intervention input', async () => {
    const { engine, storage } = await createEngine();
    const projectPath = await temporaryDirectory('qagent-actions-project-');
    const project = storage.createProject({
      name: 'Actions',
      path: projectPath,
      trusted: true,
    });
    const activation = vi
      .spyOn(
        engine as unknown as {
          activateRun(run: Run, mode: 'start' | 'resume' | 'retry' | 'reconnect'): RunHandle;
        },
        'activateRun'
      )
      .mockImplementation((run) => fakeHandle(run));

    await expect(
      engine.executeRunAction({ action: 'retry', runId: randomUUID(), requestedBy: 'desktop' })
    ).rejects.toThrow(/was not found/);

    const unavailable = storage.createRun({ projectId: project.id, requestedBy: 'desktop' });
    const rejection = await engine.executeRunAction({
      action: 'retry',
      runId: unavailable.id,
      requestedBy: 'desktop',
    });
    expect(rejection).toMatchObject({
      handle: null,
      result: { accepted: false, action: 'retry', runId: unavailable.id },
    });

    const cancelled = storage.createRun({ projectId: project.id, requestedBy: 'desktop' });
    const cancel = await engine.executeRunAction({
      action: 'cancel',
      runId: cancelled.id,
      requestedBy: 'desktop',
      reason: 'User cancelled from the workflow dock',
    });
    expect(cancel.result).toMatchObject({
      accepted: true,
      action: 'cancel',
      requestedRunId: cancelled.id,
      runId: cancelled.id,
    });
    expect(storage.getRun(cancelled.id)).toMatchObject({ status: 'cancelled' });

    const failed = storage.createRun({ projectId: project.id, requestedBy: 'desktop' });
    storage.updateRun(failed.id, {
      status: 'failed',
      stage: 'complete',
      failureCode: 'unexpected_failure',
      error: 'retryable failure',
      availableActions: ['retry'],
      completedAt: new Date().toISOString(),
    });
    const retry = await engine.executeRunAction({
      action: 'retry',
      runId: failed.id,
      requestedBy: 'recovery',
    });
    expect(retry.result).toMatchObject({
      accepted: true,
      requestedRunId: failed.id,
      runId: expect.not.stringMatching(failed.id),
    });
    expect(storage.getRun(retry.result.runId)).toMatchObject({
      attempt: 2,
      retryOfRunId: failed.id,
      requestedBy: 'resume',
    });

    const interrupted = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    storage.updateRun(interrupted.id, {
      status: 'interrupted',
      failureCode: 'interrupted_recovery',
      availableActions: ['resume', 'cancel'],
    });
    expect(
      await engine.executeRunAction({
        action: 'resume',
        runId: interrupted.id,
        requestedBy: 'cli',
      })
    ).toMatchObject({ result: { accepted: true, runId: interrupted.id } });

    const reconnecting = interventionRun(storage, project.id, 'merge_waiting', [
      'github_requirements_recheck_requested',
    ]);
    expect(
      await engine.executeRunAction({
        action: 'reconnect',
        runId: reconnecting.id,
        requestedBy: 'mcp',
        afterSequence: 4,
      })
    ).toMatchObject({ result: { accepted: true, runId: reconnecting.id } });

    const stale = interventionRun(storage, project.id, 'provider_outage', [
      'provider_reconfigured',
    ]);
    const staleResult = await engine.executeRunAction({
      action: 'resolve_intervention',
      runId: stale.id,
      requestedBy: 'desktop',
      interventionId: randomUUID(),
      resolution: { kind: 'provider_reconfigured', evidenceArtifactIds: [] },
    });
    expect(staleResult.result).toMatchObject({
      accepted: false,
      reason: 'The requested intervention is no longer active',
    });
    const invalidResolution = await engine.executeRunAction({
      action: 'resolve_intervention',
      runId: stale.id,
      requestedBy: 'desktop',
      interventionId: stale.intervention!.id,
      resolution: { kind: 'browser_installed', evidenceArtifactIds: [] },
    });
    expect(invalidResolution.result).toMatchObject({
      accepted: false,
      reason: expect.stringContaining('is not valid'),
    });

    for (const [reason, resolution, mode] of [
      ['merge_waiting', 'github_requirements_recheck_requested', 'reconnect'],
      ['dirty_checkout', 'checkout_cleaned', 'resume'],
      ['interrupted_recovery', 'recovery_confirmed', 'resume'],
      ['worktree_recovery_failed', 'recovery_confirmed', 'resume'],
    ] as const) {
      const waiting = interventionRun(storage, project.id, reason, [resolution]);
      const resolved = await engine.executeRunAction({
        action: 'resolve_intervention',
        runId: waiting.id,
        requestedBy: 'desktop',
        interventionId: waiting.intervention!.id,
        resolution: { kind: resolution, note: `Resolved ${reason}`, evidenceArtifactIds: [] },
      });
      expect(resolved.result).toMatchObject({
        accepted: true,
        requestedRunId: waiting.id,
        runId: waiting.id,
      });
      expect(activation).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: waiting.id }),
        mode
      );
    }

    for (const [reason, resolution, expectedStatus] of [
      ['provider_outage', 'provider_reconfigured', 'failed'],
      ['policy_blocked', 'policy_acknowledged', 'policy_blocked'],
    ] as const) {
      const waiting = interventionRun(storage, project.id, reason, [resolution]);
      const resolved = await engine.executeRunAction({
        action: 'resolve_intervention',
        runId: waiting.id,
        requestedBy: 'desktop',
        interventionId: waiting.intervention!.id,
        resolution: { kind: resolution, evidenceArtifactIds: [] },
      });
      expect(resolved.result).toMatchObject({
        accepted: true,
        requestedRunId: waiting.id,
        runId: expect.not.stringMatching(waiting.id),
      });
      expect(storage.getRun(waiting.id)).toMatchObject({
        status: expectedStatus,
        availableActions: ['retry'],
      });
      expect(storage.getRun(resolved.result.runId)).toMatchObject({
        retryOfRunId: waiting.id,
        attempt: 2,
      });
    }

    expect(activation.mock.calls.map(([, mode]) => mode)).toEqual(
      expect.arrayContaining(['retry', 'resume', 'reconnect'])
    );
  });
});

async function createEngine(
  options: Partial<ConstructorParameters<typeof QAgentEngine>[0]> = {}
): Promise<{ engine: QAgentEngine; storage: QAgentStorage; home: string }> {
  const home = await temporaryDirectory('qagent-workflow-contract-');
  const storage = new QAgentStorage(join(home, 'qagent.sqlite'));
  openStorages.add(storage);
  return {
    home,
    storage,
    engine: new QAgentEngine({
      storage,
      artifactStore: new ArtifactStore(join(home, 'artifacts'), storage),
      qagentHome: home,
      ...options,
    }),
  };
}

function policyBoundary(publishProvider: 'github' | 'local', baseBranch: string) {
  return {
    mutationMode: 'dedicated-worktree' as const,
    activeCheckoutMutationAllowed: false as const,
    dirtyCheckoutPublicationAllowed: false as const,
    highRiskAutoMergeAllowed: false as const,
    originalCheckoutDirty: false,
    publishProvider,
    baseBranch,
    autoMergeRequested: false,
    publicationAllowed: true,
    autoMergeAllowed: false,
    blockedReasons: [],
  };
}

function localProvenance() {
  return { source: 'local' as const, capturedAt: new Date().toISOString() };
}

function healthyGitHubProbe(): GitHubRepositoryProbe {
  return {
    capturedAt: new Date().toISOString(),
    identity: { login: 'qagent-test' },
    repository: {
      fullName: 'acme/widgets',
      defaultBranch: 'main',
      archived: false,
      disabled: false,
    },
    permissions: {
      role: 'maintain',
      canPull: true,
      canPush: true,
      canAdminister: false,
      pullRequests: 'write',
    },
    rules: {
      active: ['required_status_checks'],
      classicProtection: 'protected',
    },
    checks: {
      checkRuns: 2,
      combinedStatus: 'success',
      statusContexts: 1,
    },
    merge: {
      allowAutoMerge: true,
      allowedMethods: ['squash'],
      mergeQueueRequired: false,
    },
  };
}

function fakeHandle(run: Run): RunHandle {
  return {
    id: run.id,
    async *events() {
      const events: RunEvent[] = [];
      for (const event of events) yield event;
    },
    async cancel() {},
    async result() {
      return run;
    },
  };
}

function interventionRun(
  storage: QAgentStorage,
  projectId: string,
  reason: RunAttentionReason,
  resolutionOptions: InterventionResolution[]
): Run {
  const run = storage.createRun({ projectId, requestedBy: 'desktop' });
  const intervention: RunIntervention = {
    id: randomUUID(),
    runId: run.id,
    reason,
    summary: `Action required for ${reason}`,
    requiredAction: {
      id: `resolve-${reason}`,
      type: 'application',
      label: 'Resolve condition',
      description: 'Correct the recorded condition, then continue.',
      action: reason === 'dirty_checkout' ? 'clean_checkout' : 'configure_provider',
    },
    resolutionOptions,
    evidenceArtifactIds: [],
    requestedAt: new Date().toISOString(),
    resolvedAt: null,
    resolution: null,
  };
  return storage.updateRun(run.id, {
    status: 'waiting_for_intervention',
    availableActions:
      reason === 'merge_waiting'
        ? ['resolve_intervention', 'reconnect', 'cancel']
        : ['resolve_intervention', 'cancel'],
    intervention,
    failureCode: reason,
    error: intervention.summary,
  });
}
