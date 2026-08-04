import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Provenance, ProviderCall, RunEvent, SpecialistRole } from '@qagent/contracts';
import { ArtifactStore, QAgentStorage } from '@qagent/storage';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { temporaryDirectory } from '../helpers.js';

const timestamp = '2026-07-23T12:00:00.000Z';
const provenance: Provenance = { source: 'local', capturedAt: timestamp };
const openStorage: QAgentStorage[] = [];

afterEach(() => {
  for (const storage of openStorage.splice(0)) storage.close();
});

describe('durable run observability', () => {
  it('commits a run transition and its event atomically, including rollback on invalid events', async () => {
    const { storage, root } = await createStorage();
    const project = storage.createProject({ name: 'Atomic', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const committed = storage.commitRunEvent({
      runId: run.id,
      runUpdate: {
        status: 'running',
        stage: 'test',
        lastHeartbeatAt: timestamp,
      },
      event: {
        kind: 'stage.started',
        stage: 'test',
        payload: { message: 'Executing deterministic tests', attempt: 1 },
        provenance,
        artifactIds: [],
      },
      idempotencyKey: 'test-stage-started-1',
    });

    expect(committed.run).toMatchObject({
      status: 'running',
      stage: 'test',
      lastHeartbeatAt: timestamp,
    });
    expect(committed.event).toMatchObject({
      kind: 'stage.started',
      sequence: 1,
      payload: { message: 'Executing deterministic tests' },
    });
    expect(storage.getRunProjection(run.id)).toMatchObject({
      status: 'running',
      stage: 'test',
      lastEventSequence: 1,
      currentAction: {
        kind: 'stage',
        summary: 'Executing deterministic tests',
      },
    });
    const duplicate = storage.commitRunEvent({
      runId: run.id,
      runUpdate: { stage: 'verify' },
      event: {
        kind: 'stage.started',
        stage: 'verify',
        payload: { message: 'This duplicate transition must not be applied.', attempt: 2 },
        provenance,
        artifactIds: [],
      },
      idempotencyKey: 'test-stage-started-1',
    });
    expect(duplicate.event).toEqual(committed.event);
    expect(duplicate.run.stage).toBe('test');

    expect(() =>
      storage.commitRunEvent({
        runId: run.id,
        runUpdate: { stage: 'verify' },
        event: {
          kind: 'run.created',
          stage: 'verify',
          payload: { message: 'This event has a deliberately invalid artifact reference.' },
          provenance,
          artifactIds: ['not-a-uuid'],
        },
      })
    ).toThrow();
    expect(storage.getRun(run.id)?.stage).toBe('test');
    expect(storage.listEvents(run.id)).toEqual([committed.event]);
  });

  it('allocates monotonic sequences across connections and replays cursors without gaps or duplicates', async () => {
    const { storage, root, databasePath } = await createStorage();
    const project = storage.createProject({ name: 'Replay', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'mcp' });
    const otherWriter = new QAgentStorage(databasePath);
    openStorage.push(otherWriter);

    for (let index = 0; index < 40; index += 1) {
      const writer = index % 2 === 0 ? storage : otherWriter;
      writer.appendEvent(run.id, {
        kind: 'run.created',
        stage: 'preflight',
        payload: { message: `Durable event ${index + 1}` },
        provenance,
        artifactIds: [],
      });
      const visible = (index % 2 === 0 ? otherWriter : storage).listEvents(run.id);
      expect(visible.map((event) => event.sequence)).toEqual(
        Array.from({ length: index + 1 }, (_, sequence) => sequence + 1)
      );
    }

    const idempotent = storage.appendEvent(
      run.id,
      {
        kind: 'run.created',
        stage: 'preflight',
        payload: { message: 'Idempotent reconnect marker' },
        provenance,
        artifactIds: [],
      },
      'reconnect-marker'
    );
    expect(
      otherWriter.appendEvent(
        run.id,
        {
          kind: 'run.created',
          stage: 'preflight',
          payload: { message: 'This duplicate is not persisted' },
          provenance,
          artifactIds: [],
        },
        'reconnect-marker'
      )
    ).toEqual(idempotent);

    const replayed: RunEvent[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const page = storage.replayEvents({
        runId: run.id,
        cursor,
        limit: 7,
      });
      replayed.push(...page.events);
      cursor = page.nextCursor;
      hasMore = page.hasMore;
    }

    expect(replayed).toHaveLength(41);
    expect(replayed.map((event) => event.sequence)).toEqual(
      Array.from({ length: 41 }, (_, sequence) => sequence + 1)
    );
    expect(new Set(replayed.map((event) => event.id)).size).toBe(41);
    expect(storage.replayEvents({ runId: run.id, cursor, limit: 7 }).events).toEqual([]);
    expect(() =>
      storage.replayEvents({
        runId: storage.createRun({ projectId: project.id, requestedBy: 'cli' }).id,
        cursor,
      })
    ).toThrow(/different run/);
  });

  it('keeps provider start provenance immutable and requires an exact terminal event', async () => {
    const { storage, root } = await createStorage();
    const project = storage.createProject({ name: 'Provider lifecycle', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const providerCallId = randomUUID();
    const started = providerCall(run.id, providerCallId, 'trace', 'started');
    storage.beginProviderCall(started, {
      kind: 'model.call_started',
      stage: 'triage',
      payload: {
        providerCallId,
        provider: started.provider,
        model: started.model,
        purpose: started.purpose,
        attempt: 1,
        specialistRole: 'trace',
      },
      provenance,
      artifactIds: [],
    });
    expect(() =>
      storage.finishProviderCall(
        providerCallId,
        {
          ...started,
          status: 'failed',
          startedAt: '2026-07-23T12:00:01.000Z',
          completedAt: timestamp,
          durationMs: null,
          error: null,
          errorCode: 'provider_error',
        },
        {
          kind: 'model.call_failed',
          stage: 'triage',
          payload: {
            providerCallId,
            durationMs: 123,
            error: 'provider unavailable',
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
          },
          provenance,
          artifactIds: [],
        }
      )
    ).toThrow(/does not match its start/);
    expect(storage.listProviderCalls(run.id)).toEqual([
      expect.objectContaining({ id: providerCallId, status: 'started', startedAt: timestamp }),
    ]);
    const failed = storage.finishProviderCall(
      providerCallId,
      {
        ...started,
        status: 'failed',
        completedAt: timestamp,
        durationMs: 123,
        error: 'provider unavailable',
        errorCode: 'provider_error',
      },
      {
        kind: 'model.call_failed',
        stage: 'triage',
        payload: {
          providerCallId,
          durationMs: 123,
          error: 'provider unavailable',
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
        provenance,
        artifactIds: [],
      }
    );
    expect(failed).toMatchObject({
      id: providerCallId,
      status: 'failed',
      durationMs: 123,
      error: 'provider unavailable',
      startedAt: timestamp,
    });
    expect(storage.listEvents(run.id).map((event) => event.kind)).toEqual([
      'model.call_started',
      'model.call_failed',
    ]);
  });

  it('bounds 10MB output and removes arbitrary injected secrets from SQLite and artifacts', async () => {
    const secret = 'arbitrary-zebra-secret-7fe9a62c';
    const basicPassword = 'basic-pass-9327';
    const { storage, artifacts, root, databasePath } = await createStorage({
      secretValues: [secret],
      environment: {},
    });
    const project = storage.createProject({ name: 'Redaction', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    storage.updateRun(run.id, {
      status: 'running',
      stage: 'test',
      summary: `Running with ${secret}`,
    });
    storage.appendEvent(run.id, {
      kind: 'run.created',
      stage: 'test',
      payload: { message: `Provider emitted ${secret}` },
      provenance: {
        source: 'provider',
        provider: `provider-${secret}`,
        capturedAt: timestamp,
      },
      artifactIds: [],
    });
    storage.appendEvent(run.id, {
      kind: 'browser.navigation_started',
      stage: 'test',
      payload: {
        sessionId: randomUUID(),
        navigationId: randomUUID(),
        url: `https://alice:${basicPassword}@example.com/private`,
        attempt: 1,
      },
      provenance,
      artifactIds: [],
    });
    storage.upsertRunManifestContext({
      runId: run.id,
      configDigest: 'a'.repeat(64),
      configPath: join(root, `${secret}.yml`),
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
      branch: `qagent/${secret}`,
      worktreePath: join(root, secret),
      commands: [
        {
          executable: 'node',
          args: ['fixture.mjs', secret],
          cwd: join(root, secret),
          env: { QAGENT_TEST_TOKEN: secret, PASSTHROUGH: secret },
          timeoutMs: 10_000,
        },
      ],
      browserChecks: [{ name: `checkpoint-${secret}`, steps: [`open ${secret}`] }],
      updatedAt: timestamp,
    });

    const noisy = `${'noisy-output\n'.repeat(806_597)}${secret}`;
    expect(Buffer.byteLength(noisy)).toBeGreaterThan(10 * 1_024 * 1_024);
    const bounded = storage.boundedOutput(noisy, 48 * 1_024);
    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(48 * 1_024);
    expect(bounded).toMatchObject({
      truncated: true,
      redactionCount: 1,
      backpressure: {
        droppedChunks: 1,
        droppedBytes: expect.any(Number),
      },
    });
    expect(bounded.omittedBytes).toBeGreaterThan(9 * 1_024 * 1_024);
    expect(bounded.text).not.toContain(secret);
    storage.appendEvent(run.id, {
      kind: 'command.output',
      stage: 'test',
      payload: {
        commandId: randomUUID(),
        attempt: 1,
        stream: 'combined',
        chunkIndex: 0,
        output: bounded,
      },
      provenance,
      artifactIds: [],
    });
    const log = await artifacts.save({
      runId: run.id,
      kind: 'log',
      name: 'noisy.log',
      mimeType: 'text/plain',
      data: noisy,
      provenance,
    });
    expect(log.bytes).toBeLessThanOrEqual(1 * 1_024 * 1_024);
    expect((await artifacts.read(log)).toString()).not.toContain(secret);
    const bufferedLog = await artifacts.save({
      runId: run.id,
      kind: 'log',
      name: 'buffered.log',
      mimeType: 'text/plain',
      data: Buffer.from(`buffered provider output ${secret}`),
      provenance,
    });
    expect((await artifacts.read(bufferedLog)).toString()).toBe(
      'buffered provider output [REDACTED]'
    );
    const secretNamedLog = await artifacts.save({
      runId: run.id,
      kind: 'log',
      name: `provider-${secret}.log`,
      mimeType: 'text/plain',
      data: 'safe body',
      provenance,
    });
    expect(secretNamedLog.name).not.toContain(secret);
    expect(secretNamedLog.path).not.toContain(secret);
    await expect(
      artifacts.save({
        runId: run.id,
        kind: 'screenshot',
        name: 'unsafe.png',
        mimeType: 'image/png',
        data: Buffer.from(`fake image bytes ${secret}`),
        provenance,
      })
    ).rejects.toThrow(/secret material/);

    closeStorage(storage);
    const persisted = await Promise.all([
      readFile(databasePath),
      readOptionalFile(`${databasePath}-wal`),
      readOptionalFile(`${databasePath}-shm`),
      readFile(log.path),
      readFile(bufferedLog.path),
    ]);
    for (const bytes of persisted) {
      expect(bytes.includes(Buffer.from(secret))).toBe(false);
      expect(bytes.includes(Buffer.from(basicPassword))).toBe(false);
    }
  });

  it('reconstructs the same current action after restart even when the projection cache is absent', async () => {
    const { storage, root, databasePath } = await createStorage();
    const project = storage.createProject({ name: 'Restart', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'resume' });
    const attempt = storage.beginStageAttempt(
      run.id,
      'verify',
      'Re-running the failed verification',
      provenance
    );
    storage.heartbeatStageAttempt(
      attempt.id,
      'Waiting for the fixture health check',
      'Target service has not reported ready',
      provenance
    );
    const beforeRestart = storage.getRunProjection(run.id);
    expect(beforeRestart).toMatchObject({
      status: 'running',
      stage: 'verify',
      activeStageAttemptId: attempt.id,
      currentAction: {
        kind: 'stage',
        id: attempt.id,
        status: 'waiting',
        summary: 'Waiting for the fixture health check',
      },
      waitingOn: {
        summary: 'Target service has not reported ready',
      },
    });
    closeStorage(storage);

    const raw = new Database(databasePath);
    raw.prepare('DELETE FROM run_projections WHERE run_id = ?').run(run.id);
    raw.close();
    const restarted = new QAgentStorage(databasePath);
    openStorage.push(restarted);
    expect(restarted.getRunProjection(run.id)).toEqual(beforeRestart);
    expect(restarted.listStageAttempts(run.id)).toEqual([
      expect.objectContaining({
        id: attempt.id,
        status: 'waiting',
        waitingOn: 'Target service has not reported ready',
      }),
    ]);
  });

  it('restores the active stage after a child command completes', async () => {
    const { storage, root, databasePath } = await createStorage();
    const project = storage.createProject({ name: 'Parent action', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const attempt = storage.beginStageAttempt(
      run.id,
      'verify',
      'Verifying the durable repair',
      provenance
    );
    const commandId = randomUUID();
    storage.appendEvent(run.id, {
      kind: 'command.started',
      stage: 'verify',
      payload: {
        commandId,
        attempt: attempt.attempt,
        executable: 'node',
        args: ['--test'],
      },
      provenance,
      artifactIds: [],
    });
    storage.appendEvent(run.id, {
      kind: 'command.completed',
      stage: 'verify',
      payload: {
        commandId,
        attempt: attempt.attempt,
        executable: 'node',
        args: ['--test'],
        exitCode: 0,
        durationMs: 40,
      },
      provenance,
      artifactIds: [],
    });
    const beforeRestart = storage.getRunProjection(run.id);
    expect(beforeRestart).toMatchObject({
      activeStageAttemptId: attempt.id,
      activeCommandId: null,
      currentAction: {
        kind: 'stage',
        id: attempt.id,
        status: 'running',
        summary: 'Continuing verify',
      },
    });
    closeStorage(storage);

    const raw = new Database(databasePath);
    raw.prepare('DELETE FROM run_projections WHERE run_id = ?').run(run.id);
    raw.close();
    const restarted = new QAgentStorage(databasePath);
    openStorage.push(restarted);
    expect(restarted.getRunProjection(run.id)).toEqual(beforeRestart);
  });

  it('projects target readiness, browser actions, and recovery without storing image blobs', async () => {
    const { storage, artifacts, root, databasePath } = await createStorage();
    const project = storage.createProject({
      name: 'Lifecycle projection',
      path: join(root, 'repo'),
    });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'desktop' });
    const stageAttempt = storage.beginStageAttempt(
      run.id,
      'verify',
      'Verify the browser fixture',
      provenance
    );
    const serviceId = randomUUID();
    const commandId = randomUUID();
    storage.appendEvent(run.id, {
      kind: 'target.service_started',
      stage: 'verify',
      payload: {
        serviceId,
        commandId,
        attempt: 1,
        executable: 'node',
        args: ['fixture.mjs'],
      },
      provenance,
      artifactIds: [],
    });
    expect(storage.getRunProjection(run.id)).toMatchObject({
      activeServiceId: serviceId,
      currentAction: { kind: 'target_service', status: 'waiting' },
      waitingOn: { kind: 'service_readiness' },
    });
    storage.appendEvent(run.id, {
      kind: 'target.service_ready',
      stage: 'verify',
      payload: {
        serviceId,
        attempt: 1,
        healthUrl: 'http://127.0.0.1:4173/health',
        statusCode: 200,
        durationMs: 35,
      },
      provenance,
      artifactIds: [],
    });
    const sessionId = randomUUID();
    storage.appendEvent(run.id, {
      kind: 'browser.session_started',
      stage: 'verify',
      payload: {
        sessionId,
        provider: 'local',
        browserName: 'Chromium',
        attempt: 1,
      },
      provenance,
      artifactIds: [],
    });
    const actionId = randomUUID();
    storage.appendEvent(run.id, {
      kind: 'browser.action_started',
      stage: 'verify',
      payload: {
        sessionId,
        actionId,
        flow: 'fixture-home',
        stepIndex: 0,
        attempt: 1,
        summary: 'Inspect the fixture heading',
      },
      provenance,
      artifactIds: [],
    });
    const screenshot = await artifacts.save({
      runId: run.id,
      kind: 'screenshot',
      name: 'checkpoint.png',
      mimeType: 'image/png',
      data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      provenance,
    });
    storage.appendEvent(run.id, {
      kind: 'browser.checkpoint',
      stage: 'verify',
      payload: {
        sessionId,
        checkpointId: randomUUID(),
        flow: 'fixture-home',
        url: 'http://127.0.0.1:4173/',
        title: 'Fixture',
        attempt: 1,
      },
      provenance,
      artifactIds: [screenshot.id],
    });
    storage.appendEvent(run.id, {
      kind: 'browser.session_closed',
      stage: 'verify',
      payload: {
        sessionId,
        attempt: 1,
        status: 'succeeded',
        durationMs: 80,
      },
      provenance,
      artifactIds: [screenshot.id],
    });
    expect(storage.getRunProjection(run.id)).toMatchObject({
      activeBrowserSessionId: null,
      activeServiceId: serviceId,
      currentAction: { kind: 'target_service', id: serviceId, status: 'running' },
    });
    storage.appendEvent(run.id, {
      kind: 'target.service_exited',
      stage: 'verify',
      payload: {
        serviceId,
        attempt: 1,
        exitCode: 0,
        signal: null,
        durationMs: 90,
        expected: true,
      },
      provenance,
      artifactIds: [],
    });
    expect(storage.getRunProjection(run.id)).toMatchObject({
      activeServiceId: null,
      currentAction: { kind: 'stage', id: stageAttempt.id, status: 'running' },
    });
    const recoveryId = randomUUID();
    storage.appendEvent(run.id, {
      kind: 'recovery.started',
      stage: 'verify',
      payload: {
        recoveryId,
        fromSequence: storage.listEvents(run.id).at(-1)!.sequence,
        previousStage: 'verify',
        previousStatus: 'running',
        attempt: 1,
      },
      provenance,
      artifactIds: [],
    });
    storage.appendEvent(run.id, {
      kind: 'recovery.completed',
      stage: 'verify',
      payload: {
        recoveryId,
        resumedSequence: storage.listEvents(run.id).at(-1)!.sequence,
        currentAction: 'Resume the durable verification stage',
        error: null,
      },
      provenance,
      artifactIds: [screenshot.id],
    });
    expect(storage.getRunProjection(run.id)).toMatchObject({
      recoveryState: 'resumed',
      currentAction: null,
    });
    const raw = new Database(databasePath, { readonly: true });
    const payload = raw
      .prepare(
        `SELECT payload_json FROM run_events
         WHERE run_id = ? AND kind = 'browser.checkpoint'`
      )
      .get(run.id) as { payload_json: string };
    expect(payload.payload_json).not.toContain('iVBOR');
    raw.close();
  });

  it('rejects lifecycle evidence that is missing, cross-run, or not file-backed', async () => {
    const { storage, artifacts, root, databasePath } = await createStorage();
    const project = storage.createProject({ name: 'Evidence integrity', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const otherRun = storage.createRun({ projectId: project.id, requestedBy: 'mcp' });
    const missingId = randomUUID();
    const checkpoint = (artifactIds: string[]) => ({
      kind: 'browser.checkpoint' as const,
      stage: 'verify' as const,
      payload: {
        sessionId: randomUUID(),
        checkpointId: randomUUID(),
        flow: 'evidence-integrity',
        url: 'http://127.0.0.1/',
        title: 'Fixture',
        attempt: 1,
      },
      provenance,
      artifactIds,
    });

    expect(() => storage.appendEvent(run.id, checkpoint([missingId]))).toThrow(/not ready for run/);
    const otherEvidence = await artifacts.save({
      runId: otherRun.id,
      kind: 'report',
      name: 'other-run.json',
      mimeType: 'application/json',
      data: '{"run":"other"}',
      provenance,
    });
    expect(() => storage.appendEvent(run.id, checkpoint([otherEvidence.id]))).toThrow(
      /not ready for run/
    );

    const raw = new Database(databasePath);
    const fakeId = randomUUID();
    raw
      .prepare(
        `INSERT INTO artifacts(
          id, run_id, kind, name, path, sha256, mime_type, bytes, provenance_json, created_at,
          state, ready_at, original_bytes, omitted_bytes, redaction_count
        ) VALUES (?, ?, 'report', 'missing.json', ?, ?, 'application/json', 2, ?, ?, 'ready', ?, 2, 0, 0)`
      )
      .run(
        fakeId,
        run.id,
        join(root, 'never-created.json'),
        '0'.repeat(64),
        JSON.stringify(provenance),
        timestamp,
        timestamp
      );
    raw.close();
    expect(() => storage.appendEvent(run.id, checkpoint([fakeId]))).toThrow(
      /not backed by a readable file/
    );
    expect(storage.listEvents(run.id)).toEqual([]);
  });
});

describe('truthful specialist protocol', () => {
  it('persists all five identities only when backed by a provider call and durable evidence', async () => {
    const { storage, artifacts, root } = await createStorage();
    const project = storage.createProject({ name: 'Specialists', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'desktop' });
    expect(storage.listSpecialistActivities(run.id)).toEqual([]);
    expect(storage.listSpecialistCritiques(run.id)).toEqual([]);
    expect(storage.listSpecialistDecisions(run.id)).toEqual([]);
    expect(storage.listEvents(run.id).some((event) => event.kind.startsWith('specialist.'))).toBe(
      false
    );

    const evidence = await artifacts.save({
      runId: run.id,
      kind: 'report',
      name: 'specialist-evidence.json',
      mimeType: 'application/json',
      data: '{"result":"grounded"}',
      provenance,
    });
    const roles: SpecialistRole[] = ['scout', 'trace', 'patch', 'proof', 'gate'];
    const activityIds = new Map<SpecialistRole, string>();
    const providerIds = new Map<SpecialistRole, string>();

    expect(() =>
      storage.recordPolicyWorkerCall({
        id: randomUUID(),
        runId: run.id,
        worker: 'qagent.specialist.proof',
        version: '1',
        attempt: 1,
        status: 'succeeded',
        inputDigest: 'a'.repeat(64),
        outputDigest: null,
        error: null,
        startedAt: timestamp,
        completedAt: null,
      })
    ).toThrow(/output digest|completion timestamp/);

    for (const role of roles) {
      const providerCallId = randomUUID();
      providerIds.set(role, providerCallId);
      const started = providerCall(run.id, providerCallId, role, 'started');
      storage.beginProviderCall(started, {
        kind: 'model.call_started',
        stage: specialistStage(role),
        payload: {
          providerCallId,
          provider: started.provider,
          model: started.model,
          purpose: started.purpose,
          attempt: 1,
          specialistRole: role,
        },
        provenance,
        artifactIds: [],
      });
      const completed = {
        ...started,
        status: 'succeeded' as const,
        completedAt: timestamp,
        durationMs: 25,
        evidenceIds: [evidence.id],
        responseDigest: 'd'.repeat(64),
      };
      storage.finishProviderCall(providerCallId, completed, {
        kind: 'model.call_completed',
        stage: specialistStage(role),
        payload: {
          providerCallId,
          durationMs: 25,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
        provenance,
        artifactIds: [evidence.id],
      });
      const activityId = randomUUID();
      activityIds.set(role, activityId);
      storage.recordSpecialistActivity(
        {
          id: activityId,
          runId: run.id,
          role,
          status: 'succeeded',
          summary: `${role} produced an evidence-backed result`,
          source: { kind: 'provider_call', providerCallId },
          occurredAt: timestamp,
          attempt: 1,
          evidenceIds: [evidence.id],
          handoffTarget: role === 'gate' ? null : roles[roles.indexOf(role) + 1]!,
        },
        specialistStage(role),
        provenance
      );
    }

    const activities = storage.listSpecialistActivities(run.id);
    expect(activities).toHaveLength(roles.length);
    expect(activities.map((activity) => activity.role)).toEqual(expect.arrayContaining(roles));
    const providerCalls = storage.listProviderCalls(run.id);
    expect(providerCalls).toHaveLength(roles.length);
    expect(providerCalls).toEqual(
      expect.arrayContaining(
        roles.map((role) =>
          expect.objectContaining({
            id: providerIds.get(role),
            status: 'succeeded',
            specialistRole: role,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            evidenceIds: [evidence.id],
          })
        )
      )
    );
    expect(() =>
      storage.recordSpecialistActivity(
        {
          id: randomUUID(),
          runId: run.id,
          role: 'proof',
          status: 'succeeded',
          summary: 'Unsupported proof',
          source: { kind: 'provider_call', providerCallId: randomUUID() },
          occurredAt: timestamp,
          attempt: 1,
          evidenceIds: [evidence.id],
          handoffTarget: null,
        },
        'verify',
        provenance
      )
    ).toThrow(/source does not belong/);
    expect(() =>
      storage.recordSpecialistActivity(
        {
          id: randomUUID(),
          runId: run.id,
          role: 'proof',
          status: 'succeeded',
          summary: 'Evidence-free proof',
          source: {
            kind: 'provider_call',
            providerCallId: providerIds.get('proof')!,
          },
          occurredAt: timestamp,
          attempt: 1,
          evidenceIds: [],
          handoffTarget: null,
        },
        'verify',
        provenance
      )
    ).toThrow(/durable evidence/);

    storage.recordSpecialistCritique(
      {
        id: randomUUID(),
        runId: run.id,
        activityId: activityIds.get('patch')!,
        role: 'gate',
        verdict: 'accepted',
        summary: 'The patch evidence covers the diagnosed failure.',
        source: {
          kind: 'provider_call',
          providerCallId: providerIds.get('gate')!,
        },
        occurredAt: timestamp,
        attempt: 1,
        evidenceIds: [evidence.id],
        actionRequired: null,
      },
      'verify',
      provenance
    );
    storage.recordSpecialistDecision(
      {
        id: randomUUID(),
        runId: run.id,
        role: 'gate',
        action: 'complete',
        summary: 'All required evidence is present.',
        source: {
          kind: 'provider_call',
          providerCallId: providerIds.get('gate')!,
        },
        occurredAt: timestamp,
        attempt: 1,
        evidenceIds: [evidence.id],
        handoffTarget: null,
      },
      'complete',
      provenance
    );
    expect(storage.listSpecialistCritiques(run.id)).toEqual([
      expect.objectContaining({
        role: 'gate',
        verdict: 'accepted',
        actionRequired: null,
        evidenceIds: [evidence.id],
      }),
    ]);
    expect(storage.listSpecialistDecisions(run.id)).toEqual([
      expect.objectContaining({
        role: 'gate',
        action: 'complete',
        evidenceIds: [evidence.id],
      }),
    ]);
  });

  it('does not let a legacy provider row substantiate new specialist activity', async () => {
    const { storage, artifacts, root } = await createStorage();
    const project = storage.createProject({ name: 'Legacy provider', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const evidence = await artifacts.save({
      runId: run.id,
      kind: 'report',
      name: 'proof.json',
      mimeType: 'application/json',
      data: '{"passed":true}',
      provenance,
    });
    const providerCallId = randomUUID();
    storage.recordProviderCall({
      ...providerCall(run.id, providerCallId, 'proof', 'succeeded'),
      completedAt: timestamp,
      durationMs: 1,
      evidenceIds: [evidence.id],
      responseDigest: 'e'.repeat(64),
    });

    expect(() =>
      storage.recordSpecialistActivity(
        {
          id: randomUUID(),
          runId: run.id,
          role: 'proof',
          status: 'succeeded',
          summary: 'A legacy provider row cannot substantiate new specialist work.',
          source: { kind: 'provider_call', providerCallId },
          occurredAt: timestamp,
          attempt: 1,
          evidenceIds: [evidence.id],
          handoffTarget: null,
        },
        'verify',
        provenance
      )
    ).toThrow(/lifecycle events/);
    expect(storage.listSpecialistActivities(run.id)).toEqual([]);
    expect(storage.listEvents(run.id).some((event) => event.kind === 'specialist.activity')).toBe(
      false
    );
  });
});

describe('checksummed run manifests', () => {
  it('atomically creates the manifest before terminal evidence and leaves the terminal event last', async () => {
    const { storage, artifacts, root, databasePath } = await createStorage();
    const project = storage.createProject({ name: 'Atomic terminal', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    storage.updateRun(run.id, { status: 'running', stage: 'verify' });
    const evidence = await artifacts.save({
      runId: run.id,
      kind: 'report',
      name: 'verification.json',
      mimeType: 'application/json',
      data: '{"passed":true}',
      provenance,
    });
    storage.appendEvent(run.id, {
      kind: 'trace.status',
      stage: 'verify',
      payload: { state: 'local' },
      provenance,
      artifactIds: [],
    });
    const beforeSequence = storage.listEvents(run.id).at(-1)!.sequence;
    const completedAt = new Date().toISOString();

    const finalized = await artifacts.finalizeRunManifest({
      runId: run.id,
      status: 'succeeded',
      stage: 'complete',
      completedAt,
      traceState: 'local',
      terminalEvidence: {
        id: randomUUID(),
        runId: run.id,
        outcome: 'succeeded',
        summary: 'The verification evidence passed.',
        evidenceAvailability: 'ready',
        artifactIds: [evidence.id],
        evidenceLinks: [
          {
            artifactId: evidence.id,
            label: 'verification.json',
            relationship: 'verifies',
          },
        ],
        evidenceUnavailableReason: null,
        verificationId: null,
        publication: null,
        createdAt: completedAt,
      },
      terminalEvent: {
        kind: 'run.completed',
        stage: 'complete',
        payload: { message: 'Verified repair completed' },
        provenance,
        artifactIds: [evidence.id],
      },
    });

    expect(finalized.run).toMatchObject({
      status: 'succeeded',
      stage: 'complete',
      summary: 'Verified repair completed',
      error: null,
      completedAt,
    });
    expect(finalized.manifest.outcome).toEqual({
      status: 'succeeded',
      stage: 'complete',
      summary: 'Verified repair completed',
      error: null,
      completedAt,
    });
    expect(finalized.terminalEvidence.artifactIds).toEqual(
      expect.arrayContaining([evidence.id, finalized.artifact.id])
    );
    expect(finalized.terminalEvidence.evidenceLinks).toContainEqual({
      artifactId: finalized.artifact.id,
      label: 'run-manifest.json',
      relationship: 'supports',
    });
    const terminalEvents = storage.listEvents(run.id, beforeSequence);
    expect(terminalEvents.map((event) => event.kind)).toEqual([
      'artifact.created',
      'run.manifest_created',
      'terminal.evidence',
      'run.completed',
    ]);
    expect(terminalEvents.map((event) => event.sequence)).toEqual([
      beforeSequence + 1,
      beforeSequence + 2,
      beforeSequence + 3,
      beforeSequence + 4,
    ]);
    expect(finalized.record.eventSequence).toBe(terminalEvents[1]!.sequence);
    expect(terminalEvents[2]).toMatchObject({
      kind: 'terminal.evidence',
      payload: {
        evidence: {
          artifactIds: expect.arrayContaining([finalized.artifact.id]),
        },
      },
    });
    expect(storage.listEvents(run.id).at(-1)?.kind).toBe('run.completed');
    const projection = storage.getRunProjection(run.id);
    expect(projection).toMatchObject({
      status: 'succeeded',
      stage: 'complete',
      lastEventSequence: beforeSequence + 4,
      currentAction: { kind: 'terminal', status: 'terminal' },
    });

    closeStorage(storage);
    const restarted = new QAgentStorage(databasePath);
    openStorage.push(restarted);
    expect(restarted.getRun(run.id)).toEqual(finalized.run);
    expect(restarted.getRunProjection(run.id)).toEqual(projection);
    expect(restarted.listEvents(run.id).at(-1)?.kind).toBe('run.completed');
    expect(restarted.getRunManifest(run.id)).toEqual(finalized.record);
  });

  it('rolls back terminal state and events when atomic manifest finalization cannot validate evidence', async () => {
    const { storage, artifacts, root } = await createStorage();
    const project = storage.createProject({ name: 'Atomic rollback', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    storage.updateRun(run.id, { status: 'running', stage: 'verify' });
    const completedAt = new Date().toISOString();

    await expect(
      artifacts.finalizeRunManifest({
        runId: run.id,
        status: 'failed',
        stage: 'verify',
        completedAt,
        traceState: 'local',
        terminalEvidence: {
          id: randomUUID(),
          runId: run.id,
          outcome: 'failed',
          summary: 'Evidence was not durable.',
          evidenceAvailability: 'ready',
          artifactIds: [randomUUID()],
          evidenceLinks: [],
          evidenceUnavailableReason: null,
          verificationId: null,
          publication: null,
          createdAt: completedAt,
        },
        terminalEvent: {
          kind: 'run.failed',
          stage: 'verify',
          payload: { message: 'Evidence validation failed' },
          provenance,
          artifactIds: [],
        },
      })
    ).rejects.toThrow(/not ready for run/);
    expect(storage.getRun(run.id)).toMatchObject({
      status: 'running',
      stage: 'verify',
      completedAt: null,
    });
    expect(storage.listEvents(run.id)).toEqual([]);
    expect(storage.listArtifacts(run.id)).toEqual([]);
    expect(storage.getRunManifest(run.id)).toBeNull();
  });

  it('captures durable commands, browser checks, attempts, provenance, outcome, and artifact hashes', async () => {
    const secret = 'manifest-secret-8cd3f52b';
    const { storage, artifacts, root } = await createStorage({
      secretValues: [secret],
      environment: {},
    });
    const project = storage.createProject({ name: 'Manifest', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    storage.updateRun(run.id, {
      status: 'running',
      stage: 'verify',
      branch: 'qagent/manifest',
      worktreePath: join(root, 'worktree'),
      baseSha: 'b'.repeat(40),
    });
    storage.upsertRunManifestContext({
      runId: run.id,
      configDigest: 'a'.repeat(64),
      configPath: join(root, '.qagent.yml'),
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
      branch: 'qagent/manifest',
      worktreePath: join(root, 'worktree'),
      commands: [
        {
          executable: 'node',
          args: ['--test'],
          cwd: join(root, 'worktree'),
          env: { QAGENT_TEST_TOKEN: secret },
          timeoutMs: 30_000,
        },
      ],
      browserChecks: [{ name: 'fixture-home', steps: ['Open the fixture'] }],
      updatedAt: timestamp,
    });

    const evidence = await artifacts.save({
      runId: run.id,
      kind: 'report',
      name: 'verification.json',
      mimeType: 'application/json',
      data: `{"verified":true,"token":"${secret}"}`,
      provenance,
    });
    const screenshot = await artifacts.save({
      runId: run.id,
      kind: 'screenshot',
      name: 'fixture-home.png',
      mimeType: 'image/png',
      data: new Uint8Array([137, 80, 78, 71]),
      provenance,
    });
    const stageAttempt = storage.beginStageAttempt(
      run.id,
      'verify',
      'Verify the repaired fixture',
      provenance
    );
    storage.completeStageAttempt(
      stageAttempt.id,
      'succeeded',
      'Verification passed',
      [evidence.id],
      provenance
    );
    const commandId = randomUUID();
    storage.appendEvent(run.id, {
      kind: 'command.started',
      stage: 'verify',
      payload: {
        commandId,
        attempt: 1,
        executable: 'node',
        args: ['--test'],
      },
      provenance,
      artifactIds: [],
    });
    storage.appendEvent(run.id, {
      kind: 'command.output',
      stage: 'verify',
      payload: {
        commandId,
        attempt: 1,
        stream: 'combined',
        chunkIndex: 0,
        output: storage.boundedOutput(`tests passed ${secret}`, 16 * 1_024),
      },
      provenance,
      artifactIds: [],
    });
    storage.appendEvent(run.id, {
      kind: 'command.completed',
      stage: 'verify',
      payload: {
        commandId,
        attempt: 1,
        executable: 'node',
        args: ['--test'],
        exitCode: 0,
        durationMs: 42,
      },
      provenance,
      artifactIds: [evidence.id],
    });
    const sessionId = randomUUID();
    storage.appendEvent(run.id, {
      kind: 'browser.checkpoint',
      stage: 'verify',
      payload: {
        sessionId,
        checkpointId: randomUUID(),
        flow: 'fixture-home',
        url: 'http://127.0.0.1:4173/',
        title: 'QAgent Fixture',
        attempt: 1,
      },
      provenance,
      artifactIds: [screenshot.id],
    });
    const providerCallId = randomUUID();
    const startedProviderCall = providerCall(run.id, providerCallId, 'proof', 'started');
    storage.beginProviderCall(startedProviderCall, {
      kind: 'model.call_started',
      stage: 'verify',
      payload: {
        providerCallId,
        provider: startedProviderCall.provider,
        model: startedProviderCall.model,
        purpose: startedProviderCall.purpose,
        attempt: 1,
        specialistRole: 'proof',
      },
      provenance,
      artifactIds: [],
    });
    storage.finishProviderCall(
      providerCallId,
      {
        ...startedProviderCall,
        status: 'succeeded',
        completedAt: timestamp,
        durationMs: 15,
        evidenceIds: [evidence.id],
        responseDigest: 'd'.repeat(64),
      },
      {
        kind: 'model.call_completed',
        stage: 'verify',
        payload: {
          providerCallId,
          durationMs: 15,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
        provenance,
        artifactIds: [evidence.id],
      }
    );
    const proofActivityId = randomUUID();
    storage.recordSpecialistActivity(
      {
        id: proofActivityId,
        runId: run.id,
        role: 'proof',
        status: 'succeeded',
        summary: 'Proof confirmed the command and browser evidence.',
        source: { kind: 'provider_call', providerCallId },
        occurredAt: timestamp,
        attempt: 1,
        evidenceIds: [evidence.id, screenshot.id],
        handoffTarget: 'gate',
      },
      'verify',
      provenance
    );
    const gateInvocationId = randomUUID();
    const gateSource = {
      kind: 'policy_worker' as const,
      worker: 'qagent.specialist.gate',
      invocationId: gateInvocationId,
    };
    storage.recordPolicyWorkerCall({
      id: gateInvocationId,
      runId: run.id,
      worker: gateSource.worker,
      version: '1',
      attempt: 1,
      status: 'succeeded',
      inputDigest: 'e'.repeat(64),
      outputDigest: 'f'.repeat(64),
      error: null,
      startedAt: timestamp,
      completedAt: timestamp,
    });
    storage.recordSpecialistActivity(
      {
        id: randomUUID(),
        runId: run.id,
        role: 'gate',
        status: 'succeeded',
        summary: 'Gate accepted the durable proof evidence.',
        source: gateSource,
        occurredAt: timestamp,
        attempt: 1,
        evidenceIds: [evidence.id, screenshot.id],
        handoffTarget: null,
      },
      'verify',
      provenance
    );
    storage.recordSpecialistCritique(
      {
        id: randomUUID(),
        runId: run.id,
        activityId: proofActivityId,
        role: 'gate',
        verdict: 'accepted',
        summary: 'The configured command and browser checkpoint both passed.',
        source: gateSource,
        occurredAt: timestamp,
        attempt: 1,
        evidenceIds: [evidence.id, screenshot.id],
        actionRequired: null,
      },
      'verify',
      provenance
    );
    storage.recordSpecialistDecision(
      {
        id: randomUUID(),
        runId: run.id,
        role: 'gate',
        action: 'complete',
        summary: 'The evidence satisfies the terminal gate.',
        source: gateSource,
        occurredAt: timestamp,
        attempt: 1,
        evidenceIds: [evidence.id, screenshot.id],
        handoffTarget: null,
      },
      'verify',
      provenance
    );
    const traceEvent = storage.appendEvent(run.id, {
      kind: 'trace.status',
      stage: 'verify',
      payload: { state: 'local' },
      provenance: {
        source: 'local',
        provider: 'QAgent trace',
        capturedAt: timestamp,
      },
      artifactIds: [],
    });

    await expect(
      artifacts.saveRunManifest({
        runId: run.id,
        status: 'succeeded',
        stage: 'complete',
        summary: 'Verified repair completed',
        error: null,
        completedAt: timestamp,
        traceState: 'local',
      })
    ).rejects.toThrow(/durable terminal run/);
    const settled = storage.settleRunOnce(run.id, 'succeeded', {
      kind: 'run.completed',
      stage: 'complete',
      payload: { message: 'Verified repair completed' },
      provenance,
      artifactIds: [],
    });
    await expect(
      artifacts.saveRunManifest({
        runId: run.id,
        status: settled.run.status,
        stage: settled.run.stage,
        summary: settled.run.summary,
        error: settled.run.error,
        completedAt: settled.run.completedAt,
        traceState: 'synced',
        traceProvider: 'claimed-provider',
      })
    ).rejects.toThrow(/trace state/);
    const saved = await artifacts.saveRunManifest({
      runId: run.id,
      status: settled.run.status,
      stage: settled.run.stage,
      summary: settled.run.summary,
      error: settled.run.error,
      completedAt: settled.run.completedAt,
      traceState: 'local',
      traceProvider: 'QAgent trace',
    });
    const bytes = await artifacts.read(saved.artifact);
    const { checksum, ...payload } = saved.manifest;

    expect(checksum).toBe(sha256(canonicalJson(payload)));
    expect(saved.record).toMatchObject({
      runId: run.id,
      artifactId: saved.artifact.id,
      sha256: sha256(bytes),
      eventSequence: expect.any(Number),
    });
    expect(saved.manifest).toMatchObject({
      config: { sha256: 'a'.repeat(64), sourcePath: join(root, '.qagent.yml') },
      repository: {
        baseSha: 'b'.repeat(40),
        headSha: 'c'.repeat(40),
        branch: 'qagent/manifest',
        worktreePath: join(root, 'worktree'),
      },
      commands: [
        expect.objectContaining({
          commandId,
          status: 'succeeded',
          exitCode: 0,
          durationMs: 42,
          envKeys: ['QAGENT_TEST_TOKEN'],
          evidenceIds: [evidence.id],
        }),
      ],
      browserChecks: [
        expect.objectContaining({
          flow: 'fixture-home',
          status: 'succeeded',
          sessionId,
          evidenceIds: [screenshot.id],
        }),
      ],
      stageAttempts: [
        expect.objectContaining({
          id: stageAttempt.id,
          status: 'succeeded',
          evidenceIds: [evidence.id],
        }),
      ],
      providerCalls: [
        expect.objectContaining({
          id: providerCallId,
          provider: 'openai',
          model: 'gpt-5-mini',
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          specialistRole: 'proof',
        }),
      ],
      policyWorkerCalls: [
        expect.objectContaining({
          id: gateInvocationId,
          worker: 'qagent.specialist.gate',
          status: 'succeeded',
          inputDigest: 'e'.repeat(64),
          outputDigest: 'f'.repeat(64),
        }),
      ],
      specialistActivities: expect.arrayContaining([
        expect.objectContaining({
          role: 'proof',
          source: { kind: 'provider_call', providerCallId },
          evidenceIds: [evidence.id, screenshot.id],
        }),
        expect.objectContaining({
          role: 'gate',
          source: gateSource,
          evidenceIds: [evidence.id, screenshot.id],
        }),
      ]),
      specialistCritiques: [
        expect.objectContaining({
          activityId: proofActivityId,
          role: 'gate',
          verdict: 'accepted',
          source: gateSource,
        }),
      ],
      specialistDecisions: [
        expect.objectContaining({
          role: 'gate',
          action: 'complete',
          source: gateSource,
        }),
      ],
      outcome: {
        status: 'succeeded',
        stage: 'complete',
        summary: 'Verified repair completed',
        error: null,
        completedAt: settled.run.completedAt,
      },
      trace: {
        state: 'local',
        provider: 'QAgent trace',
        updatedAt: traceEvent.occurredAt,
        atManifest: true,
      },
      manifestArtifactExcluded: true,
    });
    expect(saved.manifest.artifacts.map((artifact) => artifact.id)).toEqual(
      expect.arrayContaining([evidence.id, screenshot.id])
    );
    expect(saved.manifest.artifacts).toHaveLength(2);
    expect(saved.manifest.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: evidence.id, sha256: evidence.sha256 }),
        expect.objectContaining({ id: screenshot.id, sha256: screenshot.sha256 }),
      ])
    );
    expect(JSON.stringify(saved.manifest)).not.toContain(secret);
    expect(saved.manifest.redaction).toMatchObject({
      applied: true,
      replacementCount: expect.any(Number),
    });
    expect(saved.manifest.redaction.replacementCount).toBeGreaterThan(0);
    expect(storage.getRunManifest(run.id)).toEqual(saved.record);
    await expect(
      artifacts.save({
        runId: run.id,
        kind: 'log',
        name: 'late.log',
        mimeType: 'text/plain',
        data: 'This evidence arrived after finalization.',
        provenance,
      })
    ).rejects.toThrow(/finalized by its manifest/);
    expect(storage.listArtifacts(run.id).some((artifact) => artifact.name === 'late.log')).toBe(
      false
    );
    expect(() =>
      storage.recordProviderCall({
        ...providerCall(run.id, randomUUID(), 'trace', 'succeeded'),
        responseDigest: '9'.repeat(64),
      })
    ).toThrow(/finalized by its manifest/);
    expect(
      (
        await artifacts.saveRunManifest({
          runId: run.id,
          status: settled.run.status,
          stage: settled.run.stage,
          summary: settled.run.summary,
          error: settled.run.error,
          completedAt: settled.run.completedAt,
          traceState: 'synced',
        })
      ).record
    ).toEqual(saved.record);
  });

  it('commits one manifest when separate SQLite connections race', async () => {
    const { storage, artifacts, root, databasePath } = await createStorage();
    const project = storage.createProject({ name: 'Manifest race', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    const settled = storage.settleRunOnce(run.id, 'succeeded', {
      kind: 'run.completed',
      stage: 'complete',
      payload: { message: 'The durable run completed' },
      provenance,
      artifactIds: [],
    });
    const otherStorage = new QAgentStorage(databasePath);
    openStorage.push(otherStorage);
    const otherArtifacts = new ArtifactStore(join(root, 'artifacts'), otherStorage);
    const input = {
      runId: run.id,
      status: settled.run.status,
      stage: settled.run.stage,
      summary: settled.run.summary,
      error: settled.run.error,
      completedAt: settled.run.completedAt,
      traceState: 'local' as const,
    };

    const [first, second] = await Promise.all([
      artifacts.saveRunManifest(input),
      otherArtifacts.saveRunManifest(input),
    ]);

    expect(first.record).toEqual(second.record);
    expect(
      storage.listArtifacts(run.id).filter((artifact) => artifact.kind === 'manifest')
    ).toEqual([expect.objectContaining({ id: first.artifact.id, sha256: first.artifact.sha256 })]);
    expect(
      storage.listEvents(run.id).filter((event) => event.kind === 'run.manifest_created')
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          artifactId: first.artifact.id,
          sha256: first.artifact.sha256,
        }),
      }),
    ]);
  });

  it('atomically terminalizes only once when separate SQLite connections race', async () => {
    const { storage, artifacts, root, databasePath } = await createStorage();
    const project = storage.createProject({ name: 'Terminal race', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    storage.updateRun(run.id, { status: 'running', stage: 'verify' });
    const otherStorage = new QAgentStorage(databasePath);
    openStorage.push(otherStorage);
    const otherArtifacts = new ArtifactStore(join(root, 'artifacts'), otherStorage);
    const completedAt = new Date().toISOString();
    const input = {
      runId: run.id,
      status: 'succeeded' as const,
      stage: 'complete' as const,
      completedAt,
      traceState: 'local' as const,
      terminalEvidence: {
        id: randomUUID(),
        runId: run.id,
        outcome: 'succeeded' as const,
        summary: 'The concurrent finalizer produced a durable manifest.',
        evidenceAvailability: 'unavailable' as const,
        artifactIds: [],
        evidenceLinks: [],
        evidenceUnavailableReason: 'No earlier evidence artifact was produced.',
        verificationId: null,
        publication: null,
        createdAt: completedAt,
      },
      terminalEvent: {
        kind: 'run.completed' as const,
        stage: 'complete' as const,
        payload: { message: 'Concurrent terminal run completed' },
        provenance,
        artifactIds: [],
      },
    };

    const [first, second] = await Promise.all([
      artifacts.finalizeRunManifest(input),
      otherArtifacts.finalizeRunManifest(input),
    ]);

    expect(first.record).toEqual(second.record);
    expect(first.run).toEqual(second.run);
    expect(first.terminalEvidence).toEqual(second.terminalEvidence);
    expect(
      storage.listArtifacts(run.id).filter((artifact) => artifact.kind === 'manifest')
    ).toEqual([expect.objectContaining({ id: first.artifact.id })]);
    expect(storage.listEvents(run.id).map((event) => event.kind)).toEqual([
      'artifact.created',
      'run.manifest_created',
      'terminal.evidence',
      'run.completed',
    ]);
    expect(storage.listEvents(run.id).at(-1)?.kind).toBe('run.completed');
  });

  it('does not fail a manifest at the former 1,024 lifecycle-row boundary', async () => {
    const { storage, artifacts, root } = await createStorage();
    const project = storage.createProject({ name: 'Large manifest', path: join(root, 'repo') });
    const run = storage.createRun({ projectId: project.id, requestedBy: 'cli' });
    for (let index = 0; index < 1_025; index += 1) {
      storage.recordProviderCall({
        ...providerCall(run.id, randomUUID(), 'trace', 'succeeded'),
        model: `fixture-model-${index}`,
        responseDigest: createHash('sha256').update(`response-${index}`).digest('hex'),
      });
    }
    const settled = storage.settleRunOnce(run.id, 'succeeded', {
      kind: 'run.completed',
      stage: 'complete',
      payload: { message: 'Large manifest completed' },
      provenance,
      artifactIds: [],
    });

    const saved = await artifacts.saveRunManifest({
      runId: run.id,
      status: settled.run.status,
      stage: settled.run.stage,
      summary: settled.run.summary,
      error: settled.run.error,
      completedAt: settled.run.completedAt,
      traceState: 'local',
    });

    expect(saved.manifest.providerCalls).toHaveLength(1_025);
    expect(saved.artifact.bytes).toBeLessThanOrEqual(5 * 1_024 * 1_024);
  });
});

function providerCall(
  runId: string,
  id: string,
  role: SpecialistRole,
  status: ProviderCall['status']
): ProviderCall {
  return {
    id,
    runId,
    provider: 'openai',
    model: 'gpt-5-mini',
    purpose: role === 'patch' ? 'patch' : 'triage',
    status,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    error: null,
    createdAt: timestamp,
    attempt: 1,
    startedAt: timestamp,
    completedAt: status === 'started' ? null : timestamp,
    durationMs: status === 'started' ? null : 25,
    specialistRole: role,
    evidenceIds: [],
    requestDigest: 'c'.repeat(64),
    responseDigest: null,
    errorCode: null,
  };
}

function specialistStage(role: SpecialistRole) {
  switch (role) {
    case 'scout':
      return 'discover' as const;
    case 'trace':
      return 'triage' as const;
    case 'patch':
      return 'patch' as const;
    case 'proof':
      return 'verify' as const;
    case 'gate':
      return 'complete' as const;
  }
}

async function createStorage(options: ConstructorParameters<typeof QAgentStorage>[1] = {}) {
  const root = await temporaryDirectory('qagent-storage-observability-');
  const databasePath = join(root, 'qagent.sqlite');
  const storage = new QAgentStorage(databasePath, options);
  openStorage.push(storage);
  return {
    root,
    databasePath,
    storage,
    artifacts: new ArtifactStore(join(root, 'artifacts'), storage),
  };
}

function closeStorage(storage: QAgentStorage): void {
  storage.close();
  const index = openStorage.indexOf(storage);
  if (index >= 0) openStorage.splice(index, 1);
}

async function readOptionalFile(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    return Buffer.alloc(0);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)])
    );
  }
  return value;
}
