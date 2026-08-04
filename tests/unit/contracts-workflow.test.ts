import { randomUUID } from 'node:crypto';
import {
  BoundedOutputSchema,
  DoctorCheckSchema,
  IntegrationSchema,
  IntegrationVerifyResultSchema,
  ProjectInspectionSchema,
  ReplayEventsRequestSchema,
  RunActionRequestSchema,
  RunSchema,
  SpecialistActivitySchema,
  SpecialistDecisionSchema,
  SpecialistHandoffSchema,
  SpecialistObjectionSchema,
  TerminalEvidenceSchema,
} from '@qagent/contracts';
import { describe, expect, it } from 'vitest';

const timestamp = '2026-07-23T18:00:00.000Z';

function command(executable = 'pnpm', args = ['test']) {
  return {
    executable,
    args,
    cwd: '.',
    env: {},
    timeoutMs: 120_000,
  };
}

function run(status: 'running' | 'failed' | 'cancelled' = 'running') {
  return {
    id: randomUUID(),
    projectId: randomUUID(),
    status,
    stage: 'test' as const,
    requestedBy: 'desktop' as const,
    branch: 'qagent/run-example',
    worktreePath: '/tmp/qagent/run-example',
    baseSha: 'abc123',
    summary: null,
    error: status === 'failed' ? 'Provider unavailable' : null,
    cancelRequestedAt: null,
    attempt: 1,
    retryOfRunId: null,
    availableActions: status === 'running' ? (['cancel', 'reconnect'] as const) : [],
    intervention: null,
    failureCode: status === 'failed' ? ('provider_outage' as const) : null,
    lastHeartbeatAt: timestamp,
    recoveryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: status === 'running' ? null : timestamp,
  };
}

describe('workflow contracts', () => {
  it('requires every Doctor warning and failure to expose a real corrective action', () => {
    const base = {
      id: 'browser',
      code: 'browser.unconfigured',
      label: 'Local browser',
      status: 'warn' as const,
      detail: 'No browser was found',
      source: 'filesystem scan',
      checkedAt: timestamp,
      providerState: 'unconfigured' as const,
    };

    expect(() => DoctorCheckSchema.parse({ ...base, correctiveAction: null })).toThrow(
      /corrective action/i
    );
    expect(
      DoctorCheckSchema.parse({
        ...base,
        correctiveAction: {
          id: 'install-browser',
          type: 'application',
          label: 'Install browser',
          description: 'Install managed Chromium and repeat the probe.',
          action: 'install_browser',
        },
      })
    ).toMatchObject({ code: 'browser.unconfigured' });
  });

  it('records a canonical trust path and exact structured commands before trust', () => {
    const test = command();
    const verify = command('pnpm', ['typecheck']);
    const inspected = ProjectInspectionSchema.parse({
      name: 'QAgent',
      path: '/Users/developer/QAgent',
      stack: 'node',
      configPath: null,
      config: null,
      suggestedTestCommands: [test],
      suggestedVerifyCommands: [verify],
      suggestedStartCommand: command('pnpm', ['dev']),
      needsConfiguration: true,
      trustPreview: {
        requestedPath: '/Users/developer/QAgent-alias',
        canonicalPath: '/Users/developer/QAgent',
        configPath: null,
        exactCommands: {
          test: [test],
          verify: [verify],
          start: command('pnpm', ['dev']),
        },
        policyBoundary: {
          commandsExecuteWithUserPrivileges: true,
          mutationsUseDedicatedWorktree: true,
          activeCheckoutMutationAllowed: false,
          trustRequiredBeforeExecution: true,
        },
      },
    });

    expect(inspected.trustPreview.canonicalPath).toBe(inspected.path);
    expect(inspected.trustPreview.exactCommands.test[0]).toEqual(test);
  });

  it('makes run action eligibility explicit and rejects impossible controls', () => {
    expect(RunSchema.parse(run('running')).availableActions).toEqual(['cancel', 'reconnect']);
    expect(() => RunSchema.parse({ ...run('running'), availableActions: ['resume'] })).toThrow(
      /resume/i
    );
    expect(() => RunSchema.parse({ ...run('cancelled'), availableActions: ['cancel'] })).toThrow(
      /terminal/i
    );

    expect(
      RunActionRequestSchema.parse({
        action: 'reconnect',
        runId: randomUUID(),
        requestedBy: 'mcp',
        afterSequence: 17,
      })
    ).toMatchObject({ action: 'reconnect', afterSequence: 17 });
  });

  it('models actionable waiting without accepting GitHub requirements by assertion', () => {
    const waiting = run('running');
    const interventionId = randomUUID();
    expect(
      RunSchema.parse({
        ...waiting,
        status: 'waiting_for_intervention',
        failureCode: 'merge_waiting',
        availableActions: ['resolve_intervention', 'reconnect', 'cancel'],
        intervention: {
          id: interventionId,
          runId: waiting.id,
          reason: 'merge_waiting',
          summary: 'Required checks are still pending.',
          requiredAction: {
            id: 'review-pr',
            type: 'application',
            label: 'Review pull request',
            description: 'Inspect required checks and request a fresh provider observation.',
            action: 'review_pull_request',
          },
          resolutionOptions: ['github_requirements_recheck_requested'],
          evidenceArtifactIds: [],
          requestedAt: timestamp,
          resolvedAt: null,
          resolution: null,
        },
      }).availableActions
    ).toContain('reconnect');
  });

  it('keeps specialist activity concise, evidence-aware, and free of hidden reasoning fields', () => {
    const artifactId = randomUUID();
    const activity = {
      id: randomUUID(),
      runId: randomUUID(),
      role: 'gate',
      status: 'blocked',
      summary: 'Publication is blocked by a required review.',
      source: {
        kind: 'policy_worker',
        worker: 'github-policy',
        invocationId: randomUUID(),
      },
      occurredAt: timestamp,
      attempt: 1,
      evidenceIds: [artifactId],
      handoffTarget: null,
    } as const;

    expect(SpecialistActivitySchema.parse(activity).status).toBe('blocked');
    expect(() =>
      SpecialistActivitySchema.parse({ ...activity, chainOfThought: 'private reasoning' })
    ).toThrow();
    expect(
      SpecialistObjectionSchema.parse({
        id: randomUUID(),
        runId: activity.runId,
        activityId: activity.id,
        role: 'gate',
        summary: 'Required review is missing.',
        reason: 'The observed branch rule requires one approving review.',
        actionRequired: 'Obtain the review, then reconnect for a fresh observation.',
        source: activity.source,
        occurredAt: timestamp,
        attempt: 1,
        evidenceIds: [artifactId],
      }).actionRequired
    ).toContain('reconnect');
  });

  it('permits explicit unavailable terminal evidence for early cancellation', () => {
    const evidence = TerminalEvidenceSchema.parse({
      id: randomUUID(),
      runId: randomUUID(),
      outcome: 'cancelled',
      summary: 'Cancelled before the first command produced an artifact.',
      evidenceAvailability: 'unavailable',
      artifactIds: [],
      evidenceLinks: [],
      evidenceUnavailableReason: 'No command had started when cancellation was accepted.',
      verificationId: null,
      publication: null,
      createdAt: timestamp,
    });

    expect(evidence.evidenceAvailability).toBe('unavailable');
  });

  it('carries sanitized external evidence and separate Browserbase requirements', () => {
    const integration = IntegrationSchema.parse({
      id: randomUUID(),
      provider: 'browserbase',
      status: 'configured',
      detail: 'Configuration is present; no live browser session has been verified.',
      requirements: [
        { id: 'api-key', label: 'API key', state: 'configured', secret: true },
        { id: 'project-id', label: 'Project ID', state: 'configured', secret: false },
      ],
      evidence: [
        {
          sourceUrl: 'https://www.browserbase.com/sign-in',
          capturedAt: timestamp,
          kind: 'page-inspection',
          authorization: 'unverified',
          summary: 'The overview redirected to sign-in; authorization was not inferred.',
        },
      ],
      provenance: {
        source: 'provider',
        provider: 'browserbase',
        capturedAt: timestamp,
      },
      updatedAt: timestamp,
    });

    expect(integration.requirements).toHaveLength(2);
    expect(() =>
      IntegrationSchema.parse({
        ...integration,
        evidence: [
          {
            ...integration.evidence?.[0],
            sourceUrl: 'https://token@example.com/path?state=secret',
          },
        ],
      })
    ).toThrow(/sanitized HTTPS/i);
  });

  it('prevents Weave verification claims before disclosure is accepted', () => {
    const integration = {
      id: randomUUID(),
      provider: 'weave',
      status: 'end-to-end-verified' as const,
      detail: 'A redacted trace was flushed.',
      provenance: {
        source: 'weave' as const,
        provider: 'weave',
        capturedAt: timestamp,
      },
      updatedAt: timestamp,
    };

    expect(() =>
      IntegrationVerifyResultSchema.parse({
        provider: 'weave',
        integration,
        disclosureRequired: true,
        correctiveAction: null,
        verifiedAt: timestamp,
      })
    ).toThrow(/disclosure/i);
  });

  it('keeps reconnect cursors and bounded terminal output internally consistent', () => {
    const runId = randomUUID();
    expect(() =>
      ReplayEventsRequestSchema.parse({
        runId,
        cursor: 'opaque-cursor',
        afterSequence: 4,
      })
    ).toThrow(/either cursor or afterSequence/i);
    expect(() =>
      BoundedOutputSchema.parse({
        text: 'tail',
        originalBytes: 10,
        retainedBytes: 4,
        omittedBytes: 5,
        truncated: true,
        redactionCount: 0,
        backpressure: null,
      })
    ).toThrow(/equal originalBytes/i);
  });

  it('validates specialist decisions and evidence-linked handoffs', () => {
    const source = {
      kind: 'policy_worker' as const,
      worker: 'gate-policy',
      invocationId: randomUUID(),
    };
    const evidenceIds = [randomUUID()];
    expect(
      SpecialistDecisionSchema.parse({
        id: randomUUID(),
        runId: randomUUID(),
        role: 'gate',
        action: 'handoff',
        summary: 'Proof must recheck the final evidence.',
        source,
        occurredAt: timestamp,
        attempt: 1,
        evidenceIds,
        handoffTarget: 'proof',
      }).handoffTarget
    ).toBe('proof');
    expect(() =>
      SpecialistHandoffSchema.parse({
        id: randomUUID(),
        runId: randomUUID(),
        from: 'gate',
        to: 'gate',
        summary: 'Invalid self handoff.',
        actionRequired: null,
        source,
        occurredAt: timestamp,
        attempt: 1,
        evidenceIds,
      })
    ).toThrow(/different destination/i);
  });
});
