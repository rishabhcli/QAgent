import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Provenance } from '@qagent/contracts';
import { ArtifactStore, PersistenceRedactor, QAgentStorage } from '@qagent/storage';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { temporaryDirectory } from '../helpers.js';

const openStorage: QAgentStorage[] = [];
const timestamp = '2026-07-22T12:00:00.000Z';
const provenance: Provenance = { source: 'local', capturedAt: timestamp };

afterEach(() => {
  for (const storage of openStorage.splice(0)) storage.close();
});

describe('QAgentStorage', () => {
  it('preserves validated authorization evidence metadata while redacting credentials', async () => {
    const root = await temporaryDirectory('qagent-integration-evidence-');
    const credential = 'live-provider-credential';
    const storage = new QAgentStorage(join(root, 'qagent.sqlite'), {
      secretValues: [credential],
      environment: {},
    });
    openStorage.push(storage);
    const authorizationStates = ['not-applicable', 'unverified', 'verified'] as const;

    const stored = storage.upsertIntegration({
      id: randomUUID(),
      provider: 'browserbase',
      status: 'healthy',
      detail: `Authenticated with ${credential}`,
      evidence: authorizationStates.map((authorization, index) => ({
        sourceUrl: `https://api.browserbase.com/v1/projects/project-safe-${index}`,
        capturedAt: timestamp,
        kind:
          authorization === 'verified' ? ('provider-probe' as const) : ('page-inspection' as const),
        authorization,
        summary: `Authorization: Bearer ${credential}`,
      })),
      provenance: {
        source: 'provider',
        provider: 'browserbase',
        capturedAt: timestamp,
      },
      updatedAt: timestamp,
    });

    expect(stored.evidence?.map((item) => item.authorization)).toEqual(authorizationStates);
    expect(stored.evidence?.every((item) => item.summary.includes('[REDACTED]'))).toBe(true);
    expect(stored.evidence?.every((item) => !item.summary.includes(credential))).toBe(true);
    expect(stored.detail).toBe('Authenticated with [REDACTED]');
    expect(storage.getIntegration('browserbase')).toMatchObject(stored);
    expect(
      new PersistenceRedactor({ environment: {} }).redactValue({
        authorization: 'Bearer arbitrary-credential',
      })
    ).toEqual({ authorization: '[REDACTED]' });
  });

  it('persists and reads every durable run record with ordered events', async () => {
    const { storage, artifacts } = await createStorage();
    const project = storage.createProject({
      name: 'Example',
      path: '/tmp/qagent-example',
      configPath: '/tmp/qagent-example/.qagent.yml',
    });
    expect(storage.getProjectByPath(project.path)).toEqual(project);
    expect(storage.listProjects()).toEqual([project]);
    expect(storage.setProjectTrust(project.id, true).trusted).toBe(true);
    expect(storage.setProjectConfigPath(project.id, '/new/.qagent.yml').configPath).toBe(
      '/new/.qagent.yml'
    );
    await expect(() => storage.setProjectTrust(randomUUID(), true)).toThrow(/not found/);

    const run = storage.createRun({ projectId: project.id, requestedBy: 'desktop' });
    const secondRun = storage.createRun({ projectId: project.id, requestedBy: 'mcp' });
    expect(storage.listRuns(project.id)).toHaveLength(2);
    expect(storage.listRuns()).toHaveLength(2);
    expect(storage.listInterruptedRuns()).toEqual([]);
    storage.updateRun(run.id, { status: 'running', stage: 'test' });
    expect(storage.listInterruptedRuns().map((item) => item.id)).toEqual([run.id]);
    expect(storage.requestRunCancellation(run.id).cancelRequestedAt).not.toBeNull();
    await expect(() => storage.updateRun(randomUUID(), { status: 'failed' })).toThrow(/not found/);

    const first = storage.appendEvent(run.id, {
      kind: 'run.created',
      stage: 'preflight',
      payload: { message: 'Created' },
      provenance,
      artifactIds: [],
    });
    const second = storage.appendEvent(run.id, {
      kind: 'stage.started',
      stage: 'test',
      payload: { message: 'Testing' },
      provenance,
      artifactIds: [],
    });
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(storage.listEvents(run.id)).toEqual([first, second]);
    expect(storage.listEvents(run.id, 1)).toEqual([second]);

    const log = await artifacts.save({
      runId: run.id,
      kind: 'log',
      name: 'test.log',
      mimeType: 'text/plain',
      data: 'grounded failure',
      provenance,
    });
    const patchArtifact = await artifacts.save({
      runId: run.id,
      kind: 'patch',
      name: 'repair.diff',
      mimeType: 'text/x-diff',
      data: 'diff --git a/a b/a\n',
      provenance,
    });
    expect(storage.getArtifact(log.id)).toEqual(log);
    expect(storage.listArtifacts(run.id)).toEqual([log, patchArtifact]);

    const diagnosis = storage.createDiagnosis({
      id: randomUUID(),
      runId: run.id,
      summary: 'Failure summary',
      rootCause: 'Grounded root cause',
      confidence: 0.9234,
      evidenceArtifactIds: [log.id],
      provenance,
      createdAt: timestamp,
    });
    expect(storage.getDiagnosis(run.id)).toEqual(diagnosis);
    const patch = storage.createPatch({
      id: randomUUID(),
      runId: run.id,
      diagnosisId: diagnosis.id,
      artifactId: patchArtifact.id,
      summary: 'Repair',
      files: ['src/app.ts'],
      risk: 'normal',
      applied: true,
      createdAt: timestamp,
    });
    expect(storage.getPatch(run.id)).toEqual(patch);
    const verification = storage.createVerification({
      id: randomUUID(),
      runId: run.id,
      passed: true,
      commands: [
        {
          executable: 'node',
          args: ['--test'],
          exitCode: 0,
          durationMs: 42,
          artifactId: log.id,
        },
      ],
      artifactIds: [log.id],
      createdAt: timestamp,
    });
    expect(storage.getVerification(run.id)).toEqual(verification);

    const testCases = [
      {
        id: randomUUID(),
        projectId: project.id,
        name: 'Unit tests',
        kind: 'command' as const,
        definition: { executable: 'node', args: ['--test'] },
        provenance,
        createdAt: timestamp,
      },
    ];
    expect(storage.replaceTestCases(project.id, testCases)).toEqual(testCases);
    expect(storage.listTestCases(project.id)).toEqual(testCases);
    expect(storage.replaceTestCases(project.id, [])).toEqual([]);
    expect(storage.listTestCases(project.id)).toEqual([]);

    const call = {
      id: randomUUID(),
      runId: run.id,
      provider: 'openai',
      model: 'gpt-5-mini',
      purpose: 'triage' as const,
      status: 'succeeded' as const,
      inputTokens: 12,
      outputTokens: 4,
      costUsd: 0.001234,
      error: null,
      createdAt: timestamp,
    };
    storage.recordProviderCall(call);
    storage.recordProviderCall({
      ...call,
      id: randomUUID(),
      purpose: 'patch',
      status: 'failed',
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      error: 'provider unavailable',
    });
    expect(storage.listProviderCalls(run.id)).toEqual([
      expect.objectContaining(call),
      expect.objectContaining({ purpose: 'patch', status: 'failed', costUsd: null }),
    ]);

    const integration = {
      id: randomUUID(),
      provider: 'github',
      status: 'configured' as const,
      detail: 'Token present',
      provenance,
      updatedAt: timestamp,
    };
    storage.upsertIntegration(integration);
    storage.upsertIntegration({
      ...integration,
      id: randomUUID(),
      status: 'healthy',
      detail: 'Probe passed',
    });
    expect(storage.listIntegrations()).toEqual([
      expect.objectContaining({ ...integration, status: 'healthy', detail: 'Probe passed' }),
    ]);

    const knowledge = {
      id: randomUUID(),
      failureSummary: 'Counter failed',
      failureType: 'TEST',
      file: 'src/app.ts',
      fixSummary: 'Increment once',
      fixPatch: 'diff',
      successful: true,
      provenance,
      importedAt: timestamp,
    };
    expect(storage.importKnowledgeEntries([knowledge, knowledge])).toBe(1);
    expect(storage.listKnowledgeEntries()).toEqual([knowledge]);

    expect(storage.acquireLease(project.id, run.id, 10_000)).toBe(true);
    expect(storage.acquireLease(project.id, secondRun.id, 10_000)).toBe(false);
    expect(storage.renewLease(project.id, secondRun.id)).toBe(false);
    expect(storage.renewLease(project.id, run.id)).toBe(true);
    storage.releaseLease(project.id, secondRun.id);
    expect(storage.acquireLease(project.id, secondRun.id, -1)).toBe(false);
    storage.releaseLease(project.id, run.id);
    expect(storage.acquireLease(project.id, secondRun.id)).toBe(true);
  });

  it('allocates idempotent events and replays a durable projection high-water mark', async () => {
    const root = await temporaryDirectory('qagent-event-protocol-');
    const storage = new QAgentStorage(join(root, 'qagent.sqlite'), {
      secretValues: ['top-secret-value'],
      environment: {},
    });
    openStorage.push(storage);
    const project = storage.createProject({ name: 'Events', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const observed: string[] = [];
    const unsubscribe = storage.subscribeEvents((event) => observed.push(event.id));

    const first = storage.appendEvent(
      run.id,
      {
        kind: 'run.created',
        stage: 'preflight',
        payload: { message: 'Created with top-secret-value' },
        provenance,
        artifactIds: [],
      },
      'run-created'
    );
    const duplicate = storage.appendEvent(
      run.id,
      {
        kind: 'run.created',
        stage: 'preflight',
        payload: { message: 'A duplicate must return the original durable event' },
        provenance,
        artifactIds: [],
      },
      'run-created'
    );
    expect(duplicate).toEqual(first);
    expect(first.payload.message).toContain('[REDACTED]');
    expect(first.payload.message).not.toContain('top-secret-value');

    const committed = storage.commitRunEvent({
      runId: run.id,
      runUpdate: { status: 'running', stage: 'test' },
      idempotencyKey: 'stage-started',
      event: {
        kind: 'stage.started',
        stage: 'test',
        payload: { message: 'Testing' },
        provenance,
        artifactIds: [],
      },
    });
    expect(committed.run).toMatchObject({ status: 'running', stage: 'test' });
    expect(committed.event.sequence).toBe(2);
    expect(() =>
      storage.appendEvent(
        run.id,
        {
          kind: 'trace.status',
          stage: 'test',
          payload: { state: 'local' },
          provenance,
          artifactIds: [],
        },
        ''
      )
    ).toThrow(/idempotency key/);
    const third = storage.appendEvent(
      run.id,
      {
        kind: 'trace.status',
        stage: 'test',
        payload: { state: 'local' },
        provenance,
        artifactIds: [],
      },
      'trace-local'
    );
    expect(third.sequence).toBe(3);
    expect(observed).toEqual([first.id, committed.event.id, third.id]);

    const firstPage = storage.replayEvents({ runId: run.id, limit: 2 });
    expect(firstPage).toMatchObject({
      events: [first, committed.event],
      nextSequence: 2,
      highWaterSequence: 3,
      hasMore: true,
    });
    expect(
      storage.replayEvents({ runId: run.id, cursor: firstPage.nextCursor, limit: 2 })
    ).toMatchObject({
      events: [third],
      afterSequence: 2,
      nextSequence: 3,
      highWaterSequence: 3,
      hasMore: false,
    });
    expect(storage.getRunProjection(run.id)).toMatchObject({
      runId: run.id,
      status: 'running',
      stage: 'test',
      lastEventSequence: 3,
    });
    const database = new Database(storage.databasePath, { readonly: true });
    expect(
      database.prepare('SELECT last_event_sequence FROM runs WHERE id = ?').get(run.id)
    ).toEqual({ last_event_sequence: 3 });
    database.close();

    const bounded = storage.boundedOutput(`top-secret-value:${'x'.repeat(128)}`, 48);
    expect(bounded).toMatchObject({ truncated: true, redactionCount: 1 });
    expect(bounded.text).not.toContain('top-secret-value');
    unsubscribe();
  });

  it('persists fenced stage, provider, policy-worker, and specialist lifecycles', async () => {
    const { storage, artifacts, root } = await createStorage();
    const project = storage.createProject({ name: 'Lifecycles', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const attempt = storage.beginStageAttempt(run.id, 'triage', 'Triaging failure', provenance);
    expect(attempt).toMatchObject({ attempt: 1, status: 'running' });
    expect(
      storage.heartbeatStageAttempt(attempt.id, 'Reading grounded evidence', 'provider', provenance)
    ).toMatchObject({ status: 'waiting', waitingOn: 'provider' });

    const evidence = await artifacts.save({
      runId: run.id,
      kind: 'log',
      name: 'evidence.log',
      mimeType: 'text/plain',
      data: 'grounded evidence',
      provenance,
    });
    expect(
      storage.completeStageAttempt(
        attempt.id,
        'succeeded',
        'Triage complete',
        [evidence.id],
        provenance
      )
    ).toMatchObject({
      status: 'succeeded',
      summary: 'Triage complete',
      evidenceIds: [evidence.id],
    });
    expect(() => storage.heartbeatStageAttempt(attempt.id, 'Too late', null, provenance)).toThrow(
      /not active/
    );
    expect(() =>
      storage.completeStageAttempt(attempt.id, 'failed', 'Too late', [evidence.id], provenance)
    ).toThrow(/not active/);

    const providerCallId = randomUUID();
    const startedProviderCall = {
      id: providerCallId,
      runId: run.id,
      provider: 'openai',
      model: 'gpt-5-mini',
      purpose: 'triage' as const,
      status: 'started' as const,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      error: null,
      createdAt: timestamp,
      attempt: 1,
      startedAt: timestamp,
      completedAt: null,
      durationMs: null,
      specialistRole: 'scout' as const,
      evidenceIds: [],
      requestDigest: 'a'.repeat(64),
      responseDigest: null,
      errorCode: null,
    };
    storage.beginProviderCall(startedProviderCall, {
      kind: 'model.call_started',
      stage: 'triage',
      payload: {
        providerCallId,
        provider: startedProviderCall.provider,
        model: startedProviderCall.model,
        purpose: startedProviderCall.purpose,
        attempt: 1,
        specialistRole: 'scout',
      },
      provenance,
      artifactIds: [],
    });
    const completedProviderCall = {
      ...startedProviderCall,
      status: 'succeeded' as const,
      inputTokens: 42,
      outputTokens: 7,
      costUsd: 0.002,
      completedAt: timestamp,
      durationMs: 25,
      evidenceIds: [evidence.id],
      responseDigest: 'b'.repeat(64),
    };
    storage.finishProviderCall(providerCallId, completedProviderCall, {
      kind: 'model.call_completed',
      stage: 'triage',
      payload: {
        providerCallId,
        durationMs: 25,
        inputTokens: 42,
        outputTokens: 7,
        costUsd: 0.002,
      },
      provenance,
      artifactIds: [evidence.id],
    });
    expect(storage.listProviderCalls(run.id)).toEqual([
      expect.objectContaining({
        id: providerCallId,
        status: 'succeeded',
        responseDigest: 'b'.repeat(64),
      }),
    ]);

    const workerCall = {
      id: randomUUID(),
      runId: run.id,
      worker: 'qagent.specialist.gate',
      version: '1',
      attempt: 1,
      status: 'succeeded' as const,
      inputDigest: 'c'.repeat(64),
      outputDigest: 'd'.repeat(64),
      error: null,
      startedAt: timestamp,
      completedAt: timestamp,
    };
    expect(storage.recordPolicyWorkerCall(workerCall)).toEqual(workerCall);
    expect(storage.listPolicyWorkerCalls(run.id)).toEqual([workerCall]);
    const source = {
      kind: 'policy_worker' as const,
      worker: workerCall.worker,
      invocationId: workerCall.id,
    };
    const activity = {
      id: randomUUID(),
      runId: run.id,
      role: 'gate' as const,
      status: 'succeeded' as const,
      summary: 'Evidence accepted',
      source,
      occurredAt: timestamp,
      attempt: 1,
      evidenceIds: [evidence.id],
      handoffTarget: null,
    };
    expect(storage.recordSpecialistActivity(activity, 'triage', provenance)).toEqual(activity);
    expect(storage.listSpecialistActivities(run.id)).toEqual([activity]);
    const critique = {
      id: randomUUID(),
      runId: run.id,
      activityId: activity.id,
      role: 'gate' as const,
      verdict: 'accepted' as const,
      summary: 'Gate confirmed the proof is grounded',
      source,
      occurredAt: timestamp,
      attempt: 1,
      evidenceIds: [evidence.id],
      actionRequired: null,
    };
    expect(storage.recordSpecialistCritique(critique, 'verify', provenance)).toEqual(critique);
    expect(storage.listSpecialistCritiques(run.id)).toEqual([critique]);
    const decision = {
      id: randomUUID(),
      runId: run.id,
      role: 'gate' as const,
      action: 'complete' as const,
      summary: 'Continue to completion',
      source,
      occurredAt: timestamp,
      attempt: 1,
      evidenceIds: [evidence.id],
      handoffTarget: null,
    };
    expect(storage.recordSpecialistDecision(decision, 'verify', provenance)).toEqual(decision);
    expect(storage.listSpecialistDecisions(run.id)).toEqual([decision]);
  });

  it('settles a run and its terminal event exactly once in one SQLite transaction', async () => {
    const { storage, root } = await createStorage();
    const project = storage.createProject({ name: 'Settlement', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    storage.updateRun(run.id, { status: 'running', stage: 'verify' });
    storage.appendEvent(run.id, {
      kind: 'stage.started',
      stage: 'verify',
      payload: { message: 'Verifying' },
      provenance,
      artifactIds: [],
    });

    const first = storage.settleRunOnce(
      run.id,
      'succeeded',
      {
        kind: 'run.completed',
        stage: 'complete',
        payload: { message: 'Verified repair completed' },
        provenance,
        artifactIds: [],
      },
      { availableActions: [], failureCode: null }
    );
    expect(first).toMatchObject({
      changed: true,
      run: {
        status: 'succeeded',
        stage: 'complete',
        summary: 'Verified repair completed',
        error: null,
        availableActions: [],
        completedAt: expect.any(String),
      },
      event: { kind: 'run.completed', sequence: 2 },
    });

    const competing = new QAgentStorage(join(root, 'qagent.sqlite'));
    openStorage.push(competing);
    const second = competing.settleRunOnce(
      run.id,
      'failed',
      {
        kind: 'run.failed',
        stage: 'verify',
        payload: { message: 'A late failure must not replace success' },
        provenance,
        artifactIds: [],
      },
      { availableActions: ['retry'], failureCode: 'unexpected_failure' }
    );
    expect(second.changed).toBe(false);
    expect(second.run.status).toBe('succeeded');
    expect(second.event?.id).toBe(first.event?.id);
    expect(competing.listEvents(run.id).filter((event) => event.kind.startsWith('run.'))).toEqual([
      first.event,
    ]);

    const mismatched = storage.createRun({ projectId: project.id, requestedBy: 'mcp' });
    expect(() =>
      storage.settleRunOnce(
        mismatched.id,
        'cancelled',
        {
          kind: 'run.failed',
          stage: 'preflight',
          payload: { message: 'Mismatched terminal event' },
          provenance,
          artifactIds: [],
        } as never,
        { availableActions: ['retry'], failureCode: null }
      )
    ).toThrow(/requires event run.cancelled/);
    expect(storage.getRun(mismatched.id)?.status).toBe('queued');
    expect(storage.listEvents(mismatched.id)).toEqual([]);

    const interrupted = storage.createRun({ projectId: project.id, requestedBy: 'resume' });
    storage.updateRun(interrupted.id, {
      status: 'interrupted',
      availableActions: ['resume', 'cancel'],
    });
    expect(
      storage.settleRunOnce(
        interrupted.id,
        'cancelled',
        {
          kind: 'run.cancelled',
          stage: 'preflight',
          payload: { message: 'Cancelled during recovery' },
          provenance,
          artifactIds: [],
        },
        { availableActions: ['retry'], failureCode: null }
      )
    ).toMatchObject({
      changed: true,
      run: { status: 'cancelled', availableActions: ['retry'] },
      event: { kind: 'run.cancelled' },
    });

    const waiting = storage.createRun({ projectId: project.id, requestedBy: 'desktop' });
    storage.updateRun(waiting.id, {
      status: 'waiting_for_intervention',
      availableActions: ['resolve_intervention', 'cancel'],
      failureCode: 'provider_outage',
      intervention: {
        id: randomUUID(),
        runId: waiting.id,
        reason: 'provider_outage',
        summary: 'Provider configuration needs attention',
        requiredAction: {
          id: 'configure-provider',
          label: 'Configure provider',
          description: 'Configure a working model provider.',
          type: 'application',
          action: 'configure_provider',
        },
        resolutionOptions: ['provider_reconfigured'],
        evidenceArtifactIds: [],
        requestedAt: timestamp,
        resolvedAt: null,
        resolution: null,
      },
    });
    expect(
      storage.settleRunOnce(
        waiting.id,
        'cancelled',
        {
          kind: 'run.cancelled',
          stage: 'triage',
          payload: { message: 'Cancelled while waiting' },
          provenance,
          artifactIds: [],
        },
        { availableActions: ['retry'], failureCode: null }
      )
    ).toMatchObject({
      changed: true,
      run: { status: 'cancelled', intervention: null, availableActions: ['retry'] },
      event: { kind: 'run.cancelled' },
    });
  });

  it('atomically marks a pre-recorded patch as applied', async () => {
    const { storage, artifacts, root } = await createStorage();
    const project = storage.createProject({ name: 'Patch recovery', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const artifact = await artifacts.save({
      runId: run.id,
      kind: 'patch',
      name: 'repair.diff',
      mimeType: 'text/x-diff',
      data: 'diff',
      provenance,
    });
    const diagnosis = storage.createDiagnosis({
      id: randomUUID(),
      runId: run.id,
      summary: 'Broken counter',
      rootCause: 'Increment is wrong',
      confidence: 1,
      evidenceArtifactIds: [],
      provenance,
      createdAt: timestamp,
    });
    const pending = storage.createPatch({
      id: randomUUID(),
      runId: run.id,
      diagnosisId: diagnosis.id,
      artifactId: artifact.id,
      summary: 'Fix increment',
      files: [],
      risk: 'normal',
      applied: false,
      createdAt: timestamp,
    });

    const inspection = { files: ['src/counter.mjs', 'package.json'], highRisk: true };
    const applied = storage.markPatchApplied(pending.id, inspection);
    expect(applied).toMatchObject({
      id: pending.id,
      files: inspection.files,
      risk: 'high',
      applied: true,
    });
    expect(storage.markPatchApplied(pending.id, inspection)).toEqual(applied);
    expect(() =>
      storage.markPatchApplied(pending.id, {
        files: ['src/different.mjs'],
        highRisk: false,
      })
    ).toThrow(/different inspection results/);
    expect(() =>
      storage.markPatchApplied(randomUUID(), { files: ['src/counter.mjs'], highRisk: false })
    ).toThrow(/was not found/);
  });

  it('fences live lease owners and permits a dead-owner takeover for the same run', async () => {
    const { storage, root } = await createStorage();
    const project = storage.createProject({ name: 'Lease fencing', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const otherRun = storage.createRun({ projectId: project.id, requestedBy: 'mcp' });
    const firstOwner = process.pid + 10_000;
    const secondOwner = process.pid + 20_000;

    expect(storage.acquireLease(project.id, run.id, 10_000, process.pid)).toBe(true);
    expect(storage.takeoverLeaseForRecovery(project.id, run.id, 10_000, secondOwner)).toBe(false);
    storage.releaseLease(project.id, run.id, process.pid);

    expect(storage.acquireLease(project.id, run.id, -1, process.pid)).toBe(true);
    expect(storage.acquireLease(project.id, run.id, 10_000, secondOwner)).toBe(false);
    expect(storage.takeoverLeaseForRecovery(project.id, run.id, 10_000, secondOwner)).toBe(false);
    storage.releaseLease(project.id, run.id, process.pid);

    expect(storage.acquireLease(project.id, run.id, 10_000, firstOwner)).toBe(true);
    expect(storage.acquireLease(project.id, run.id, 10_000, secondOwner)).toBe(false);
    expect(storage.renewLease(project.id, run.id, 10_000, secondOwner)).toBe(false);
    storage.releaseLease(project.id, run.id, secondOwner);
    expect(storage.renewLease(project.id, run.id, 10_000, firstOwner)).toBe(true);
    expect(storage.acquireLease(project.id, otherRun.id, 10_000, secondOwner)).toBe(false);

    storage.releaseLease(project.id, run.id, firstOwner);
    expect(storage.acquireLease(project.id, run.id, -1, firstOwner)).toBe(true);
    expect(storage.acquireLease(project.id, run.id, 10_000, secondOwner)).toBe(false);
    storage.releaseLease(project.id, run.id, firstOwner);
    expect(storage.acquireLease(project.id, run.id, 10_000, secondOwner)).toBe(true);
    expect(storage.renewLease(project.id, run.id, 10_000, secondOwner)).toBe(true);

    storage.releaseLease(project.id, run.id, secondOwner);
    const exitedOwner = spawn(process.execPath, ['-e', '']);
    const deadOwner = exitedOwner.pid;
    if (deadOwner === undefined) throw new Error('Lease test process did not start');
    await new Promise<void>((resolveExit, reject) => {
      exitedOwner.once('error', reject);
      exitedOwner.once('exit', () => resolveExit());
    });
    expect(storage.acquireLease(project.id, run.id, 10_000, deadOwner)).toBe(true);
    expect(storage.takeoverLeaseForRecovery(project.id, otherRun.id, 10_000, secondOwner)).toBe(
      false
    );
    expect(storage.takeoverLeaseForRecovery(project.id, run.id, 10_000, secondOwner)).toBe(true);
    expect(storage.renewLease(project.id, run.id, 10_000, secondOwner)).toBe(true);
  });

  it('persists one typed recovery checkpoint cursor per run', async () => {
    const { storage, root } = await createStorage();
    const project = storage.createProject({ name: 'Recovery', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'resume' });
    const worktree = storage.saveRunCheckpoint(run.id, 'worktree_created', {
      worktreePath: join(root, 'worktrees', run.id),
      branch: `qagent/${run.id.slice(0, 8)}-recovery`,
      baseSha: 'a'.repeat(40),
    });
    expect(storage.getRunCheckpoint(run.id)).toEqual(worktree);

    const commit = storage.saveRunCheckpoint(run.id, 'commit_created', {
      commitSha: 'b'.repeat(40),
    });
    expect(storage.getRunCheckpoint(run.id)).toEqual(commit);
    expect(() =>
      storage.saveRunCheckpoint(run.id, 'worktree_created', {
        commitSha: 'not-a-worktree',
      } as never)
    ).toThrow();
    expect(storage.getRunCheckpoint(run.id)).toEqual(commit);
    storage.clearRunCheckpoint(run.id);
    expect(storage.getRunCheckpoint(run.id)).toBeNull();
  });

  it('applies migrations once and reopens a WAL database', async () => {
    const root = await temporaryDirectory('qagent-migrations-');
    const databasePath = join(root, 'nested/qagent.sqlite');
    const storage = new QAgentStorage(databasePath);
    storage.close();
    const index = openStorage.indexOf(storage);
    if (index >= 0) openStorage.splice(index, 1);
    const database = new Database(databasePath);
    expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(
      database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()
    ).toEqual([
      { version: 1, name: 'local-first-foundation' },
      { version: 2, name: 'verification-browser-evidence' },
      { version: 3, name: 'durable-run-actions-and-recovery' },
      { version: 4, name: 'truthful-observability-protocol' },
      { version: 5, name: 'immutable-terminal-manifests' },
      { version: 6, name: 'immutable-run-manifest-records' },
    ]);
    database.close();
    const reopened = new QAgentStorage(databasePath);
    openStorage.push(reopened);
    expect(reopened.listProjects()).toEqual([]);
  });

  it('upgrades populated v1 data without losing legacy events or terminal semantics', async () => {
    const root = await temporaryDirectory('qagent-v1-upgrade-');
    const databasePath = join(root, 'qagent.sqlite');
    const initialized = new QAgentStorage(databasePath);
    initialized.close();

    const database = new Database(databasePath);
    for (const { name } of database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name LIKE 'finalized_runs_block_%'`
      )
      .all() as Array<{ name: string }>) {
      database.exec(`DROP TRIGGER ${name}`);
    }
    database.exec(`
      DROP TABLE run_manifests;
      DROP TABLE specialist_critiques;
      DROP TABLE specialist_decisions;
      DROP TABLE specialist_activities;
      DROP TABLE policy_worker_calls;
      DROP TABLE stage_attempts;
      DROP TABLE run_projections;
      DROP TABLE run_manifest_contexts;
      DROP INDEX run_events_idempotency_unique;

      ALTER TABLE provider_calls DROP COLUMN error_code;
      ALTER TABLE provider_calls DROP COLUMN response_digest;
      ALTER TABLE provider_calls DROP COLUMN request_digest;
      ALTER TABLE provider_calls DROP COLUMN evidence_artifact_ids_json;
      ALTER TABLE provider_calls DROP COLUMN specialist_role;
      ALTER TABLE provider_calls DROP COLUMN duration_ms;
      ALTER TABLE provider_calls DROP COLUMN completed_at;
      ALTER TABLE provider_calls DROP COLUMN started_at;
      ALTER TABLE provider_calls DROP COLUMN attempt;

      ALTER TABLE artifacts DROP COLUMN redaction_count;
      ALTER TABLE artifacts DROP COLUMN omitted_bytes;
      ALTER TABLE artifacts DROP COLUMN original_bytes;
      ALTER TABLE artifacts DROP COLUMN ready_at;
      ALTER TABLE artifacts DROP COLUMN state;

      ALTER TABLE run_events DROP COLUMN idempotency_key;
      ALTER TABLE run_events DROP COLUMN schema_version;
      ALTER TABLE runs DROP COLUMN last_event_sequence;

      DROP TABLE run_checkpoints;
      ALTER TABLE integrations DROP COLUMN evidence_json;
      ALTER TABLE integrations DROP COLUMN requirements_json;
      ALTER TABLE runs DROP COLUMN failure_code;
      ALTER TABLE runs DROP COLUMN recovery_count;
      ALTER TABLE runs DROP COLUMN last_heartbeat_at;
      ALTER TABLE runs DROP COLUMN intervention_json;
      ALTER TABLE runs DROP COLUMN available_actions_json;
      ALTER TABLE runs DROP COLUMN retry_of_run_id;
      ALTER TABLE runs DROP COLUMN attempt;

      ALTER TABLE verifications DROP COLUMN artifact_ids_json;
      DELETE FROM schema_migrations WHERE version >= 2;
    `);
    const projectId = randomUUID();
    const runId = randomUUID();
    const eventId = randomUUID();
    const legacyMessage = `legacy failure: ${'x'.repeat(5_000)}`;
    database
      .prepare(
        `INSERT INTO projects(
           id, name, path, trusted, config_path, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(projectId, 'Legacy project', join(root, 'repo'), 1, null, timestamp, timestamp);
    database
      .prepare(
        `INSERT INTO runs(
           id, project_id, status, stage, requested_by, branch, worktree_path, base_sha,
           summary, error, cancel_requested_at, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        projectId,
        'failed',
        'verify',
        'cli',
        null,
        null,
        null,
        null,
        legacyMessage,
        null,
        timestamp,
        timestamp,
        timestamp
      );
    database
      .prepare(
        `INSERT INTO run_events(
           id, run_id, sequence, stage, kind, occurred_at, provenance_json,
           artifact_ids_json, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        runId,
        1,
        'verify',
        'run.failed',
        timestamp,
        JSON.stringify(provenance),
        '[]',
        JSON.stringify({ message: legacyMessage })
      );
    database.close();

    const migrated = new QAgentStorage(databasePath);
    openStorage.push(migrated);
    expect(migrated.getRun(runId)).toMatchObject({
      status: 'failed',
      stage: 'verify',
      failureCode: 'unexpected_failure',
    });
    const [event] = migrated.listEvents(runId);
    expect(event).toMatchObject({ id: eventId, sequence: 1, kind: 'run.failed' });
    expect(event?.kind === 'run.failed' ? event.payload.message : null).toBe(legacyMessage);
    expect(migrated.getRunProjection(runId)).toMatchObject({
      status: 'failed',
      stage: 'verify',
      lastEventSequence: 1,
    });
    const migratedRun = migrated.getRun(runId)!;
    const migratedManifest = await new ArtifactStore(
      join(root, 'artifacts'),
      migrated
    ).saveRunManifest({
      runId,
      status: migratedRun.status,
      stage: migratedRun.stage,
      summary: migratedRun.summary,
      error: migratedRun.error,
      completedAt: migratedRun.completedAt,
      traceState: 'local',
    });
    expect(migratedManifest.manifest.outcome.error).toContain('[QAGENT OUTPUT TRUNCATED]');
    expect(Buffer.byteLength(migratedManifest.manifest.outcome.error ?? '')).toBeLessThanOrEqual(
      4_096
    );
    const auditDatabase = new Database(databasePath);
    expect(() =>
      auditDatabase
        .prepare('UPDATE run_manifests SET sha256 = ? WHERE run_id = ?')
        .run('0'.repeat(64), runId)
    ).toThrow(/run manifest record is immutable/);
    expect(() =>
      auditDatabase.prepare('DELETE FROM run_manifests WHERE run_id = ?').run(runId)
    ).toThrow(/run manifest record is immutable/);
    expect(
      auditDatabase.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
    ).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
    ]);
    auditDatabase.close();
  });
});

describe('ArtifactStore', () => {
  it('canonicalizes storage aliases and rejects a symlinked run directory escape', async () => {
    const root = await temporaryDirectory('qagent-artifact-alias-');
    const physicalRoot = join(root, 'physical');
    const aliasRoot = join(root, 'alias');
    await mkdir(physicalRoot);
    await symlink(physicalRoot, aliasRoot, 'dir');
    const storage = new QAgentStorage(join(root, 'qagent.sqlite'));
    openStorage.push(storage);
    const project = storage.createProject({ name: 'Example', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const aliased = new ArtifactStore(aliasRoot, storage);
    const artifact = await aliased.save({
      runId: run.id,
      kind: 'log',
      name: 'aliased.log',
      mimeType: 'text/plain',
      data: 'durable bytes',
      provenance,
    });

    const reopened = new ArtifactStore(physicalRoot, storage);
    expect(reopened.root).toBe(aliased.root);
    expect((await reopened.read(artifact)).toString()).toBe('durable bytes');

    const escapedRun = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(reopened.root, escapedRun.id), 'dir');
    await expect(
      reopened.save({
        runId: escapedRun.id,
        kind: 'log',
        name: 'escape.log',
        mimeType: 'text/plain',
        data: 'must stay contained',
        provenance,
      })
    ).rejects.toThrow(/escaped/);
  });

  it('checks integrity, exports bytes, and prunes unreferenced artifacts', async () => {
    const { storage, artifacts, root } = await createStorage();
    const project = storage.createProject({ name: 'Example', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const artifact = await artifacts.save({
      runId: run.id,
      kind: 'log',
      name: '../../unsafe name.log',
      mimeType: 'text/plain',
      data: 'verified bytes',
      provenance,
    });
    expect(artifact.name).toBe('../../unsafe name.log');
    expect(artifact.path.startsWith(artifacts.root)).toBe(true);
    expect((await artifacts.read(artifact)).toString()).toBe('verified bytes');

    const destination = join(root, 'export/nested/log.txt');
    await artifacts.export(artifact, destination);
    expect(await readFile(destination, 'utf8')).toBe('verified bytes');
    await writeFile(artifact.path, 'tampered');
    await expect(artifacts.read(artifact)).rejects.toThrow(/integrity/);
    await writeFile(artifact.path, 'verified bytes');

    const result = await artifacts.prune(new Date(Date.now() + 60_000));
    expect(result).toEqual({ deleted: 1, bytes: artifact.bytes, retained: 0 });
    expect(storage.getArtifact(artifact.id)).toBeNull();
    await expect(access(artifact.path)).rejects.toThrow();
  });

  it('retains artifacts referenced by a structured event artifact ID', async () => {
    const { storage, artifacts, root } = await createStorage();
    const project = storage.createProject({ name: 'Example', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const artifact = await artifacts.save({
      runId: run.id,
      kind: 'log',
      name: 'command.log',
      mimeType: 'text/plain',
      data: 'evidence',
      provenance,
    });
    storage.appendEvent(run.id, {
      kind: 'command.output',
      stage: 'test',
      payload: {
        commandId: randomUUID(),
        attempt: 1,
        stream: 'stdout',
        chunkIndex: 0,
        output: storage.boundedOutput('bounded output'),
      },
      provenance,
      artifactIds: [artifact.id],
    });

    expect(await artifacts.prune(new Date(Date.now() + 60_000))).toEqual({
      deleted: 0,
      bytes: 0,
      retained: 1,
    });
  });

  it('retains patch artifacts referenced by durable patch records', async () => {
    const { storage, artifacts, root } = await createStorage();
    const project = storage.createProject({ name: 'Example', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const patchArtifact = await artifacts.save({
      runId: run.id,
      kind: 'patch',
      name: 'repair.diff',
      mimeType: 'text/x-diff',
      data: 'diff',
      provenance,
    });
    const diagnosis = storage.createDiagnosis({
      id: randomUUID(),
      runId: run.id,
      summary: 'Summary',
      rootCause: 'Cause',
      confidence: 1,
      evidenceArtifactIds: [],
      provenance,
      createdAt: timestamp,
    });
    storage.createPatch({
      id: randomUUID(),
      runId: run.id,
      diagnosisId: diagnosis.id,
      artifactId: patchArtifact.id,
      summary: 'Patch',
      files: ['src/app.ts'],
      risk: 'normal',
      applied: true,
      createdAt: timestamp,
    });

    expect(await artifacts.prune(new Date(Date.now() + 60_000))).toEqual({
      deleted: 0,
      bytes: 0,
      retained: 1,
    });
    expect(storage.getArtifact(patchArtifact.id)).not.toBeNull();
  });

  it('returns the latest durable diagnosis, patch, and verification attempt', async () => {
    const { storage, artifacts, root } = await createStorage();
    const project = storage.createProject({ name: 'Example', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const patchArtifact = await artifacts.save({
      runId: run.id,
      kind: 'patch',
      name: 'repair.diff',
      mimeType: 'text/x-diff',
      data: 'diff',
      provenance,
    });
    const firstDiagnosis = storage.createDiagnosis({
      id: randomUUID(),
      runId: run.id,
      summary: 'First diagnosis',
      rootCause: 'First cause',
      confidence: 0.5,
      evidenceArtifactIds: [],
      provenance,
      createdAt: timestamp,
    });
    const secondDiagnosis = storage.createDiagnosis({
      ...firstDiagnosis,
      id: randomUUID(),
      summary: 'Second diagnosis',
    });
    storage.createPatch({
      id: randomUUID(),
      runId: run.id,
      diagnosisId: firstDiagnosis.id,
      artifactId: patchArtifact.id,
      summary: 'Rejected patch',
      files: [],
      risk: 'normal',
      applied: false,
      createdAt: timestamp,
    });
    const finalPatch = storage.createPatch({
      id: randomUUID(),
      runId: run.id,
      diagnosisId: secondDiagnosis.id,
      artifactId: patchArtifact.id,
      summary: 'Applied patch',
      files: ['src/app.ts'],
      risk: 'normal',
      applied: true,
      createdAt: timestamp,
    });
    storage.createVerification({
      id: randomUUID(),
      runId: run.id,
      passed: false,
      commands: [],
      artifactIds: [],
      createdAt: timestamp,
    });
    const finalVerification = storage.createVerification({
      id: randomUUID(),
      runId: run.id,
      passed: true,
      commands: [],
      artifactIds: [],
      createdAt: timestamp,
    });

    expect(storage.getDiagnosis(run.id)?.id).toBe(secondDiagnosis.id);
    expect(storage.getPatch(run.id)).toEqual(finalPatch);
    expect(storage.getVerification(run.id)).toEqual(finalVerification);
    expect(storage.listPatches(run.id)).toHaveLength(2);
  });
});

async function createStorage() {
  const root = await temporaryDirectory('qagent-storage-');
  const storage = new QAgentStorage(join(root, 'qagent.sqlite'));
  openStorage.push(storage);
  return {
    root,
    storage,
    artifacts: new ArtifactStore(join(root, 'artifacts'), storage),
  };
}
