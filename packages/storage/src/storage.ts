import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Artifact,
  BoundedOutput,
  Diagnosis,
  Integration,
  KnowledgeEntry,
  Patch,
  PolicyWorkerCall,
  Project,
  Provenance,
  ProviderCall,
  ReplayEventsRequest,
  Run,
  RunEvent,
  RunEventReplayPage,
  RunEventKind,
  RunManifestContext,
  RunManifestRecord,
  RunProjection,
  RunStage,
  RunStatus,
  SpecialistActivity,
  SpecialistCritique,
  SpecialistDecision,
  SpecialistHandoff,
  SpecialistObjection,
  StageAttempt,
  TerminalEvidence,
  TestCase,
  Verification,
} from '@qagent/contracts';
import {
  ArtifactSchema,
  DiagnosisSchema,
  IntegrationSchema,
  KnowledgeEntrySchema,
  PatchSchema,
  PolicyWorkerCallSchema,
  ProjectSchema,
  ProviderCallSchema,
  ReplayEventsRequestSchema,
  RunEventSchema,
  RunManifestContextSchema,
  RunManifestRecordSchema,
  RunCheckpointRecordSchema,
  RunProjectionSchema,
  RunSchema,
  SpecialistActivitySchema,
  SpecialistCritiqueSchema,
  SpecialistDecisionSchema,
  SpecialistHandoffSchema,
  SpecialistObjectionSchema,
  StageAttemptSchema,
  TerminalEvidenceSchema,
  TestCaseSchema,
  VerificationSchema,
} from '@qagent/contracts';
import Database from 'better-sqlite3';
import { and, desc, eq, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { runMigrations } from './migrations.js';
import {
  PersistenceRedactor,
  serializedBytes,
  type PersistenceRedactorOptions,
} from './persistence.js';
import * as schema from './schema.js';

export type NewRunEvent = {
  [K in RunEventKind]: Omit<
    Extract<RunEvent, { kind: K }>,
    'id' | 'runId' | 'schemaVersion' | 'sequence' | 'occurredAt'
  >;
}[RunEventKind];

export type TerminalRunStatus = Extract<
  RunStatus,
  'succeeded' | 'failed' | 'cancelled' | 'policy_blocked'
>;
export type TerminalRunEvent = Extract<
  NewRunEvent,
  {
    kind: 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.policy_blocked';
  }
>;

export interface SettleRunResult {
  run: Run;
  event: RunEvent | null;
  changed: boolean;
}

export interface TerminalRunDisposition {
  availableActions: Run['availableActions'];
  failureCode: Run['failureCode'];
}

export interface AppliedPatchInspection {
  files: string[];
  highRisk: boolean;
}

export interface CreateProjectInput {
  name: string;
  path: string;
  trusted?: boolean;
  configPath?: string | null;
}

export interface RunUpdate {
  status?: RunStatus;
  stage?: RunStage;
  branch?: string | null;
  worktreePath?: string | null;
  baseSha?: string | null;
  summary?: string | null;
  error?: string | null;
  cancelRequestedAt?: string | null;
  attempt?: Run['attempt'];
  retryOfRunId?: Run['retryOfRunId'];
  availableActions?: Run['availableActions'];
  intervention?: Run['intervention'];
  lastHeartbeatAt?: Run['lastHeartbeatAt'];
  recoveryCount?: Run['recoveryCount'];
  failureCode?: Run['failureCode'];
  completedAt?: string | null;
}

export type QAgentStorageOptions = PersistenceRedactorOptions;

export interface ArtifactPersistence {
  originalBytes: number;
  omittedBytes: number;
  redactionCount: number;
}

export interface CommitRunManifestArtifactResult {
  artifact: Artifact;
  record: RunManifestRecord;
  created: boolean;
}

export interface FinalizeRunManifestArtifactInput {
  status: TerminalRunStatus;
  completedAt: string;
  terminalEvidence: TerminalEvidence;
  terminalEvent: TerminalRunEvent;
  disposition: TerminalRunDisposition;
  expectation: {
    lastEventSequence: number;
    contextUpdatedAt: string | null;
    run: Pick<
      Run,
      | 'status'
      | 'stage'
      | 'summary'
      | 'error'
      | 'completedAt'
      | 'baseSha'
      | 'branch'
      | 'worktreePath'
      | 'updatedAt'
    >;
  };
}

export interface FinalizeRunManifestArtifactResult extends CommitRunManifestArtifactResult {
  run: Run;
  terminalEvidence: TerminalEvidence;
  events: RunEvent[];
}

export interface RunManifestCommitExpectation {
  lastEventSequence: number;
  outcome: Pick<Run, 'status' | 'stage' | 'summary' | 'error' | 'completedAt'>;
}

export interface RunManifestSnapshot {
  run: Run;
  context: RunManifestContext | null;
  events: RunEvent[];
  artifacts: Artifact[];
  stageAttempts: StageAttempt[];
  providerCalls: ProviderCall[];
  policyWorkerCalls: PolicyWorkerCall[];
  specialistActivities: SpecialistActivity[];
  specialistCritiques: SpecialistCritique[];
  specialistDecisions: SpecialistDecision[];
}

export interface CommitRunEventInput {
  runId: string;
  event: NewRunEvent;
  runUpdate?: RunUpdate;
  idempotencyKey?: string;
}

type ModelStartedEvent = Extract<NewRunEvent, { kind: 'model.call_started' }>;
type ModelTerminalEvent = Extract<
  NewRunEvent,
  { kind: 'model.call_completed' | 'model.call_failed' | 'model.call_cancelled' }
>;

export interface RunCheckpointPayloads {
  worktree_created: { worktreePath: string; branch: string; baseSha: string };
  patch_applied: { patchId: string; artifactId: string };
  verification_passed: { verificationId: string };
  commit_created: { commitSha: string };
  branch_pushed: { branch: string; commitSha: string };
  pull_request_created: { number: number; url: string; headSha: string };
  merge_observed: { number: number; mergeCommitSha: string };
  postverify_passed: { mergeCommitSha: string };
}

export type RunCheckpointKind = keyof RunCheckpointPayloads;
export type RunCheckpoint<K extends RunCheckpointKind = RunCheckpointKind> = {
  [P in K]: {
    runId: string;
    kind: P;
    data: RunCheckpointPayloads[P];
    updatedAt: string;
  };
}[K];

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function jsonContainsString(serialized: string, expected: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return false;
  }
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === expected) return true;
    if (Array.isArray(candidate)) {
      pending.push(...candidate);
    } else if (candidate && typeof candidate === 'object') {
      pending.push(...Object.values(candidate));
    }
  }
  return false;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function now(): string {
  return new Date().toISOString();
}

const TERMINAL_EVENT_KINDS = new Set<RunEventKind>([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.policy_blocked',
]);
const VALIDATED_LIFECYCLE_EVENT_KINDS = new Set<RunEventKind>([
  'artifact.created',
  'model.call_started',
  'model.call_completed',
  'model.call_failed',
  'model.call_cancelled',
  'specialist.activity',
  'specialist.critique',
  'specialist.decision',
  'specialist.objection',
  'specialist.handoff',
  'run.manifest_created',
]);
const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'policy_blocked',
]);

const TERMINAL_EVENT_BY_STATUS: Record<TerminalRunStatus, TerminalRunEvent['kind']> = {
  succeeded: 'run.completed',
  failed: 'run.failed',
  cancelled: 'run.cancelled',
  policy_blocked: 'run.policy_blocked',
};

function parseRunRow(row: typeof schema.runs.$inferSelect): Run {
  const { availableActionsJson, interventionJson, ...record } = row;
  return RunSchema.parse({
    ...record,
    availableActions: parseJson(availableActionsJson),
    intervention: interventionJson ? parseJson(interventionJson) : null,
  });
}

function runValues(run: Run): typeof schema.runs.$inferInsert {
  const { availableActions, intervention, ...record } = run;
  return {
    ...record,
    availableActionsJson: JSON.stringify(availableActions),
    interventionJson: intervention ? JSON.stringify(intervention) : null,
  };
}

function parsePatchRow(row: Record<string, unknown>): Patch {
  return PatchSchema.parse({
    id: row.id,
    runId: row.run_id,
    diagnosisId: row.diagnosis_id,
    artifactId: row.artifact_id,
    summary: row.summary,
    files: parseJson(String(row.files_json)),
    risk: row.risk,
    applied: Number(row.applied) === 1,
    createdAt: row.created_at,
  });
}

export class QAgentStorage {
  private readonly database: Database.Database;
  private readonly db: ReturnType<typeof drizzle<typeof schema>>;
  private readonly redactor: PersistenceRedactor;
  private readonly eventListeners = new Set<(event: RunEvent) => void>();

  constructor(
    readonly databasePath: string,
    options: QAgentStorageOptions = {}
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.redactor = new PersistenceRedactor(options);
    this.database = new Database(databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('busy_timeout = 5000');
    runMigrations(this.database);
    this.db = drizzle(this.database, { schema });
  }

  close(): void {
    this.eventListeners.clear();
    this.database.close();
  }

  subscribeEvents(listener: (event: RunEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  redactText(value: string): string {
    return this.redactor.redactText(value).text;
  }

  sanitizeForPersistence<T>(value: T): T {
    return this.redactor.redactValue(value);
  }

  sanitizeForPersistenceWithCount<T>(value: T): {
    value: T;
    replacementCount: number;
  } {
    return this.redactor.redactValueWithCount(value);
  }

  registerSecrets(values: Iterable<string | undefined | null>): void {
    this.redactor.registerSecrets(values);
  }

  boundedOutput(value: string, limitBytes?: number): BoundedOutput {
    return this.redactor.boundedOutput(value, limitBytes);
  }

  assertBinarySafe(value: Uint8Array): void {
    this.redactor.assertBinarySafe(value);
  }

  createProject(input: CreateProjectInput): Project {
    const timestamp = now();
    const project: Project = {
      id: randomUUID(),
      name: this.redactor.redactText(input.name).text,
      path: input.path,
      trusted: input.trusted ?? false,
      configPath: input.configPath ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.insert(schema.projects).values(project).run();
    return ProjectSchema.parse(project);
  }

  getProject(projectId: string): Project | null {
    const row = this.db.query.projects
      .findFirst({ where: eq(schema.projects.id, projectId) })
      .sync();
    return row ? ProjectSchema.parse(row) : null;
  }

  getProjectByPath(path: string): Project | null {
    const row = this.db.query.projects.findFirst({ where: eq(schema.projects.path, path) }).sync();
    return row ? ProjectSchema.parse(row) : null;
  }

  listProjects(): Project[] {
    return this.db
      .select()
      .from(schema.projects)
      .orderBy(desc(schema.projects.updatedAt))
      .all()
      .map((row) => ProjectSchema.parse(row));
  }

  setProjectTrust(projectId: string, trusted: boolean): Project {
    this.db
      .update(schema.projects)
      .set({ trusted, updatedAt: now() })
      .where(eq(schema.projects.id, projectId))
      .run();
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} was not found`);
    return project;
  }

  setProjectConfigPath(projectId: string, configPath: string): Project {
    this.db
      .update(schema.projects)
      .set({ configPath, updatedAt: now() })
      .where(eq(schema.projects.id, projectId))
      .run();
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} was not found`);
    return project;
  }

  createRun(
    input: Pick<Run, 'projectId' | 'requestedBy'> & Partial<Pick<Run, 'attempt' | 'retryOfRunId'>>
  ): Run {
    const timestamp = now();
    const run: Run = {
      id: randomUUID(),
      projectId: input.projectId,
      status: 'queued',
      stage: 'preflight',
      requestedBy: input.requestedBy,
      branch: null,
      worktreePath: null,
      baseSha: null,
      summary: null,
      error: null,
      cancelRequestedAt: null,
      attempt: input.attempt ?? 1,
      retryOfRunId: input.retryOfRunId ?? null,
      availableActions: ['cancel'],
      intervention: null,
      lastHeartbeatAt: null,
      recoveryCount: 0,
      failureCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };
    this.db.insert(schema.runs).values(runValues(run)).run();
    return RunSchema.parse(run);
  }

  getRun(runId: string): Run | null {
    const row = this.db.query.runs.findFirst({ where: eq(schema.runs.id, runId) }).sync();
    return row ? parseRunRow(row) : null;
  }

  listRuns(projectId?: string): Run[] {
    const rows = projectId
      ? this.db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.projectId, projectId))
          .orderBy(desc(schema.runs.createdAt))
          .all()
      : this.db.select().from(schema.runs).orderBy(desc(schema.runs.createdAt)).all();
    return rows.map(parseRunRow);
  }

  listInterruptedRuns(): Run[] {
    return this.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.status, 'running'))
      .all()
      .map(parseRunRow);
  }

  updateRun(runId: string, update: RunUpdate): Run {
    const sanitized: RunUpdate = {
      ...update,
      summary: update.summary === undefined ? undefined : this.redactNullable(update.summary),
      error: update.error === undefined ? undefined : this.redactNullable(update.error),
      intervention:
        update.intervention === undefined
          ? undefined
          : this.redactor.redactValue(update.intervention),
    };
    const { availableActions, intervention, ...record } = sanitized;
    const values: Partial<typeof schema.runs.$inferInsert> = {
      ...record,
      updatedAt: now(),
    };
    if (availableActions !== undefined) {
      values.availableActionsJson = JSON.stringify(availableActions);
    }
    if (intervention !== undefined) {
      values.interventionJson = intervention ? JSON.stringify(intervention) : null;
    }
    this.db.update(schema.runs).set(values).where(eq(schema.runs.id, runId)).run();
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found`);
    return run;
  }

  requestRunCancellation(runId: string): Run {
    return this.updateRun(runId, { cancelRequestedAt: now() });
  }

  saveRunCheckpoint<K extends RunCheckpointKind>(
    runId: string,
    kind: K,
    data: RunCheckpointPayloads[K]
  ): RunCheckpoint<K> {
    const updatedAt = now();
    const sanitized = this.redactor.redactValue(data);
    const parsed = RunCheckpointRecordSchema.parse({
      runId,
      kind,
      data: sanitized,
      updatedAt,
    }) as RunCheckpoint<K>;
    if (serializedBytes(parsed.data) > 64 * 1_024) {
      throw new Error('Run checkpoint exceeds the 64 KiB persistence limit');
    }
    this.db
      .insert(schema.runCheckpoints)
      .values({ runId, kind, dataJson: JSON.stringify(parsed.data), updatedAt })
      .onConflictDoUpdate({
        target: schema.runCheckpoints.runId,
        set: { kind, dataJson: JSON.stringify(parsed.data), updatedAt },
      })
      .run();
    return parsed;
  }

  getRunCheckpoint(runId: string): RunCheckpoint | null {
    const row = this.db.query.runCheckpoints
      .findFirst({ where: eq(schema.runCheckpoints.runId, runId) })
      .sync();
    return row
      ? (RunCheckpointRecordSchema.parse({
          runId: row.runId,
          kind: row.kind,
          data: parseJson(row.dataJson),
          updatedAt: row.updatedAt,
        }) as RunCheckpoint)
      : null;
  }

  clearRunCheckpoint(runId: string): void {
    this.db.delete(schema.runCheckpoints).where(eq(schema.runCheckpoints.runId, runId)).run();
  }

  appendEvent(runId: string, event: NewRunEvent, idempotencyKey?: string): RunEvent {
    const result = this.database
      .transaction(() => this.appendEventRecord(runId, event, idempotencyKey))
      .immediate();
    if (result.created) this.notifyEvent(result.event);
    return result.event;
  }

  commitRunEvent(input: CommitRunEventInput): { run: Run; event: RunEvent } {
    const result = this.database
      .transaction(() => {
        if (input.idempotencyKey) {
          const existingEvent = this.findEventByIdempotencyKey(input.runId, input.idempotencyKey);
          if (existingEvent) {
            const existingRun = this.getRun(input.runId);
            if (!existingRun) throw new Error(`Run ${input.runId} was not found`);
            return { run: existingRun, event: existingEvent, created: false };
          }
        }
        if (input.runUpdate) this.updateRunRecord(input.runId, input.runUpdate);
        const appended = this.appendEventRecord(input.runId, input.event, input.idempotencyKey);
        const run = this.getRun(input.runId);
        if (!run) throw new Error(`Run ${input.runId} was not found`);
        return { run, ...appended };
      })
      .immediate();
    if (result.created) this.notifyEvent(result.event);
    return { run: result.run, event: result.event };
  }

  settleRunOnce(
    runId: string,
    status: TerminalRunStatus,
    event: TerminalRunEvent,
    disposition: TerminalRunDisposition = {
      availableActions: status === 'succeeded' ? [] : ['retry'],
      failureCode: status === 'failed' || status === 'policy_blocked' ? 'unexpected_failure' : null,
    }
  ): SettleRunResult {
    const result = this.database
      .transaction(() => {
        const existing = this.getRun(runId);
        if (!existing) throw new Error(`Run ${runId} was not found`);
        if (TERMINAL_RUN_STATUSES.has(existing.status)) {
          const terminalEvent =
            this.listEvents(runId).findLast((item) => TERMINAL_EVENT_KINDS.has(item.kind)) ?? null;
          return { run: existing, event: terminalEvent, changed: false };
        }

        const expectedKind = TERMINAL_EVENT_BY_STATUS[status];
        if (event.kind !== expectedKind) {
          throw new Error(`Terminal status ${status} requires event ${expectedKind}`);
        }

        const completedAt = now();
        const safeMessage = this.redactor.boundedOutput(event.payload.message, 4_096).text;
        const update = this.database
          .prepare(
            `UPDATE runs
             SET status = ?,
                 stage = ?,
                 summary = ?,
                 error = ?,
                 available_actions_json = ?,
                 intervention_json = NULL,
                 failure_code = ?,
                 last_heartbeat_at = ?,
                 completed_at = ?,
                 updated_at = ?
             WHERE id = ?
               AND status IN ('queued', 'running', 'interrupted', 'waiting_for_intervention')`
          )
          .run(
            status,
            event.stage,
            status === 'succeeded' ? safeMessage : existing.summary,
            status === 'succeeded' ? null : safeMessage,
            JSON.stringify(disposition.availableActions),
            disposition.failureCode,
            completedAt,
            completedAt,
            completedAt,
            runId
          );
        if (update.changes !== 1) {
          const current = this.getRun(runId);
          if (!current) throw new Error(`Run ${runId} was not found`);
          const terminalEvent =
            this.listEvents(runId).findLast((item) => TERMINAL_EVENT_KINDS.has(item.kind)) ?? null;
          return { run: current, event: terminalEvent, changed: false };
        }

        const terminalEvent = this.appendEventRecord(runId, event).event;
        const settled = this.getRun(runId);
        if (!settled) throw new Error(`Run ${runId} was not found`);
        return { run: settled, event: terminalEvent, changed: true };
      })
      .immediate();
    if (result.changed && result.event) this.notifyEvent(result.event);
    return result;
  }

  listEvents(runId: string, afterSequence = 0): RunEvent[] {
    const rows = this.database
      .prepare('SELECT * FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence')
      .all(runId, afterSequence) as Array<Record<string, unknown>>;
    return rows.map((row) => this.parseEventRow(row));
  }

  replayEvents(request: ReplayEventsRequest): RunEventReplayPage {
    const parsed = ReplayEventsRequestSchema.parse(request);
    const cursor = parsed.cursor ? decodeCursor(parsed.cursor) : null;
    if (cursor && cursor.runId !== parsed.runId) {
      throw new Error('Run event cursor belongs to a different run');
    }
    const afterSequence = cursor?.sequence ?? parsed.afterSequence ?? 0;
    return this.database.transaction(() => {
      const run = this.database
        .prepare('SELECT last_event_sequence FROM runs WHERE id = ?')
        .get(parsed.runId) as { last_event_sequence: number } | undefined;
      if (!run) throw new Error(`Run ${parsed.runId} was not found`);
      const highWaterSequence = run.last_event_sequence;
      if (afterSequence > highWaterSequence) {
        throw new Error('Run event cursor is ahead of the durable high-water sequence');
      }
      const rows = this.database
        .prepare(
          `SELECT * FROM run_events
           WHERE run_id = ? AND sequence > ? AND sequence <= ?
           ORDER BY sequence
           LIMIT ?`
        )
        .all(parsed.runId, afterSequence, highWaterSequence, parsed.limit + 1) as Array<
        Record<string, unknown>
      >;
      const hasMore = rows.length > parsed.limit;
      const events = rows.slice(0, parsed.limit).map((row) => this.parseEventRow(row));
      for (const [index, event] of events.entries()) {
        const expected = afterSequence + index + 1;
        if (event.sequence !== expected) {
          throw new Error(
            `Run event sequence gap: expected ${expected}, received ${event.sequence}`
          );
        }
      }
      const nextSequence = events.at(-1)?.sequence ?? afterSequence;
      return {
        runId: parsed.runId,
        events,
        afterSequence,
        nextSequence,
        nextCursor: encodeCursor(parsed.runId, nextSequence),
        highWaterSequence,
        hasMore,
      };
    })();
  }

  getRunProjection(runId: string): RunProjection {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found`);
    const runRow = this.database
      .prepare('SELECT last_event_sequence FROM runs WHERE id = ?')
      .get(runId) as { last_event_sequence: number };
    const stored = this.database
      .prepare('SELECT projection_json, applied_sequence FROM run_projections WHERE run_id = ?')
      .get(runId) as { projection_json: string; applied_sequence: number } | undefined;
    if (stored && stored.applied_sequence === runRow.last_event_sequence) {
      return this.overlayProjectionRunState(
        RunProjectionSchema.parse(parseJson(stored.projection_json)),
        run
      );
    }
    return this.database
      .transaction(() => {
        let projection = this.initialProjection(runId);
        for (const event of this.listEvents(runId)) {
          projection = this.reduceProjection(projection, event);
        }
        this.writeProjection(projection);
        return this.overlayProjectionRunState(projection, run);
      })
      .immediate();
  }

  createArtifact(
    artifact: Artifact,
    persistence: ArtifactPersistence = {
      originalBytes: artifact.bytes,
      omittedBytes: 0,
      redactionCount: 0,
    }
  ): Artifact {
    const redactedPath = this.redactor.redactText(artifact.path);
    if (redactedPath.replacementCount > 0) {
      throw new Error('Artifact path contains secret material');
    }
    const sanitized: Artifact = {
      ...artifact,
      name: this.redactor.redactText(artifact.name).text,
      provenance: this.redactor.redactValue(artifact.provenance),
    };
    const parsed = ArtifactSchema.parse(sanitized);
    this.assertArtifactFileIntegrity(parsed);
    if (
      !Number.isInteger(persistence.originalBytes) ||
      !Number.isInteger(persistence.omittedBytes) ||
      !Number.isInteger(persistence.redactionCount) ||
      persistence.originalBytes < 0 ||
      persistence.omittedBytes < 0 ||
      persistence.redactionCount < 0 ||
      persistence.omittedBytes > persistence.originalBytes
    ) {
      throw new Error('Artifact persistence accounting is invalid');
    }
    const result = this.database
      .transaction(() => {
        this.db
          .insert(schema.artifacts)
          .values({
            ...parsed,
            provenanceJson: JSON.stringify(parsed.provenance),
            state: 'ready',
            readyAt: parsed.createdAt,
            originalBytes: persistence.originalBytes,
            omittedBytes: persistence.omittedBytes,
            redactionCount: persistence.redactionCount,
          })
          .run();
        const run = this.getRun(parsed.runId);
        if (!run) throw new Error(`Run ${parsed.runId} was not found`);
        const appended = this.appendEventRecord(
          parsed.runId,
          {
            kind: 'artifact.created',
            stage: run.stage,
            payload: {
              artifactId: parsed.id,
              kind: parsed.kind,
              name: parsed.name,
              sha256: parsed.sha256,
              mimeType: parsed.mimeType,
              bytes: parsed.bytes,
              originalBytes: persistence.originalBytes,
              omittedBytes: persistence.omittedBytes,
              truncated: persistence.omittedBytes > 0,
              redactionCount: persistence.redactionCount,
            },
            provenance: parsed.provenance,
            artifactIds: [parsed.id],
          },
          undefined,
          true
        );
        const events = [appended.event];
        if (persistence.omittedBytes > 0) {
          events.push(
            this.appendEventRecord(parsed.runId, {
              kind: 'output.truncated',
              stage: run.stage,
              payload: {
                scope:
                  parsed.kind === 'dom'
                    ? 'dom'
                    : parsed.kind === 'manifest'
                      ? 'manifest'
                      : 'command',
                ownerId: parsed.id,
                originalBytes: persistence.originalBytes,
                retainedBytes: persistence.originalBytes - persistence.omittedBytes,
                omittedBytes: persistence.omittedBytes,
                limitBytes: Math.max(1, parsed.bytes),
              },
              provenance: parsed.provenance,
              artifactIds: [parsed.id],
            }).event
          );
        }
        return { artifact: parsed, events };
      })
      .immediate();
    for (const event of result.events) this.notifyEvent(event);
    return result.artifact;
  }

  commitRunManifestArtifact(
    artifact: Artifact,
    persistence: ArtifactPersistence,
    record: Omit<RunManifestRecord, 'eventSequence'>,
    stage: RunStage,
    provenance: Provenance,
    expectation?: RunManifestCommitExpectation
  ): CommitRunManifestArtifactResult {
    if (this.redactor.redactText(artifact.path).replacementCount > 0) {
      throw new Error('Artifact path contains secret material');
    }
    const parsedArtifact = ArtifactSchema.parse({
      ...artifact,
      name: this.redactor.redactText(artifact.name).text,
      provenance: this.redactor.redactValue(artifact.provenance),
    });
    if (
      parsedArtifact.kind !== 'manifest' ||
      parsedArtifact.runId !== record.runId ||
      parsedArtifact.id !== record.artifactId ||
      parsedArtifact.sha256 !== record.sha256 ||
      persistence.omittedBytes !== 0
    ) {
      throw new Error('Run manifest artifact metadata is inconsistent');
    }
    this.assertArtifactFileIntegrity(parsedArtifact);
    const result = this.database
      .transaction(() => {
        const existingRecord = this.getRunManifest(record.runId);
        if (existingRecord) {
          const existingArtifact = this.getArtifact(existingRecord.artifactId);
          if (!existingArtifact) {
            throw new Error('Run manifest record references an unavailable artifact');
          }
          return {
            artifact: existingArtifact,
            record: existingRecord,
            created: false,
            events: [] as RunEvent[],
          };
        }
        const run = this.getRun(record.runId);
        if (!run) throw new Error(`Run ${record.runId} was not found`);
        if (!TERMINAL_RUN_STATUSES.has(run.status)) {
          throw new Error('Run manifests require a durable terminal run');
        }
        if (stage !== run.stage) {
          throw new Error('Run manifest stage does not match the durable run');
        }
        if (expectation) {
          const sequence = this.database
            .prepare('SELECT last_event_sequence FROM runs WHERE id = ?')
            .get(record.runId) as { last_event_sequence: number };
          if (sequence.last_event_sequence !== expectation.lastEventSequence) {
            throw new Error('Run manifest snapshot changed before commit');
          }
          for (const key of ['status', 'stage', 'summary', 'error', 'completedAt'] as const) {
            if (run[key] !== expectation.outcome[key]) {
              throw new Error('Run manifest outcome changed before commit');
            }
          }
        }
        this.db
          .insert(schema.artifacts)
          .values({
            ...parsedArtifact,
            provenanceJson: JSON.stringify(parsedArtifact.provenance),
            state: 'ready',
            readyAt: parsedArtifact.createdAt,
            originalBytes: persistence.originalBytes,
            omittedBytes: 0,
            redactionCount: persistence.redactionCount,
          })
          .run();
        const artifactEvent = this.appendEventRecord(
          record.runId,
          {
            kind: 'artifact.created',
            stage,
            payload: {
              artifactId: parsedArtifact.id,
              kind: parsedArtifact.kind,
              name: parsedArtifact.name,
              sha256: parsedArtifact.sha256,
              mimeType: parsedArtifact.mimeType,
              bytes: parsedArtifact.bytes,
              originalBytes: persistence.originalBytes,
              omittedBytes: 0,
              truncated: false,
              redactionCount: persistence.redactionCount,
            },
            provenance: parsedArtifact.provenance,
            artifactIds: [parsedArtifact.id],
          },
          undefined,
          true
        ).event;
        const manifestEvent = this.appendEventRecord(
          record.runId,
          {
            kind: 'run.manifest_created',
            stage,
            payload: {
              manifestId: record.id,
              artifactId: record.artifactId,
              sha256: record.sha256,
            },
            provenance: this.redactor.redactValue(provenance),
            artifactIds: [record.artifactId],
          },
          undefined,
          true
        ).event;
        const parsedRecord = RunManifestRecordSchema.parse({
          ...record,
          eventSequence: manifestEvent.sequence,
        });
        this.database
          .prepare(
            `INSERT INTO run_manifests(
              id, run_id, artifact_id, sha256, event_sequence, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            parsedRecord.id,
            parsedRecord.runId,
            parsedRecord.artifactId,
            parsedRecord.sha256,
            parsedRecord.eventSequence,
            parsedRecord.createdAt
          );
        return {
          artifact: parsedArtifact,
          record: parsedRecord,
          created: true,
          events: [artifactEvent, manifestEvent],
        };
      })
      .immediate();
    for (const event of result.events) this.notifyEvent(event);
    return {
      artifact: result.artifact,
      record: result.record,
      created: result.created,
    };
  }

  finalizeRunWithManifestArtifact(
    artifact: Artifact,
    persistence: ArtifactPersistence,
    record: Omit<RunManifestRecord, 'eventSequence'>,
    stage: RunStage,
    provenance: Provenance,
    input: FinalizeRunManifestArtifactInput
  ): FinalizeRunManifestArtifactResult {
    if (this.redactor.redactText(artifact.path).replacementCount > 0) {
      throw new Error('Artifact path contains secret material');
    }
    const parsedArtifact = ArtifactSchema.parse({
      ...artifact,
      name: this.redactor.redactText(artifact.name).text,
      provenance: this.redactor.redactValue(artifact.provenance),
    });
    if (
      parsedArtifact.kind !== 'manifest' ||
      parsedArtifact.runId !== record.runId ||
      parsedArtifact.id !== record.artifactId ||
      parsedArtifact.sha256 !== record.sha256 ||
      persistence.omittedBytes !== 0
    ) {
      throw new Error('Run manifest artifact metadata is inconsistent');
    }
    this.assertArtifactFileIntegrity(parsedArtifact);

    const expectedKind = TERMINAL_EVENT_BY_STATUS[input.status];
    if (input.terminalEvent.kind !== expectedKind) {
      throw new Error(`Terminal status ${input.status} requires event ${expectedKind}`);
    }
    if (input.terminalEvent.stage !== stage) {
      throw new Error('Terminal event stage does not match the manifest stage');
    }
    const requestedEvidence = TerminalEvidenceSchema.parse(
      this.redactor.redactValue(input.terminalEvidence)
    );
    if (requestedEvidence.runId !== record.runId || requestedEvidence.outcome !== input.status) {
      throw new Error('Terminal evidence does not match the run outcome');
    }
    this.assertEvidence(record.runId, [
      ...requestedEvidence.artifactIds,
      ...requestedEvidence.evidenceLinks.map((link) => link.artifactId),
    ]);

    const result = this.database
      .transaction(() => {
        const existingRecord = this.getRunManifest(record.runId);
        if (existingRecord) {
          const existingArtifact = this.getArtifact(existingRecord.artifactId);
          const existingRun = this.getRun(record.runId);
          const events = this.listEvents(record.runId);
          const evidenceEvent = events.findLast((event) => event.kind === 'terminal.evidence');
          const terminalEvent = events.findLast((event) => TERMINAL_EVENT_KINDS.has(event.kind));
          if (
            !existingArtifact ||
            !existingRun ||
            !evidenceEvent ||
            !terminalEvent ||
            events.at(-1)?.id !== terminalEvent.id ||
            evidenceEvent.sequence >= terminalEvent.sequence ||
            !evidenceEvent.payload.evidence.artifactIds.includes(existingArtifact.id)
          ) {
            throw new Error('Existing run manifest was not atomically terminalized');
          }
          this.assertArtifactFileIntegrity(existingArtifact);
          return {
            artifact: existingArtifact,
            record: existingRecord,
            created: false,
            run: existingRun,
            terminalEvidence: evidenceEvent.payload.evidence,
            events: events.filter(
              (event) => event.sequence >= Math.max(1, existingRecord.eventSequence - 1)
            ),
            notifications: [] as RunEvent[],
          };
        }

        const run = this.getRun(record.runId);
        if (!run) throw new Error(`Run ${record.runId} was not found`);
        if (TERMINAL_RUN_STATUSES.has(run.status)) {
          throw new Error('Atomic run finalization requires a non-terminal durable run');
        }
        if (stage !== input.terminalEvent.stage) {
          throw new Error('Run manifest stage does not match the terminal event');
        }
        const sequence = this.database
          .prepare('SELECT last_event_sequence FROM runs WHERE id = ?')
          .get(record.runId) as { last_event_sequence: number };
        if (sequence.last_event_sequence !== input.expectation.lastEventSequence) {
          throw new Error('Run manifest snapshot changed before commit');
        }
        const context = this.database
          .prepare('SELECT updated_at FROM run_manifest_contexts WHERE run_id = ?')
          .get(record.runId) as { updated_at: string } | undefined;
        if ((context?.updated_at ?? null) !== input.expectation.contextUpdatedAt) {
          throw new Error('Run manifest snapshot changed before commit');
        }
        for (const key of [
          'status',
          'stage',
          'summary',
          'error',
          'completedAt',
          'baseSha',
          'branch',
          'worktreePath',
          'updatedAt',
        ] as const) {
          if (run[key] !== input.expectation.run[key]) {
            throw new Error('Run manifest snapshot changed before commit');
          }
        }

        const completedAt = input.completedAt;
        const safeMessage = this.redactor.boundedOutput(
          input.terminalEvent.payload.message,
          4_096
        ).text;
        const updated = this.database
          .prepare(
            `UPDATE runs
             SET status = ?,
                 stage = ?,
                 summary = ?,
                 error = ?,
                 available_actions_json = ?,
                 intervention_json = NULL,
                 failure_code = ?,
                 last_heartbeat_at = ?,
                 completed_at = ?,
                 updated_at = ?
             WHERE id = ?
               AND last_event_sequence = ?
               AND status = ?`
          )
          .run(
            input.status,
            stage,
            input.status === 'succeeded' ? safeMessage : run.summary,
            input.status === 'succeeded' ? null : safeMessage,
            JSON.stringify(input.disposition.availableActions),
            input.disposition.failureCode,
            completedAt,
            completedAt,
            completedAt,
            record.runId,
            input.expectation.lastEventSequence,
            run.status
          );
        if (updated.changes !== 1) {
          throw new Error('Run manifest snapshot changed before commit');
        }

        this.db
          .insert(schema.artifacts)
          .values({
            ...parsedArtifact,
            provenanceJson: JSON.stringify(parsedArtifact.provenance),
            state: 'ready',
            readyAt: parsedArtifact.createdAt,
            originalBytes: persistence.originalBytes,
            omittedBytes: 0,
            redactionCount: persistence.redactionCount,
          })
          .run();
        const artifactEvent = this.appendEventRecord(
          record.runId,
          {
            kind: 'artifact.created',
            stage,
            payload: {
              artifactId: parsedArtifact.id,
              kind: parsedArtifact.kind,
              name: parsedArtifact.name,
              sha256: parsedArtifact.sha256,
              mimeType: parsedArtifact.mimeType,
              bytes: parsedArtifact.bytes,
              originalBytes: persistence.originalBytes,
              omittedBytes: 0,
              truncated: false,
              redactionCount: persistence.redactionCount,
            },
            provenance: parsedArtifact.provenance,
            artifactIds: [parsedArtifact.id],
          },
          undefined,
          true
        ).event;
        const manifestEvent = this.appendEventRecord(
          record.runId,
          {
            kind: 'run.manifest_created',
            stage,
            payload: {
              manifestId: record.id,
              artifactId: record.artifactId,
              sha256: record.sha256,
            },
            provenance: this.redactor.redactValue(provenance),
            artifactIds: [record.artifactId],
          },
          undefined,
          true
        ).event;
        const parsedRecord = RunManifestRecordSchema.parse({
          ...record,
          eventSequence: manifestEvent.sequence,
        });

        const artifactIds = [...new Set([...requestedEvidence.artifactIds, parsedArtifact.id])];
        const evidenceLinks = [...requestedEvidence.evidenceLinks];
        if (!evidenceLinks.some((link) => link.artifactId === parsedArtifact.id)) {
          evidenceLinks.push({
            artifactId: parsedArtifact.id,
            label: parsedArtifact.name.slice(0, 500) || 'run-manifest.json',
            relationship: 'supports',
          });
        }
        const terminalEvidence = TerminalEvidenceSchema.parse({
          ...requestedEvidence,
          outcome: input.status,
          evidenceAvailability: 'ready',
          artifactIds,
          evidenceLinks,
          evidenceUnavailableReason: null,
        });
        const evidenceEvent = this.appendEventRecord(
          record.runId,
          {
            kind: 'terminal.evidence',
            stage,
            payload: { evidence: terminalEvidence },
            provenance: input.terminalEvent.provenance,
            artifactIds,
          },
          undefined,
          true
        ).event;
        const terminalEvent = this.appendEventRecord(
          record.runId,
          {
            ...input.terminalEvent,
            artifactIds,
          },
          undefined,
          true
        ).event;

        this.database
          .prepare(
            `INSERT INTO run_manifests(
              id, run_id, artifact_id, sha256, event_sequence, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            parsedRecord.id,
            parsedRecord.runId,
            parsedRecord.artifactId,
            parsedRecord.sha256,
            parsedRecord.eventSequence,
            parsedRecord.createdAt
          );
        const settled = this.getRun(record.runId);
        if (!settled) throw new Error(`Run ${record.runId} was not found`);
        return {
          artifact: parsedArtifact,
          record: parsedRecord,
          created: true,
          run: settled,
          terminalEvidence,
          events: [artifactEvent, manifestEvent, evidenceEvent, terminalEvent],
          notifications: [artifactEvent, manifestEvent, evidenceEvent, terminalEvent],
        };
      })
      .immediate();
    for (const event of result.notifications) this.notifyEvent(event);
    return {
      artifact: result.artifact,
      record: result.record,
      created: result.created,
      run: result.run,
      terminalEvidence: result.terminalEvidence,
      events: result.events,
    };
  }

  getArtifact(artifactId: string): Artifact | null {
    const row = this.db.query.artifacts
      .findFirst({
        where: and(eq(schema.artifacts.id, artifactId), eq(schema.artifacts.state, 'ready')),
      })
      .sync();
    return row ? ArtifactSchema.parse({ ...row, provenance: parseJson(row.provenanceJson) }) : null;
  }

  listArtifacts(runId: string): Artifact[] {
    return this.db
      .select()
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.runId, runId), eq(schema.artifacts.state, 'ready')))
      .orderBy(schema.artifacts.createdAt)
      .all()
      .map((row) => ArtifactSchema.parse({ ...row, provenance: parseJson(row.provenanceJson) }));
  }

  listArtifactsBefore(cutoff: string): Artifact[] {
    return this.db
      .select()
      .from(schema.artifacts)
      .where(and(lt(schema.artifacts.createdAt, cutoff), eq(schema.artifacts.state, 'ready')))
      .orderBy(schema.artifacts.createdAt)
      .all()
      .map((row) => ArtifactSchema.parse({ ...row, provenance: parseJson(row.provenanceJson) }));
  }

  deleteArtifact(artifactId: string): boolean {
    return this.database
      .transaction(() => {
        const artifact = this.getArtifact(artifactId);
        if (!artifact || this.artifactIsReferenced(artifact.runId, artifactId)) return false;
        const result = this.db
          .delete(schema.artifacts)
          .where(eq(schema.artifacts.id, artifactId))
          .run();
        return result.changes === 1;
      })
      .immediate();
  }

  private artifactIsReferenced(runId: string, artifactId: string): boolean {
    const direct = this.database
      .prepare(
        `SELECT 1 AS referenced
         FROM patches WHERE run_id = ? AND artifact_id = ?
         UNION ALL
         SELECT 1 AS referenced
         FROM run_manifests WHERE run_id = ? AND artifact_id = ?
         LIMIT 1`
      )
      .get(runId, artifactId, runId, artifactId);
    if (direct) return true;

    const jsonColumns = [
      ['diagnoses', 'evidence_artifact_ids_json'],
      ['verifications', 'commands_json'],
      ['verifications', 'artifact_ids_json'],
      ['provider_calls', 'evidence_artifact_ids_json'],
      ['stage_attempts', 'evidence_artifact_ids_json'],
      ['specialist_activities', 'evidence_artifact_ids_json'],
      ['specialist_critiques', 'evidence_artifact_ids_json'],
      ['specialist_decisions', 'evidence_artifact_ids_json'],
      ['run_checkpoints', 'data_json'],
    ] as const;
    for (const [table, column] of jsonColumns) {
      const rows = this.database
        .prepare(`SELECT ${column} AS value FROM ${table} WHERE run_id = ?`)
        .all(runId) as Array<{ value: string }>;
      if (rows.some((row) => jsonContainsString(row.value, artifactId))) return true;
    }

    const eventRows = this.database
      .prepare(
        `SELECT artifact_ids_json AS value
         FROM run_events
         WHERE run_id = ? AND kind NOT IN ('artifact.created', 'output.truncated')`
      )
      .all(runId) as Array<{ value: string }>;
    return eventRows.some((row) => jsonContainsString(row.value, artifactId));
  }

  createDiagnosis(diagnosis: Diagnosis): Diagnosis {
    const parsed = DiagnosisSchema.parse(this.redactor.redactValue(diagnosis));
    this.db
      .insert(schema.diagnoses)
      .values({
        ...parsed,
        confidence: Math.round(parsed.confidence * 10_000),
        evidenceArtifactIdsJson: JSON.stringify(parsed.evidenceArtifactIds),
        provenanceJson: JSON.stringify(parsed.provenance),
      })
      .run();
    return parsed;
  }

  getDiagnosis(runId: string): Diagnosis | null {
    return this.listDiagnoses(runId).at(-1) ?? null;
  }

  listDiagnoses(runId: string): Diagnosis[] {
    const rows = this.database
      .prepare('SELECT * FROM diagnoses WHERE run_id = ? ORDER BY created_at, rowid')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) =>
      DiagnosisSchema.parse({
        id: row.id,
        runId: row.run_id,
        summary: row.summary,
        rootCause: row.root_cause,
        confidence: Number(row.confidence) / 10_000,
        evidenceArtifactIds: parseJson(String(row.evidence_artifact_ids_json)),
        provenance: parseJson(String(row.provenance_json)),
        createdAt: row.created_at,
      })
    );
  }

  createPatch(patch: Patch): Patch {
    const parsed = PatchSchema.parse(this.redactor.redactValue(patch));
    this.db
      .insert(schema.patches)
      .values({ ...parsed, filesJson: JSON.stringify(parsed.files) })
      .run();
    return parsed;
  }

  getPatch(runId: string): Patch | null {
    return this.listPatches(runId).at(-1) ?? null;
  }

  markPatchApplied(patchId: string, inspection: AppliedPatchInspection): Patch {
    return this.database
      .transaction(() => {
        const row = this.database.prepare('SELECT * FROM patches WHERE id = ?').get(patchId) as
          Record<string, unknown> | undefined;
        if (!row) throw new Error(`Patch ${patchId} was not found`);

        const existing = parsePatchRow(row);
        const files = [...new Set(inspection.files)];
        const risk = inspection.highRisk ? 'high' : 'normal';
        if (existing.applied) {
          if (existing.risk === risk && JSON.stringify(existing.files) === JSON.stringify(files)) {
            return existing;
          }
          throw new Error(`Patch ${patchId} was already applied with different inspection results`);
        }

        this.database
          .prepare(
            `UPDATE patches
             SET files_json = ?, risk = ?, applied = 1
             WHERE id = ? AND applied = 0`
          )
          .run(JSON.stringify(files), risk, patchId);
        const applied = this.database.prepare('SELECT * FROM patches WHERE id = ?').get(patchId) as
          Record<string, unknown> | undefined;
        if (!applied) throw new Error(`Patch ${patchId} was not found`);
        return parsePatchRow(applied);
      })
      .immediate();
  }

  listPatches(runId: string): Patch[] {
    const rows = this.database
      .prepare('SELECT * FROM patches WHERE run_id = ? ORDER BY created_at, rowid')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => parsePatchRow(row));
  }

  createVerification(verification: Verification): Verification {
    const parsed = VerificationSchema.parse(this.redactor.redactValue(verification));
    this.db
      .insert(schema.verifications)
      .values({
        ...parsed,
        commandsJson: JSON.stringify(parsed.commands),
        artifactIdsJson: JSON.stringify(parsed.artifactIds),
      })
      .run();
    return parsed;
  }

  getVerification(runId: string): Verification | null {
    return this.listVerifications(runId).at(-1) ?? null;
  }

  listVerifications(runId: string): Verification[] {
    const rows = this.database
      .prepare('SELECT * FROM verifications WHERE run_id = ? ORDER BY created_at, rowid')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) =>
      VerificationSchema.parse({
        id: row.id,
        runId: row.run_id,
        passed: Number(row.passed) === 1,
        commands: parseJson(String(row.commands_json)),
        artifactIds: parseJson(String(row.artifact_ids_json)),
        createdAt: row.created_at,
      })
    );
  }

  replaceTestCases(projectId: string, cases: TestCase[]): TestCase[] {
    this.database.transaction(() => {
      this.db.delete(schema.testCases).where(eq(schema.testCases.projectId, projectId)).run();
      for (const testCase of cases) {
        const definition = { ...testCase.definition };
        const environment =
          testCase.kind === 'command' &&
          definition.env &&
          typeof definition.env === 'object' &&
          !Array.isArray(definition.env)
            ? (definition.env as Record<string, unknown>)
            : null;
        if (environment) {
          this.registerSecrets(
            Object.values(environment).filter((value): value is string => typeof value === 'string')
          );
          definition.env = Object.fromEntries(
            Object.keys(environment).map((key) => [key, '[REDACTED]'])
          );
        }
        const parsed = TestCaseSchema.parse(this.redactor.redactValue({ ...testCase, definition }));
        this.db
          .insert(schema.testCases)
          .values({
            ...parsed,
            definitionJson: JSON.stringify(parsed.definition),
            provenanceJson: JSON.stringify(parsed.provenance),
          })
          .run();
      }
    })();
    return cases;
  }

  listTestCases(projectId: string): TestCase[] {
    return this.db
      .select()
      .from(schema.testCases)
      .where(eq(schema.testCases.projectId, projectId))
      .orderBy(schema.testCases.createdAt)
      .all()
      .map((row) =>
        TestCaseSchema.parse({
          ...row,
          definition: parseJson(row.definitionJson),
          provenance: parseJson(row.provenanceJson),
        })
      );
  }

  recordProviderCall(call: ProviderCall): ProviderCall {
    const parsed = this.sanitizeProviderCall(ProviderCallSchema.parse(call));
    this.insertProviderCall(parsed);
    return parsed;
  }

  beginProviderCall(call: ProviderCall, event: ModelStartedEvent): ProviderCall {
    const parsed = this.sanitizeProviderCall(ProviderCallSchema.parse(call));
    if (parsed.status !== 'started') throw new Error('Provider call must begin in started status');
    if (
      parsed.completedAt !== null ||
      parsed.durationMs !== null ||
      parsed.responseDigest !== null ||
      parsed.error !== null
    ) {
      throw new Error('Provider call start contains terminal data');
    }
    if (parsed.startedAt === undefined || parsed.requestDigest === null) {
      throw new Error('Provider call start requires a timestamp and request digest');
    }
    const sanitizedEvent = this.sanitizeEvent(event) as ModelStartedEvent;
    this.assertProviderStartEvent(parsed, sanitizedEvent);
    const result = this.database
      .transaction(() => {
        this.insertProviderCall(parsed);
        return this.appendEventRecord(parsed.runId, sanitizedEvent, undefined, true);
      })
      .immediate();
    if (result.created) this.notifyEvent(result.event);
    return parsed;
  }

  finishProviderCall(
    callId: string,
    update: ProviderCall,
    event: ModelTerminalEvent
  ): ProviderCall {
    const parsed = this.sanitizeProviderCall(ProviderCallSchema.parse(update));
    if (parsed.id !== callId) throw new Error('Provider call update ID does not match');
    if (parsed.status === 'started')
      throw new Error('Provider call terminal update is not terminal');
    const sanitizedEvent = this.sanitizeEvent(event) as ModelTerminalEvent;
    const result = this.database
      .transaction(() => {
        const existingRow = this.db.query.providerCalls
          .findFirst({ where: eq(schema.providerCalls.id, callId) })
          .sync();
        const existing = existingRow ? this.parseProviderCallRow(existingRow) : null;
        if (
          !existing ||
          existing.status !== 'started' ||
          existing.runId !== parsed.runId ||
          existing.provider !== parsed.provider ||
          existing.model !== parsed.model ||
          existing.purpose !== parsed.purpose ||
          existing.createdAt !== parsed.createdAt ||
          existing.startedAt !== parsed.startedAt ||
          existing.requestDigest !== parsed.requestDigest ||
          (existing.attempt ?? 1) !== (parsed.attempt ?? 1) ||
          (existing.specialistRole ?? null) !== (parsed.specialistRole ?? null)
        ) {
          throw new Error(`Provider call ${parsed.id} terminal data does not match its start`);
        }
        if (
          parsed.completedAt === null ||
          parsed.completedAt === undefined ||
          parsed.durationMs === null ||
          parsed.durationMs === undefined ||
          (parsed.status === 'succeeded' &&
            (parsed.responseDigest === null || parsed.error !== null)) ||
          ((parsed.status === 'failed' || parsed.status === 'cancelled') && parsed.error === null)
        ) {
          throw new Error(`Provider call ${parsed.id} terminal data is incomplete`);
        }
        const terminal = this.sanitizeProviderCall(
          ProviderCallSchema.parse({
            ...existing,
            status: parsed.status,
            inputTokens: parsed.inputTokens,
            outputTokens: parsed.outputTokens,
            costUsd: parsed.costUsd,
            error: parsed.error,
            completedAt: parsed.completedAt,
            durationMs: parsed.durationMs,
            evidenceIds: parsed.evidenceIds ?? [],
            responseDigest: parsed.responseDigest ?? null,
            errorCode: parsed.errorCode ?? null,
          })
        );
        this.assertEvidence(terminal.runId, terminal.evidenceIds ?? []);
        this.assertProviderTerminalEvent(terminal, sanitizedEvent);
        const updated = this.database
          .prepare(
            `UPDATE provider_calls
             SET status = ?, input_tokens = ?, output_tokens = ?, cost_usd_micros = ?,
                 error = ?, completed_at = ?, duration_ms = ?,
                 evidence_artifact_ids_json = ?, response_digest = ?, error_code = ?
             WHERE id = ? AND run_id = ? AND status = 'started'`
          )
          .run(
            terminal.status,
            terminal.inputTokens,
            terminal.outputTokens,
            terminal.costUsd === null ? null : Math.round(terminal.costUsd * 1_000_000),
            terminal.error,
            terminal.completedAt,
            terminal.durationMs,
            JSON.stringify(terminal.evidenceIds ?? []),
            terminal.responseDigest ?? null,
            terminal.errorCode ?? null,
            terminal.id,
            terminal.runId
          );
        if (updated.changes !== 1) {
          throw new Error(`Provider call ${terminal.id} was not in started state`);
        }
        return {
          call: terminal,
          ...this.appendEventRecord(terminal.runId, sanitizedEvent, undefined, true),
        };
      })
      .immediate();
    if (result.created) this.notifyEvent(result.event);
    return result.call;
  }

  listProviderCalls(runId: string): ProviderCall[] {
    return this.db
      .select()
      .from(schema.providerCalls)
      .where(eq(schema.providerCalls.runId, runId))
      .orderBy(schema.providerCalls.createdAt)
      .all()
      .map((row) => this.parseProviderCallRow(row));
  }

  beginStageAttempt(
    runId: string,
    stage: RunStage,
    summary: string,
    provenance: Provenance
  ): StageAttempt {
    const timestamp = now();
    const safeSummary = this.redactor.redactText(summary).text.slice(0, 2_048);
    const result = this.database
      .transaction(() => {
        const row = this.database
          .prepare(
            'SELECT COALESCE(MAX(attempt), 0) AS attempt FROM stage_attempts WHERE run_id = ? AND stage = ?'
          )
          .get(runId, stage) as { attempt: number };
        const attempt = StageAttemptSchema.parse({
          id: randomUUID(),
          runId,
          stage,
          attempt: row.attempt + 1,
          status: 'running',
          summary: safeSummary,
          waitingOn: null,
          nextRetryAt: null,
          lastHeartbeatAt: timestamp,
          startedAt: timestamp,
          completedAt: null,
          evidenceIds: [],
        });
        this.insertStageAttempt(attempt);
        this.updateRunRecord(runId, {
          stage,
          status: 'running',
          lastHeartbeatAt: timestamp,
        });
        const appended = this.appendEventRecord(runId, {
          kind: 'stage.started',
          stage,
          payload: {
            message: safeSummary,
            attempt: attempt.attempt,
            stageAttemptId: attempt.id,
          },
          provenance: this.redactor.redactValue(provenance),
          artifactIds: [],
        });
        return { attempt, ...appended };
      })
      .immediate();
    if (result.created) this.notifyEvent(result.event);
    return result.attempt;
  }

  heartbeatStageAttempt(
    stageAttemptId: string,
    currentAction: string,
    waitingOn: string | null,
    provenance: Provenance
  ): StageAttempt {
    const timestamp = now();
    const result = this.database
      .transaction(() => {
        const row = this.database
          .prepare('SELECT * FROM stage_attempts WHERE id = ?')
          .get(stageAttemptId) as Record<string, unknown> | undefined;
        if (!row) throw new Error(`Stage attempt ${stageAttemptId} was not found`);
        const safeWaiting = waitingOn
          ? this.redactor.redactText(waitingOn).text.slice(0, 1_024)
          : null;
        const updated = this.database
          .prepare(
            `UPDATE stage_attempts
             SET status = ?, waiting_on = ?, last_heartbeat_at = ?
             WHERE id = ? AND status IN ('started', 'running', 'waiting')`
          )
          .run(safeWaiting ? 'waiting' : 'running', safeWaiting, timestamp, stageAttemptId);
        if (updated.changes !== 1) {
          throw new Error(`Stage attempt ${stageAttemptId} is not active`);
        }
        this.updateRunRecord(String(row.run_id), { lastHeartbeatAt: timestamp });
        const appended = this.appendEventRecord(String(row.run_id), {
          kind: 'stage.heartbeat',
          stage: String(row.stage) as RunStage,
          payload: {
            stageAttemptId,
            attempt: Number(row.attempt),
            currentAction: this.redactor.redactText(currentAction).text.slice(0, 4_096),
            waitingOn: safeWaiting,
            heartbeatAt: timestamp,
          },
          provenance: this.redactor.redactValue(provenance),
          artifactIds: [],
        });
        return { ...this.parseStageAttemptRow(row), ...appended };
      })
      .immediate();
    if (result.created) this.notifyEvent(result.event);
    return this.getStageAttempt(stageAttemptId)!;
  }

  scheduleStageRetry(
    stageAttemptId: string,
    reason: string,
    nextRetryAt: string,
    evidenceIds: string[],
    provenance: Provenance
  ): StageAttempt {
    const retryAt = new Date(nextRetryAt);
    if (!Number.isFinite(retryAt.getTime())) throw new Error('Stage retry time is invalid');
    const safeReason = this.redactor.redactText(reason).text.slice(0, 2_048);
    const timestamp = now();
    const result = this.database
      .transaction(() => {
        const row = this.database
          .prepare('SELECT * FROM stage_attempts WHERE id = ?')
          .get(stageAttemptId) as Record<string, unknown> | undefined;
        if (!row) throw new Error(`Stage attempt ${stageAttemptId} was not found`);
        this.assertEvidence(String(row.run_id), evidenceIds);
        const updated = this.database
          .prepare(
            `UPDATE stage_attempts
             SET status = 'retry_scheduled', summary = ?, next_retry_at = ?,
                 last_heartbeat_at = ?, completed_at = ?,
                 evidence_artifact_ids_json = ?
             WHERE id = ? AND status IN ('started', 'running', 'waiting')`
          )
          .run(
            safeReason,
            retryAt.toISOString(),
            timestamp,
            timestamp,
            JSON.stringify(evidenceIds),
            stageAttemptId
          );
        if (updated.changes !== 1) {
          throw new Error(`Stage attempt ${stageAttemptId} is not active`);
        }
        return this.appendEventRecord(String(row.run_id), {
          kind: 'stage.retry_scheduled',
          stage: String(row.stage) as RunStage,
          payload: {
            stageAttemptId,
            attempt: Number(row.attempt),
            nextAttempt: Number(row.attempt) + 1,
            reason: safeReason,
            nextRetryAt: retryAt.toISOString(),
          },
          provenance: this.redactor.redactValue(provenance),
          artifactIds: evidenceIds,
        });
      })
      .immediate();
    if (result.created) this.notifyEvent(result.event);
    return this.getStageAttempt(stageAttemptId)!;
  }

  completeStageAttempt(
    stageAttemptId: string,
    status: Extract<StageAttempt['status'], 'succeeded' | 'failed' | 'cancelled' | 'interrupted'>,
    summary: string,
    evidenceIds: string[],
    provenance: Provenance
  ): StageAttempt {
    const timestamp = now();
    const safeSummary = this.redactor.redactText(summary).text.slice(0, 2_048);
    const result = this.database
      .transaction(() => {
        const row = this.database
          .prepare('SELECT * FROM stage_attempts WHERE id = ?')
          .get(stageAttemptId) as Record<string, unknown> | undefined;
        if (!row) throw new Error(`Stage attempt ${stageAttemptId} was not found`);
        this.assertEvidence(String(row.run_id), evidenceIds);
        const updated = this.database
          .prepare(
            `UPDATE stage_attempts
             SET status = ?, summary = ?, completed_at = ?, last_heartbeat_at = ?,
                 evidence_artifact_ids_json = ?
             WHERE id = ?
               AND status IN ('started', 'running', 'waiting', 'retry_scheduled')`
          )
          .run(
            status,
            safeSummary,
            timestamp,
            timestamp,
            JSON.stringify(evidenceIds),
            stageAttemptId
          );
        if (updated.changes !== 1) {
          throw new Error(`Stage attempt ${stageAttemptId} is not active`);
        }
        const appended = this.appendEventRecord(String(row.run_id), {
          kind: 'stage.completed',
          stage: String(row.stage) as RunStage,
          payload: {
            message: safeSummary,
            attempt: Number(row.attempt),
            stageAttemptId,
            status,
          },
          provenance: this.redactor.redactValue(provenance),
          artifactIds: evidenceIds,
        });
        return appended;
      })
      .immediate();
    if (result.created) this.notifyEvent(result.event);
    return this.getStageAttempt(stageAttemptId)!;
  }

  getStageAttempt(stageAttemptId: string): StageAttempt | null {
    const row = this.database
      .prepare('SELECT * FROM stage_attempts WHERE id = ?')
      .get(stageAttemptId) as Record<string, unknown> | undefined;
    return row ? this.parseStageAttemptRow(row) : null;
  }

  listStageAttempts(runId: string): StageAttempt[] {
    const rows = this.database
      .prepare('SELECT * FROM stage_attempts WHERE run_id = ? ORDER BY started_at, stage, attempt')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.parseStageAttemptRow(row));
  }

  recordPolicyWorkerCall(call: PolicyWorkerCall): PolicyWorkerCall {
    const parsed = PolicyWorkerCallSchema.parse(this.redactor.redactValue(call));
    this.database
      .prepare(
        `INSERT INTO policy_worker_calls(
          id, run_id, worker, version, attempt, status, input_digest, output_digest,
          error, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        parsed.id,
        parsed.runId,
        parsed.worker,
        parsed.version,
        parsed.attempt,
        parsed.status,
        parsed.inputDigest,
        parsed.outputDigest,
        parsed.error,
        parsed.startedAt,
        parsed.completedAt
      );
    return parsed;
  }

  listPolicyWorkerCalls(runId: string): PolicyWorkerCall[] {
    const rows = this.database
      .prepare('SELECT * FROM policy_worker_calls WHERE run_id = ? ORDER BY started_at, id')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) =>
      PolicyWorkerCallSchema.parse({
        id: row.id,
        runId: row.run_id,
        worker: row.worker,
        version: row.version,
        attempt: row.attempt,
        status: row.status,
        inputDigest: row.input_digest,
        outputDigest: row.output_digest,
        error: row.error,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      })
    );
  }

  recordSpecialistActivity(
    activity: SpecialistActivity,
    stage: RunStage,
    provenance: Provenance
  ): SpecialistActivity {
    const parsed = SpecialistActivitySchema.parse(this.redactor.redactValue(activity));
    const result = this.database
      .transaction(() => {
        this.assertSpecialistSource(parsed.runId, parsed.source, {
          role: parsed.role,
          attempt: parsed.attempt,
          allowedStatuses: parsed.status === 'blocked' ? ['succeeded', 'failed'] : [parsed.status],
        });
        this.assertEvidence(parsed.runId, parsed.evidenceIds);
        const source = sourceColumns(parsed.source);
        this.database
          .prepare(
            `INSERT INTO specialist_activities(
              id, run_id, role, status, summary, source_kind, provider_call_id,
              policy_worker_call_id, occurred_at, attempt, evidence_artifact_ids_json,
              handoff_target
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            parsed.id,
            parsed.runId,
            parsed.role,
            parsed.status,
            parsed.summary,
            source.kind,
            source.providerCallId,
            source.policyWorkerCallId,
            parsed.occurredAt,
            parsed.attempt,
            JSON.stringify(parsed.evidenceIds),
            parsed.handoffTarget
          );
        return this.appendEventRecord(
          parsed.runId,
          {
            kind: 'specialist.activity',
            stage,
            payload: { activity: parsed },
            provenance: this.redactor.redactValue(provenance),
            artifactIds: parsed.evidenceIds,
          },
          undefined,
          true
        );
      })
      .immediate();
    if (result.created) this.notifyEvent(result.event);
    return parsed;
  }

  listSpecialistActivities(runId: string): SpecialistActivity[] {
    const rows = this.database
      .prepare(
        `SELECT specialist_activities.*, policy_worker_calls.worker AS source_worker
         FROM specialist_activities
         LEFT JOIN policy_worker_calls
           ON policy_worker_calls.id = specialist_activities.policy_worker_call_id
         WHERE specialist_activities.run_id = ?
         ORDER BY specialist_activities.occurred_at, specialist_activities.id`
      )
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.parseSpecialistActivityRow(row));
  }

  recordSpecialistCritique(
    critique: SpecialistCritique,
    stage: RunStage,
    provenance: Provenance
  ): SpecialistCritique {
    const parsed = SpecialistCritiqueSchema.parse(this.redactor.redactValue(critique));
    const result = this.database
      .transaction(() => {
        this.assertSpecialistSource(parsed.runId, parsed.source, {
          role: parsed.role,
          attempt: parsed.attempt,
          allowedStatuses: ['succeeded'],
        });
        this.assertEvidence(parsed.runId, parsed.evidenceIds);
        const activity = this.database
          .prepare('SELECT run_id FROM specialist_activities WHERE id = ?')
          .get(parsed.activityId) as { run_id: string } | undefined;
        if (!activity || activity.run_id !== parsed.runId) {
          throw new Error('Specialist critique subject does not belong to this run');
        }
        const source = sourceColumns(parsed.source);
        this.database
          .prepare(
            `INSERT INTO specialist_critiques(
              id, run_id, activity_id, role, verdict, summary, source_kind,
              provider_call_id, policy_worker_call_id, occurred_at, attempt,
              evidence_artifact_ids_json, action_required
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            parsed.id,
            parsed.runId,
            parsed.activityId,
            parsed.role,
            parsed.verdict,
            parsed.summary,
            source.kind,
            source.providerCallId,
            source.policyWorkerCallId,
            parsed.occurredAt,
            parsed.attempt,
            JSON.stringify(parsed.evidenceIds),
            parsed.actionRequired
          );
        return this.appendEventRecord(
          parsed.runId,
          {
            kind: 'specialist.critique',
            stage,
            payload: { critique: parsed },
            provenance: this.redactor.redactValue(provenance),
            artifactIds: parsed.evidenceIds,
          },
          undefined,
          true
        );
      })
      .immediate();
    if (result.created) this.notifyEvent(result.event);
    return parsed;
  }

  listSpecialistCritiques(runId: string): SpecialistCritique[] {
    const rows = this.database
      .prepare(
        `SELECT specialist_critiques.*, policy_worker_calls.worker AS source_worker
         FROM specialist_critiques
         LEFT JOIN policy_worker_calls
           ON policy_worker_calls.id = specialist_critiques.policy_worker_call_id
         WHERE specialist_critiques.run_id = ?
         ORDER BY specialist_critiques.occurred_at, specialist_critiques.id`
      )
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.parseSpecialistCritiqueRow(row));
  }

  recordSpecialistDecision(
    decision: SpecialistDecision,
    stage: RunStage,
    provenance: Provenance
  ): SpecialistDecision {
    const parsed = SpecialistDecisionSchema.parse(this.redactor.redactValue(decision));
    const result = this.database
      .transaction(() => {
        this.assertSpecialistSource(parsed.runId, parsed.source, {
          role: parsed.role,
          attempt: parsed.attempt,
          allowedStatuses: ['succeeded'],
        });
        this.assertEvidence(parsed.runId, parsed.evidenceIds);
        const source = sourceColumns(parsed.source);
        this.database
          .prepare(
            `INSERT INTO specialist_decisions(
              id, run_id, role, action, summary, source_kind, provider_call_id,
              policy_worker_call_id, occurred_at, attempt, evidence_artifact_ids_json,
              handoff_target
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            parsed.id,
            parsed.runId,
            parsed.role,
            parsed.action,
            parsed.summary,
            source.kind,
            source.providerCallId,
            source.policyWorkerCallId,
            parsed.occurredAt,
            parsed.attempt,
            JSON.stringify(parsed.evidenceIds),
            parsed.handoffTarget
          );
        return this.appendEventRecord(
          parsed.runId,
          {
            kind: 'specialist.decision',
            stage,
            payload: { decision: parsed },
            provenance: this.redactor.redactValue(provenance),
            artifactIds: parsed.evidenceIds,
          },
          undefined,
          true
        );
      })
      .immediate();
    if (result.created) this.notifyEvent(result.event);
    return parsed;
  }

  listSpecialistDecisions(runId: string): SpecialistDecision[] {
    const rows = this.database
      .prepare(
        `SELECT specialist_decisions.*, policy_worker_calls.worker AS source_worker
         FROM specialist_decisions
         LEFT JOIN policy_worker_calls
           ON policy_worker_calls.id = specialist_decisions.policy_worker_call_id
         WHERE specialist_decisions.run_id = ?
         ORDER BY specialist_decisions.occurred_at, specialist_decisions.id`
      )
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.parseSpecialistDecisionRow(row));
  }

  recordSpecialistObjection(
    objection: SpecialistObjection,
    stage: RunStage,
    provenance: Provenance
  ): SpecialistObjection {
    const parsed = SpecialistObjectionSchema.parse(this.redactor.redactValue(objection));
    const result = this.database
      .transaction(() => {
        this.assertSpecialistSource(parsed.runId, parsed.source, {
          role: parsed.role,
          attempt: parsed.attempt,
          allowedStatuses: ['succeeded'],
        });
        this.assertEvidence(parsed.runId, parsed.evidenceIds);
        if (parsed.activityId) {
          const activity = this.database
            .prepare('SELECT run_id FROM specialist_activities WHERE id = ?')
            .get(parsed.activityId) as { run_id: string } | undefined;
          if (!activity || activity.run_id !== parsed.runId) {
            throw new Error('Specialist objection subject does not belong to this run');
          }
        }
        return this.appendEventRecord(
          parsed.runId,
          {
            kind: 'specialist.objection',
            stage,
            payload: { objection: parsed },
            provenance: this.redactor.redactValue(provenance),
            artifactIds: parsed.evidenceIds,
          },
          undefined,
          true
        );
      })
      .immediate();
    if (result.created) this.notifyEvent(result.event);
    return parsed;
  }

  recordSpecialistHandoff(
    handoff: SpecialistHandoff,
    stage: RunStage,
    provenance: Provenance
  ): SpecialistHandoff {
    const parsed = SpecialistHandoffSchema.parse(this.redactor.redactValue(handoff));
    const result = this.database
      .transaction(() => {
        this.assertSpecialistSource(parsed.runId, parsed.source, {
          role: parsed.from,
          attempt: parsed.attempt,
          allowedStatuses: ['succeeded'],
        });
        this.assertEvidence(parsed.runId, parsed.evidenceIds);
        return this.appendEventRecord(
          parsed.runId,
          {
            kind: 'specialist.handoff',
            stage,
            payload: { handoff: parsed },
            provenance: this.redactor.redactValue(provenance),
            artifactIds: parsed.evidenceIds,
          },
          undefined,
          true
        );
      })
      .immediate();
    if (result.created) this.notifyEvent(result.event);
    return parsed;
  }

  upsertRunManifestContext(context: RunManifestContext): RunManifestContext {
    this.registerSecrets(context.commands.flatMap((command) => Object.values(command.env)));
    const parsed = RunManifestContextSchema.parse(
      this.redactor.redactValue({
        ...context,
        commands: context.commands.map((command) => ({
          ...command,
          env: Object.fromEntries(Object.keys(command.env).map((key) => [key, '[REDACTED]'])),
        })),
      })
    );
    if (serializedBytes(parsed) > 512 * 1_024) {
      throw new Error('Run manifest context exceeds the 512 KiB persistence limit');
    }
    this.database
      .prepare(
        `INSERT INTO run_manifest_contexts(
          run_id, config_digest, config_path, base_sha, head_sha, branch, worktree_path,
          commands_json, browser_checks_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          config_digest = excluded.config_digest,
          config_path = excluded.config_path,
          base_sha = excluded.base_sha,
          head_sha = excluded.head_sha,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          commands_json = excluded.commands_json,
          browser_checks_json = excluded.browser_checks_json,
          updated_at = excluded.updated_at`
      )
      .run(
        parsed.runId,
        parsed.configDigest,
        parsed.configPath,
        parsed.baseSha,
        parsed.headSha,
        parsed.branch,
        parsed.worktreePath,
        JSON.stringify(parsed.commands),
        JSON.stringify(parsed.browserChecks),
        parsed.updatedAt
      );
    return parsed;
  }

  getRunManifestContext(runId: string): RunManifestContext | null {
    const row = this.database
      .prepare('SELECT * FROM run_manifest_contexts WHERE run_id = ?')
      .get(runId) as Record<string, unknown> | undefined;
    return row
      ? RunManifestContextSchema.parse({
          runId: row.run_id,
          configDigest: row.config_digest,
          configPath: row.config_path,
          baseSha: row.base_sha,
          headSha: row.head_sha,
          branch: row.branch,
          worktreePath: row.worktree_path,
          commands: parseJson(String(row.commands_json)),
          browserChecks: parseJson(String(row.browser_checks_json)),
          updatedAt: row.updated_at,
        })
      : null;
  }

  readRunManifestSnapshot(runId: string): RunManifestSnapshot {
    return this.database.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} was not found`);
      return {
        run,
        context: this.getRunManifestContext(runId),
        events: this.listEvents(runId),
        artifacts: this.listArtifacts(runId),
        stageAttempts: this.listStageAttempts(runId),
        providerCalls: this.listProviderCalls(runId),
        policyWorkerCalls: this.listPolicyWorkerCalls(runId),
        specialistActivities: this.listSpecialistActivities(runId),
        specialistCritiques: this.listSpecialistCritiques(runId),
        specialistDecisions: this.listSpecialistDecisions(runId),
      };
    })();
  }

  recordRunManifest(
    record: Omit<RunManifestRecord, 'eventSequence'>,
    stage: RunStage,
    provenance: Provenance
  ): RunManifestRecord {
    const result = this.database
      .transaction(() => {
        const artifact = this.getArtifact(record.artifactId);
        if (!artifact || artifact.runId !== record.runId || artifact.kind !== 'manifest') {
          throw new Error(
            'Run manifest must reference a ready manifest artifact from the same run'
          );
        }
        if (artifact.sha256 !== record.sha256) {
          throw new Error('Run manifest checksum does not match its artifact');
        }
        const run = this.getRun(record.runId);
        if (!run || !TERMINAL_RUN_STATUSES.has(run.status) || run.stage !== stage) {
          throw new Error('Run manifests require the matching durable terminal run');
        }
        const appended = this.appendEventRecord(
          record.runId,
          {
            kind: 'run.manifest_created',
            stage,
            payload: {
              manifestId: record.id,
              artifactId: record.artifactId,
              sha256: record.sha256,
            },
            provenance: this.redactor.redactValue(provenance),
            artifactIds: [record.artifactId],
          },
          undefined,
          true
        );
        const parsed = RunManifestRecordSchema.parse({
          ...record,
          eventSequence: appended.event.sequence,
        });
        this.database
          .prepare(
            `INSERT INTO run_manifests(
              id, run_id, artifact_id, sha256, event_sequence, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            parsed.id,
            parsed.runId,
            parsed.artifactId,
            parsed.sha256,
            parsed.eventSequence,
            parsed.createdAt
          );
        return { record: parsed, ...appended };
      })
      .immediate();
    if (result.created) this.notifyEvent(result.event);
    return result.record;
  }

  getRunManifest(runId: string): RunManifestRecord | null {
    const row = this.database.prepare('SELECT * FROM run_manifests WHERE run_id = ?').get(runId) as
      Record<string, unknown> | undefined;
    return row
      ? RunManifestRecordSchema.parse({
          id: row.id,
          runId: row.run_id,
          artifactId: row.artifact_id,
          sha256: row.sha256,
          eventSequence: row.event_sequence,
          createdAt: row.created_at,
        })
      : null;
  }

  upsertIntegration(integration: Integration): Integration {
    const validated = IntegrationSchema.parse(integration);
    const redacted = this.redactor.redactValue(validated);
    const parsed = IntegrationSchema.parse({
      ...redacted,
      evidence: redacted.evidence?.map((item, index) => ({
        ...item,
        // This field is public evidence metadata, not an Authorization header.
        authorization: validated.evidence?.[index]?.authorization,
      })),
    });
    this.db
      .insert(schema.integrations)
      .values({
        id: parsed.id,
        provider: parsed.provider,
        status: parsed.status,
        detail: parsed.detail,
        requirementsJson: JSON.stringify(parsed.requirements ?? []),
        evidenceJson: JSON.stringify(parsed.evidence ?? []),
        provenanceJson: JSON.stringify(parsed.provenance),
        updatedAt: parsed.updatedAt,
      })
      .onConflictDoUpdate({
        target: schema.integrations.provider,
        set: {
          status: parsed.status,
          detail: parsed.detail,
          requirementsJson: JSON.stringify(parsed.requirements ?? []),
          evidenceJson: JSON.stringify(parsed.evidence ?? []),
          provenanceJson: JSON.stringify(parsed.provenance),
          updatedAt: parsed.updatedAt,
        },
      })
      .run();
    return parsed;
  }

  getIntegration(provider: string): Integration | null {
    const row = this.db.query.integrations
      .findFirst({ where: eq(schema.integrations.provider, provider) })
      .sync();
    return row
      ? IntegrationSchema.parse({
          ...row,
          requirements: parseJson(row.requirementsJson),
          evidence: parseJson(row.evidenceJson),
          provenance: parseJson(row.provenanceJson),
        })
      : null;
  }

  listIntegrations(): Integration[] {
    return this.db
      .select()
      .from(schema.integrations)
      .orderBy(schema.integrations.provider)
      .all()
      .map((row) =>
        IntegrationSchema.parse({
          ...row,
          requirements: parseJson(row.requirementsJson),
          evidence: parseJson(row.evidenceJson),
          provenance: parseJson(row.provenanceJson),
        })
      );
  }

  importKnowledgeEntries(entries: KnowledgeEntry[]): number {
    return this.database.transaction(() => {
      let imported = 0;
      for (const entry of entries) {
        const parsed = KnowledgeEntrySchema.parse(this.redactor.redactValue(entry));
        const result = this.db
          .insert(schema.knowledgeEntries)
          .values({ ...parsed, provenanceJson: JSON.stringify(parsed.provenance) })
          .onConflictDoNothing()
          .run();
        imported += result.changes;
      }
      return imported;
    })();
  }

  listKnowledgeEntries(): KnowledgeEntry[] {
    return this.db
      .select()
      .from(schema.knowledgeEntries)
      .orderBy(desc(schema.knowledgeEntries.importedAt))
      .all()
      .map((row) =>
        KnowledgeEntrySchema.parse({ ...row, provenance: parseJson(row.provenanceJson) })
      );
  }

  acquireLease(projectId: string, runId: string, ttlMs = 60_000, ownerPid = process.pid): boolean {
    return this.database.transaction(() => {
      const timestamp = Date.now();
      const current = this.db.query.projectLeases
        .findFirst({ where: eq(schema.projectLeases.projectId, projectId) })
        .sync();
      if (current && (current.runId !== runId || current.ownerPid !== ownerPid)) {
        return false;
      }
      this.db
        .insert(schema.projectLeases)
        .values({
          projectId,
          runId,
          ownerPid,
          expiresAt: new Date(timestamp + ttlMs).toISOString(),
        })
        .onConflictDoUpdate({
          target: schema.projectLeases.projectId,
          set: {
            runId,
            ownerPid,
            expiresAt: new Date(timestamp + ttlMs).toISOString(),
          },
        })
        .run();
      return true;
    })();
  }

  takeoverLeaseForRecovery(
    projectId: string,
    runId: string,
    ttlMs = 60_000,
    ownerPid = process.pid
  ): boolean {
    return this.database.transaction(() => {
      const current = this.db.query.projectLeases
        .findFirst({ where: eq(schema.projectLeases.projectId, projectId) })
        .sync();
      if (
        !current ||
        current.runId !== runId ||
        current.ownerPid === ownerPid ||
        isProcessAlive(current.ownerPid)
      ) {
        return false;
      }
      const result = this.db
        .update(schema.projectLeases)
        .set({
          ownerPid,
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        })
        .where(
          and(
            eq(schema.projectLeases.projectId, projectId),
            eq(schema.projectLeases.runId, runId),
            eq(schema.projectLeases.ownerPid, current.ownerPid)
          )
        )
        .run();
      return result.changes === 1;
    })();
  }

  renewLease(projectId: string, runId: string, ttlMs = 60_000, ownerPid = process.pid): boolean {
    const result = this.db
      .update(schema.projectLeases)
      .set({ expiresAt: new Date(Date.now() + ttlMs).toISOString(), ownerPid })
      .where(
        and(
          eq(schema.projectLeases.projectId, projectId),
          eq(schema.projectLeases.runId, runId),
          eq(schema.projectLeases.ownerPid, ownerPid)
        )
      )
      .run();
    return result.changes === 1;
  }

  releaseLease(projectId: string, runId: string, ownerPid = process.pid): void {
    this.db
      .delete(schema.projectLeases)
      .where(
        and(
          eq(schema.projectLeases.projectId, projectId),
          eq(schema.projectLeases.runId, runId),
          eq(schema.projectLeases.ownerPid, ownerPid)
        )
      )
      .run();
  }

  private appendEventRecord(
    runId: string,
    event: NewRunEvent,
    idempotencyKey?: string,
    validatedLifecycle = false
  ): { event: RunEvent; created: boolean } {
    if (VALIDATED_LIFECYCLE_EVENT_KINDS.has(event.kind) && !validatedLifecycle) {
      throw new Error(
        `${event.kind} must be persisted through its validated lifecycle storage method`
      );
    }
    if (idempotencyKey !== undefined) {
      if (!idempotencyKey || idempotencyKey.length > 256) {
        throw new Error('Event idempotency key must be between 1 and 256 characters');
      }
      const existing = this.database
        .prepare('SELECT * FROM run_events WHERE run_id = ? AND idempotency_key = ?')
        .get(runId, idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) return { event: this.parseEventRow(existing), created: false };
    }

    const allocation = this.database
      .prepare(
        `UPDATE runs
         SET last_event_sequence = last_event_sequence + 1
         WHERE id = ?
         RETURNING last_event_sequence`
      )
      .get(runId) as { last_event_sequence: number } | undefined;
    if (!allocation) throw new Error(`Run ${runId} was not found`);
    const sanitized = this.sanitizeEvent(event);
    const candidate = {
      ...sanitized,
      schemaVersion: 1 as const,
      id: randomUUID(),
      runId,
      sequence: allocation.last_event_sequence,
      occurredAt: now(),
    };
    const parsed = RunEventSchema.parse(candidate);
    if (serializedBytes(parsed) > 64 * 1_024) {
      throw new Error('Run event exceeds the 64 KiB persistence limit');
    }
    this.assertEvidence(runId, parsed.artifactIds);
    if (parsed.kind === 'terminal.evidence') {
      this.assertEvidence(parsed.runId, [
        ...parsed.payload.evidence.artifactIds,
        ...parsed.payload.evidence.evidenceLinks.map((link) => link.artifactId),
      ]);
    }
    this.database
      .prepare(
        `INSERT INTO run_events(
          id, run_id, sequence, stage, kind, occurred_at, provenance_json,
          artifact_ids_json, payload_json, schema_version, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        parsed.id,
        parsed.runId,
        parsed.sequence,
        parsed.stage,
        parsed.kind,
        parsed.occurredAt,
        JSON.stringify(parsed.provenance),
        JSON.stringify(parsed.artifactIds),
        JSON.stringify(parsed.payload),
        parsed.schemaVersion,
        idempotencyKey ?? null
      );
    const projection = this.reduceProjection(this.readProjection(runId), parsed);
    this.writeProjection(projection);
    return { event: parsed, created: true };
  }

  private findEventByIdempotencyKey(runId: string, idempotencyKey: string): RunEvent | null {
    const row = this.database
      .prepare('SELECT * FROM run_events WHERE run_id = ? AND idempotency_key = ?')
      .get(runId, idempotencyKey) as Record<string, unknown> | undefined;
    return row ? this.parseEventRow(row) : null;
  }

  private parseEventRow(row: Record<string, unknown>): RunEvent {
    return RunEventSchema.parse({
      schemaVersion: Number(row.schema_version ?? 1),
      id: row.id,
      runId: row.run_id,
      sequence: row.sequence,
      stage: row.stage,
      kind: row.kind,
      occurredAt: row.occurred_at,
      provenance: parseJson(String(row.provenance_json)),
      artifactIds: parseJson(String(row.artifact_ids_json)),
      payload: parseJson(String(row.payload_json)),
    });
  }

  private notifyEvent(event: RunEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // A committed durability write must not be reported as failed by a live subscriber.
      }
    }
  }

  private updateRunRecord(runId: string, update: RunUpdate): void {
    const sanitized: RunUpdate = {
      ...update,
      summary: update.summary === undefined ? undefined : this.redactNullable(update.summary),
      error: update.error === undefined ? undefined : this.redactNullable(update.error),
      intervention:
        update.intervention === undefined
          ? undefined
          : this.redactor.redactValue(update.intervention),
    };
    const { availableActions, intervention, ...record } = sanitized;
    const values: Partial<typeof schema.runs.$inferInsert> = {
      ...record,
      updatedAt: now(),
    };
    if (availableActions !== undefined)
      values.availableActionsJson = JSON.stringify(availableActions);
    if (intervention !== undefined) {
      values.interventionJson = intervention ? JSON.stringify(intervention) : null;
    }
    const result = this.db.update(schema.runs).set(values).where(eq(schema.runs.id, runId)).run();
    if (result.changes !== 1) throw new Error(`Run ${runId} was not found`);
  }

  private redactNullable(value: string | null): string | null {
    return value === null ? null : this.redactor.redactText(value).text.slice(0, 4_096);
  }

  private sanitizeEvent(event: NewRunEvent): NewRunEvent {
    const sanitized = this.redactor.redactValue(event);
    const sanitizedPayload = sanitized.payload as Record<string, unknown>;
    if (typeof sanitizedPayload.message === 'string') {
      sanitizedPayload.message = sanitizedPayload.message.slice(0, 4_096);
    }
    if (
      event.kind !== 'command.output' &&
      event.kind !== 'command.failed' &&
      event.kind !== 'command.cancelled'
    ) {
      return sanitized;
    }
    const previous = event.payload.output;
    const bounded = this.redactor.boundedOutput(previous.text);
    const omittedBytes = previous.omittedBytes + bounded.omittedBytes;
    return {
      ...sanitized,
      payload: {
        ...sanitized.payload,
        output: {
          ...bounded,
          originalBytes: bounded.originalBytes + previous.omittedBytes,
          omittedBytes,
          truncated: omittedBytes > 0,
          redactionCount: previous.redactionCount + bounded.redactionCount,
          backpressure:
            omittedBytes > 0
              ? {
                  droppedChunks:
                    (previous.backpressure?.droppedChunks ?? 0) +
                    (bounded.backpressure?.droppedChunks ?? 0),
                  droppedBytes: omittedBytes,
                }
              : null,
        },
      },
    } as NewRunEvent;
  }

  private readProjection(runId: string): RunProjection {
    const row = this.database
      .prepare('SELECT projection_json FROM run_projections WHERE run_id = ?')
      .get(runId) as { projection_json: string } | undefined;
    return row
      ? RunProjectionSchema.parse(parseJson(row.projection_json))
      : this.initialProjection(runId);
  }

  private initialProjection(runId: string): RunProjection {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found`);
    return RunProjectionSchema.parse({
      schemaVersion: 1,
      runId,
      status: run.status,
      stage: run.stage,
      attempt: run.attempt,
      currentAction: null,
      waitingOn: null,
      activeStageAttemptId: null,
      activeCommandId: null,
      activeServiceId: null,
      activeProviderCallId: null,
      activeBrowserSessionId: null,
      activeSpecialistActivityId: null,
      recoveryState: run.status === 'interrupted' ? 'required' : 'none',
      lastEventSequence: 0,
      lastHeartbeatAt: run.lastHeartbeatAt,
      updatedAt: run.updatedAt,
    });
  }

  private overlayProjectionRunState(projection: RunProjection, run: Run): RunProjection {
    return RunProjectionSchema.parse({
      ...projection,
      status: run.status,
      stage: run.stage,
      attempt: run.attempt,
      lastHeartbeatAt: run.lastHeartbeatAt ?? projection.lastHeartbeatAt,
    });
  }

  private reduceProjection(current: RunProjection, event: RunEvent): RunProjection {
    const next: RunProjection = {
      ...current,
      stage: event.stage,
      lastEventSequence: event.sequence,
      updatedAt: event.occurredAt,
    };
    const action = (
      kind: RunProjection['currentAction'] extends infer T
        ? T extends { kind: infer K }
          ? K
          : never
        : never,
      id: string,
      summary: string,
      status: 'running' | 'waiting' | 'retrying' | 'recovering' | 'terminal',
      attempt = current.attempt
    ) => ({
      kind,
      id,
      summary: summary.slice(0, 2_048),
      status,
      source: event.provenance,
      startedAt: event.occurredAt,
      attempt,
      evidenceIds: event.artifactIds,
    });
    const parentAction = (): RunProjection['currentAction'] => {
      if (next.activeServiceId) {
        return action(
          'target_service',
          next.activeServiceId,
          'Target service remains ready',
          'running'
        );
      }
      if (next.activeStageAttemptId) {
        return action('stage', next.activeStageAttemptId, `Continuing ${event.stage}`, 'running');
      }
      return null;
    };

    switch (event.kind) {
      case 'run.created':
      case 'stage.started':
        next.currentAction = action(
          'stage',
          'stageAttemptId' in event.payload ? (event.payload.stageAttemptId ?? event.id) : event.id,
          event.payload.message,
          'running',
          'attempt' in event.payload ? (event.payload.attempt ?? current.attempt) : current.attempt
        );
        next.activeStageAttemptId =
          'stageAttemptId' in event.payload ? (event.payload.stageAttemptId ?? null) : null;
        next.waitingOn = null;
        break;
      case 'stage.completed':
        next.currentAction = null;
        next.activeStageAttemptId = null;
        next.waitingOn = null;
        break;
      case 'stage.retry_scheduled':
        next.currentAction = action(
          'stage',
          event.payload.stageAttemptId,
          event.payload.reason,
          'retrying',
          event.payload.nextAttempt
        );
        next.waitingOn = {
          kind: 'retry_delay',
          summary: event.payload.reason,
          since: event.occurredAt,
          nextRetryAt: event.payload.nextRetryAt,
          evidenceIds: event.artifactIds,
        };
        break;
      case 'stage.heartbeat':
        next.lastHeartbeatAt = event.payload.heartbeatAt;
        if (!next.currentAction || next.currentAction.kind === 'stage') {
          next.currentAction = action(
            'stage',
            event.payload.stageAttemptId,
            event.payload.currentAction,
            event.payload.waitingOn ? 'waiting' : 'running',
            event.payload.attempt
          );
        }
        next.waitingOn = event.payload.waitingOn
          ? {
              kind: 'policy',
              summary: event.payload.waitingOn,
              since: event.occurredAt,
              nextRetryAt: null,
              evidenceIds: event.artifactIds,
            }
          : null;
        break;
      case 'command.started': {
        const commandId =
          'commandId' in event.payload ? (event.payload.commandId ?? event.id) : event.id;
        next.activeCommandId = commandId;
        next.currentAction = action(
          'command',
          commandId,
          `Running ${event.payload.executable}`,
          'running',
          'attempt' in event.payload ? (event.payload.attempt ?? current.attempt) : current.attempt
        );
        break;
      }
      case 'command.completed':
      case 'command.failed':
      case 'command.cancelled':
        next.activeCommandId = null;
        next.currentAction = parentAction();
        break;
      case 'target.service_started':
        next.activeServiceId = event.payload.serviceId;
        next.currentAction = action(
          'target_service',
          event.payload.serviceId,
          `Starting ${event.payload.executable}`,
          'waiting',
          event.payload.attempt
        );
        next.waitingOn = {
          kind: 'service_readiness',
          summary: 'Waiting for target service readiness',
          since: event.occurredAt,
          nextRetryAt: null,
          evidenceIds: event.artifactIds,
        };
        break;
      case 'target.service_ready':
        next.activeServiceId = event.payload.serviceId;
        next.currentAction = action(
          'target_service',
          event.payload.serviceId,
          `Target service ready at ${event.payload.healthUrl}`,
          'running',
          event.payload.attempt
        );
        next.waitingOn = null;
        break;
      case 'target.service_exited':
      case 'target.service_failed':
        next.activeServiceId = null;
        next.currentAction = parentAction();
        next.waitingOn = null;
        break;
      case 'model.call_started':
        next.activeProviderCallId = event.payload.providerCallId;
        next.currentAction = action(
          'model_call',
          event.payload.providerCallId,
          `${event.payload.specialistRole} provider call`,
          'waiting',
          event.payload.attempt
        );
        next.waitingOn = {
          kind: 'provider',
          summary: `Waiting for ${event.payload.provider}/${event.payload.model}`,
          since: event.occurredAt,
          nextRetryAt: null,
          evidenceIds: event.artifactIds,
        };
        break;
      case 'model.call_completed':
      case 'model.call_failed':
      case 'model.call_cancelled':
        next.activeProviderCallId = null;
        next.currentAction = parentAction();
        next.waitingOn = null;
        break;
      case 'browser.session_started':
        next.activeBrowserSessionId = event.payload.sessionId;
        next.currentAction = action(
          'browser',
          event.payload.sessionId,
          `Starting ${event.payload.browserName}`,
          'waiting',
          event.payload.attempt
        );
        next.waitingOn = {
          kind: 'browser',
          summary: 'Waiting for browser session',
          since: event.occurredAt,
          nextRetryAt: null,
          evidenceIds: event.artifactIds,
        };
        break;
      case 'browser.navigation_started':
        next.currentAction = action(
          'browser',
          event.payload.navigationId,
          `Navigating to ${event.payload.url}`,
          'running',
          event.payload.attempt
        );
        break;
      case 'browser.navigation_completed':
        next.currentAction = action(
          'browser',
          event.payload.sessionId,
          `Browser reached ${event.payload.finalUrl}`,
          'running'
        );
        next.waitingOn = null;
        break;
      case 'browser.action_started':
        next.currentAction = action(
          'browser',
          event.payload.actionId,
          event.payload.summary,
          'running',
          event.payload.attempt
        );
        break;
      case 'browser.action_completed':
        next.currentAction = action(
          'browser',
          event.payload.sessionId,
          event.payload.summary,
          'running'
        );
        break;
      case 'browser.checkpoint':
        next.currentAction = action(
          'browser',
          event.payload.checkpointId,
          `Captured ${event.payload.flow}`,
          'running',
          event.payload.attempt
        );
        break;
      case 'browser.session_closed':
      case 'browser.failed':
        next.activeBrowserSessionId = null;
        next.currentAction = parentAction();
        next.waitingOn = null;
        break;
      case 'publication.updated':
        if (event.stage === 'wait_checks') {
          next.currentAction = action(
            'policy',
            event.id,
            event.payload.detail ?? `Publication ${event.payload.state}`,
            'waiting'
          );
          next.waitingOn = {
            kind: 'repository_checks',
            summary: event.payload.detail ?? 'Waiting for repository checks',
            since: event.occurredAt,
            nextRetryAt: null,
            evidenceIds: event.artifactIds,
          };
        }
        break;
      case 'specialist.activity':
        next.activeSpecialistActivityId =
          event.payload.activity.status === 'started' ? event.payload.activity.id : null;
        next.currentAction =
          event.payload.activity.status === 'started'
            ? action(
                'specialist',
                event.payload.activity.id,
                event.payload.activity.summary,
                'running',
                event.payload.activity.attempt
              )
            : next.currentAction?.kind === 'specialist'
              ? null
              : next.currentAction;
        break;
      case 'recovery.started':
        next.recoveryState = 'recovering';
        next.currentAction = action(
          'recovery',
          event.payload.recoveryId,
          'Recovering interrupted action',
          'recovering',
          event.payload.attempt
        );
        break;
      case 'recovery.completed':
        next.recoveryState = 'resumed';
        next.currentAction = null;
        next.waitingOn = null;
        break;
      case 'recovery.failed':
        next.recoveryState = 'failed';
        next.currentAction = action(
          'recovery',
          event.payload.recoveryId,
          event.payload.error ?? event.payload.currentAction,
          'terminal'
        );
        break;
      case 'run.completed':
      case 'run.failed':
      case 'run.cancelled':
      case 'run.policy_blocked':
        next.currentAction = action('terminal', event.id, event.payload.message, 'terminal');
        next.waitingOn = null;
        next.activeStageAttemptId = null;
        next.activeCommandId = null;
        next.activeServiceId = null;
        next.activeProviderCallId = null;
        next.activeBrowserSessionId = null;
        next.activeSpecialistActivityId = null;
        break;
    }
    const run = this.getRun(event.runId);
    if (run) {
      next.status = run.status;
      next.stage = run.stage;
      next.attempt = run.attempt;
    }
    return RunProjectionSchema.parse(next);
  }

  private writeProjection(projection: RunProjection): void {
    const parsed = RunProjectionSchema.parse(projection);
    if (serializedBytes(parsed) > 64 * 1_024) {
      throw new Error('Run projection exceeds the 64 KiB persistence limit');
    }
    this.database
      .prepare(
        `INSERT INTO run_projections(
          run_id, schema_version, applied_sequence, projection_json, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          applied_sequence = excluded.applied_sequence,
          projection_json = excluded.projection_json,
          updated_at = excluded.updated_at`
      )
      .run(
        parsed.runId,
        parsed.schemaVersion,
        parsed.lastEventSequence,
        JSON.stringify(parsed),
        parsed.updatedAt
      );
  }

  private insertStageAttempt(attempt: StageAttempt): void {
    this.database
      .prepare(
        `INSERT INTO stage_attempts(
          id, run_id, stage, attempt, status, summary, waiting_on, next_retry_at,
          last_heartbeat_at, started_at, completed_at, evidence_artifact_ids_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        attempt.id,
        attempt.runId,
        attempt.stage,
        attempt.attempt,
        attempt.status,
        attempt.summary,
        attempt.waitingOn,
        attempt.nextRetryAt,
        attempt.lastHeartbeatAt,
        attempt.startedAt,
        attempt.completedAt,
        JSON.stringify(attempt.evidenceIds)
      );
  }

  private parseStageAttemptRow(row: Record<string, unknown>): StageAttempt {
    return StageAttemptSchema.parse({
      id: row.id,
      runId: row.run_id,
      stage: row.stage,
      attempt: row.attempt,
      status: row.status,
      summary: row.summary,
      waitingOn: row.waiting_on,
      nextRetryAt: row.next_retry_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      evidenceIds: parseJson(String(row.evidence_artifact_ids_json)),
    });
  }

  private assertEvidence(runId: string, evidenceIds: string[]): void {
    for (const artifactId of new Set(evidenceIds)) {
      const artifact = this.getArtifact(artifactId);
      if (!artifact || artifact.runId !== runId) {
        throw new Error(`Evidence artifact ${artifactId} is not ready for run ${runId}`);
      }
      this.assertArtifactFileIntegrity(artifact);
    }
  }

  private assertArtifactFileIntegrity(artifact: Artifact): void {
    let bytes: Buffer;
    try {
      const stat = statSync(artifact.path);
      if (!stat.isFile() || stat.size !== artifact.bytes) {
        throw new Error('Artifact file metadata does not match its durable record');
      }
      bytes = readFileSync(artifact.path);
    } catch (error) {
      if (error instanceof Error && error.message.includes('metadata does not match')) throw error;
      throw new Error(`Artifact ${artifact.id} is not backed by a readable file`, { cause: error });
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== artifact.sha256) {
      throw new Error(`Artifact ${artifact.id} checksum does not match its file`);
    }
  }

  private assertSpecialistSource(
    runId: string,
    source: SpecialistActivity['source'],
    expectation: {
      role: SpecialistActivity['role'];
      attempt: number;
      allowedStatuses: Array<'started' | 'succeeded' | 'failed' | 'cancelled'>;
    }
  ): void {
    if (source.kind === 'provider_call') {
      const row = this.database
        .prepare(
          `SELECT run_id, status, attempt, specialist_role, request_digest, response_digest,
                  error, started_at, completed_at
           FROM provider_calls
           WHERE id = ?`
        )
        .get(source.providerCallId) as
        | {
            run_id: string;
            status: 'started' | 'succeeded' | 'failed' | 'cancelled';
            attempt: number;
            specialist_role: SpecialistActivity['role'] | null;
            request_digest: string | null;
            response_digest: string | null;
            error: string | null;
            started_at: string | null;
            completed_at: string | null;
          }
        | undefined;
      if (
        !row ||
        row.run_id !== runId ||
        row.attempt !== expectation.attempt ||
        row.specialist_role !== expectation.role ||
        !expectation.allowedStatuses.includes(row.status) ||
        row.request_digest === null ||
        row.started_at === null ||
        (row.status !== 'started' && row.completed_at === null) ||
        (row.status === 'succeeded' && row.response_digest === null) ||
        ((row.status === 'failed' || row.status === 'cancelled') && row.error === null)
      ) {
        throw new Error('Specialist provider call source does not belong to this run');
      }
      const lifecycleEvents = this.database
        .prepare(
          `SELECT kind
           FROM run_events
           WHERE run_id = ?
             AND kind IN (
               'model.call_started',
               'model.call_completed',
               'model.call_failed',
               'model.call_cancelled'
             )
             AND json_extract(payload_json, '$.providerCallId') = ?
           ORDER BY sequence`
        )
        .all(runId, source.providerCallId) as Array<{ kind: RunEventKind }>;
      const expectedTerminalKind =
        row.status === 'succeeded'
          ? 'model.call_completed'
          : row.status === 'failed'
            ? 'model.call_failed'
            : row.status === 'cancelled'
              ? 'model.call_cancelled'
              : null;
      if (
        lifecycleEvents[0]?.kind !== 'model.call_started' ||
        (expectedTerminalKind === null
          ? lifecycleEvents.length !== 1
          : lifecycleEvents.length !== 2 || lifecycleEvents[1]?.kind !== expectedTerminalKind)
      ) {
        throw new Error('Specialist provider call source lacks its validated lifecycle events');
      }
      return;
    }
    const row = this.database
      .prepare('SELECT run_id, worker, status, attempt FROM policy_worker_calls WHERE id = ?')
      .get(source.invocationId) as
      | {
          run_id: string;
          worker: string;
          status: 'started' | 'succeeded' | 'failed' | 'cancelled';
          attempt: number;
        }
      | undefined;
    if (
      !row ||
      row.run_id !== runId ||
      row.worker !== source.worker ||
      row.worker !== `qagent.specialist.${expectation.role}` ||
      row.attempt !== expectation.attempt ||
      !expectation.allowedStatuses.includes(row.status)
    ) {
      throw new Error('Specialist policy worker source does not belong to this run');
    }
  }

  private parseSpecialistActivityRow(row: Record<string, unknown>): SpecialistActivity {
    return SpecialistActivitySchema.parse({
      id: row.id,
      runId: row.run_id,
      role: row.role,
      status: row.status,
      summary: row.summary,
      source: parseSource(row),
      occurredAt: row.occurred_at,
      attempt: row.attempt,
      evidenceIds: parseJson(String(row.evidence_artifact_ids_json)),
      handoffTarget: row.handoff_target,
    });
  }

  private parseSpecialistCritiqueRow(row: Record<string, unknown>): SpecialistCritique {
    return SpecialistCritiqueSchema.parse({
      id: row.id,
      runId: row.run_id,
      activityId: row.activity_id,
      role: row.role,
      verdict: row.verdict,
      summary: row.summary,
      source: parseSource(row),
      occurredAt: row.occurred_at,
      attempt: row.attempt,
      evidenceIds: parseJson(String(row.evidence_artifact_ids_json)),
      actionRequired: row.action_required,
    });
  }

  private parseSpecialistDecisionRow(row: Record<string, unknown>): SpecialistDecision {
    return SpecialistDecisionSchema.parse({
      id: row.id,
      runId: row.run_id,
      role: row.role,
      action: row.action,
      summary: row.summary,
      source: parseSource(row),
      occurredAt: row.occurred_at,
      attempt: row.attempt,
      evidenceIds: parseJson(String(row.evidence_artifact_ids_json)),
      handoffTarget: row.handoff_target,
    });
  }

  private assertProviderStartEvent(call: ProviderCall, event: ModelStartedEvent): void {
    if (
      event.payload.providerCallId !== call.id ||
      event.payload.provider !== call.provider ||
      event.payload.model !== call.model ||
      event.payload.purpose !== call.purpose ||
      event.payload.attempt !== (call.attempt ?? 1) ||
      event.payload.specialistRole !== call.specialistRole
    ) {
      throw new Error('Provider start event does not match its durable provider call');
    }
  }

  private assertProviderTerminalEvent(call: ProviderCall, event: ModelTerminalEvent): void {
    const expectedKind =
      call.status === 'succeeded'
        ? 'model.call_completed'
        : call.status === 'cancelled'
          ? 'model.call_cancelled'
          : 'model.call_failed';
    const usageMatches =
      event.payload.inputTokens === call.inputTokens &&
      event.payload.outputTokens === call.outputTokens &&
      event.payload.costUsd === call.costUsd;
    const durationMatches =
      call.durationMs !== undefined &&
      call.durationMs !== null &&
      event.payload.durationMs === call.durationMs;
    const errorMatches =
      event.kind === 'model.call_completed'
        ? call.error === null
        : call.error !== null && event.payload.error === call.error;
    if (
      event.kind !== expectedKind ||
      event.payload.providerCallId !== call.id ||
      !usageMatches ||
      !durationMatches ||
      !errorMatches
    ) {
      throw new Error('Provider terminal event does not match its durable provider call');
    }
  }

  private sanitizeProviderCall(call: ProviderCall): ProviderCall {
    return ProviderCallSchema.parse({
      ...call,
      provider: this.redactor.redactText(call.provider).text.slice(0, 256),
      model: this.redactor.redactText(call.model).text.slice(0, 512),
      error: call.error === null ? null : this.redactor.redactText(call.error).text.slice(0, 4_096),
    });
  }

  private parseProviderCallRow(row: typeof schema.providerCalls.$inferSelect): ProviderCall {
    return ProviderCallSchema.parse({
      ...row,
      costUsd: row.costUsdMicros === null ? null : row.costUsdMicros / 1_000_000,
      evidenceIds: parseJson(row.evidenceArtifactIdsJson),
    });
  }

  private insertProviderCall(call: ProviderCall): void {
    const startedAt = call.startedAt ?? call.createdAt;
    const completedAt =
      call.completedAt === undefined
        ? call.status === 'started'
          ? null
          : call.createdAt
        : call.completedAt;
    this.database
      .prepare(
        `INSERT INTO provider_calls(
          id, run_id, provider, model, purpose, status, input_tokens, output_tokens,
          cost_usd_micros, error, created_at, attempt, started_at, completed_at,
          duration_ms, specialist_role, evidence_artifact_ids_json, request_digest,
          response_digest, error_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        call.id,
        call.runId,
        call.provider,
        call.model,
        call.purpose,
        call.status,
        call.inputTokens,
        call.outputTokens,
        call.costUsd === null ? null : Math.round(call.costUsd * 1_000_000),
        call.error,
        call.createdAt,
        call.attempt ?? 1,
        startedAt,
        completedAt,
        call.durationMs ?? null,
        call.specialistRole ?? null,
        JSON.stringify(call.evidenceIds ?? []),
        call.requestDigest ?? null,
        call.responseDigest ?? null,
        call.errorCode ?? null
      );
  }
}

interface CursorPayload {
  v: 1;
  runId: string;
  sequence: number;
}

function encodeCursor(runId: string, sequence: number): string {
  return Buffer.from(JSON.stringify({ v: 1, runId, sequence } satisfies CursorPayload)).toString(
    'base64url'
  );
}

function decodeCursor(value: string): CursorPayload {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8')
    ) as Partial<CursorPayload>;
    if (
      parsed.v !== 1 ||
      typeof parsed.runId !== 'string' ||
      typeof parsed.sequence !== 'number' ||
      !Number.isInteger(parsed.sequence) ||
      parsed.sequence < 0
    ) {
      throw new Error('invalid cursor payload');
    }
    return parsed as CursorPayload;
  } catch {
    throw new Error('Run event cursor is malformed');
  }
}

function sourceColumns(source: SpecialistActivity['source']): {
  kind: string;
  providerCallId: string | null;
  policyWorkerCallId: string | null;
} {
  return source.kind === 'provider_call'
    ? {
        kind: source.kind,
        providerCallId: source.providerCallId,
        policyWorkerCallId: null,
      }
    : {
        kind: source.kind,
        providerCallId: null,
        policyWorkerCallId: source.invocationId,
      };
}

function parseSource(row: Record<string, unknown>): SpecialistActivity['source'] {
  return row.source_kind === 'provider_call'
    ? { kind: 'provider_call', providerCallId: String(row.provider_call_id) }
    : {
        kind: 'policy_worker',
        worker: String(
          row.source_worker ??
            (() => {
              throw new Error('Policy worker source row is missing worker identity');
            })()
        ),
        invocationId: String(row.policy_worker_call_id),
      };
}
