import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Artifact,
  Diagnosis,
  Integration,
  KnowledgeEntry,
  Patch,
  Project,
  ProviderCall,
  Run,
  RunEvent,
  RunEventKind,
  RunStage,
  RunStatus,
  TestCase,
  Verification,
} from '@qagent/contracts';
import {
  ArtifactSchema,
  DiagnosisSchema,
  IntegrationSchema,
  KnowledgeEntrySchema,
  PatchSchema,
  ProjectSchema,
  ProviderCallSchema,
  RunEventSchema,
  RunSchema,
  TestCaseSchema,
  VerificationSchema,
} from '@qagent/contracts';
import Database from 'better-sqlite3';
import { and, desc, eq, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { runMigrations } from './migrations.js';
import * as schema from './schema.js';

export type NewRunEvent = {
  [K in RunEventKind]: Omit<
    Extract<RunEvent, { kind: K }>,
    'id' | 'runId' | 'schemaVersion' | 'sequence' | 'occurredAt'
  >;
}[RunEventKind];

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
  completedAt?: string | null;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function now(): string {
  return new Date().toISOString();
}

export class QAgentStorage {
  private readonly database: Database.Database;
  private readonly db: ReturnType<typeof drizzle<typeof schema>>;

  constructor(readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('busy_timeout = 5000');
    runMigrations(this.database);
    this.db = drizzle(this.database, { schema });
  }

  close(): void {
    this.database.close();
  }

  createProject(input: CreateProjectInput): Project {
    const timestamp = now();
    const project: Project = {
      id: randomUUID(),
      name: input.name,
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

  createRun(input: Pick<Run, 'projectId' | 'requestedBy'>): Run {
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
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };
    this.db.insert(schema.runs).values(run).run();
    return RunSchema.parse(run);
  }

  getRun(runId: string): Run | null {
    const row = this.db.query.runs.findFirst({ where: eq(schema.runs.id, runId) }).sync();
    return row ? RunSchema.parse(row) : null;
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
    return rows.map((row) => RunSchema.parse(row));
  }

  listInterruptedRuns(): Run[] {
    return this.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.status, 'running'))
      .all()
      .map((row) => RunSchema.parse(row));
  }

  updateRun(runId: string, update: RunUpdate): Run {
    this.db
      .update(schema.runs)
      .set({ ...update, updatedAt: now() })
      .where(eq(schema.runs.id, runId))
      .run();
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found`);
    return run;
  }

  requestRunCancellation(runId: string): Run {
    return this.updateRun(runId, { cancelRequestedAt: now() });
  }

  appendEvent(runId: string, event: NewRunEvent): RunEvent {
    return this.database.transaction(() => {
      const row = this.database
        .prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM run_events WHERE run_id = ?')
        .get(runId) as { sequence: number };
      const candidate = {
        ...event,
        schemaVersion: 1 as const,
        id: randomUUID(),
        runId,
        sequence: row.sequence + 1,
        occurredAt: now(),
      };
      const parsed = RunEventSchema.parse(candidate);
      this.db
        .insert(schema.runEvents)
        .values({
          id: parsed.id,
          runId: parsed.runId,
          sequence: parsed.sequence,
          stage: parsed.stage,
          kind: parsed.kind,
          occurredAt: parsed.occurredAt,
          provenanceJson: JSON.stringify(parsed.provenance),
          artifactIdsJson: JSON.stringify(parsed.artifactIds),
          payloadJson: JSON.stringify(parsed.payload),
        })
        .run();
      return parsed;
    })();
  }

  listEvents(runId: string, afterSequence = 0): RunEvent[] {
    const rows = this.database
      .prepare('SELECT * FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence')
      .all(runId, afterSequence) as Array<Record<string, unknown>>;
    return rows.map((row) =>
      RunEventSchema.parse({
        schemaVersion: 1,
        id: row.id,
        runId: row.run_id,
        sequence: row.sequence,
        stage: row.stage,
        kind: row.kind,
        occurredAt: row.occurred_at,
        provenance: parseJson(String(row.provenance_json)),
        artifactIds: parseJson(String(row.artifact_ids_json)),
        payload: parseJson(String(row.payload_json)),
      })
    );
  }

  createArtifact(artifact: Artifact): Artifact {
    const parsed = ArtifactSchema.parse(artifact);
    this.db
      .insert(schema.artifacts)
      .values({
        ...parsed,
        provenanceJson: JSON.stringify(parsed.provenance),
      })
      .run();
    return parsed;
  }

  getArtifact(artifactId: string): Artifact | null {
    const row = this.db.query.artifacts
      .findFirst({ where: eq(schema.artifacts.id, artifactId) })
      .sync();
    return row ? ArtifactSchema.parse({ ...row, provenance: parseJson(row.provenanceJson) }) : null;
  }

  listArtifacts(runId: string): Artifact[] {
    return this.db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.runId, runId))
      .orderBy(schema.artifacts.createdAt)
      .all()
      .map((row) => ArtifactSchema.parse({ ...row, provenance: parseJson(row.provenanceJson) }));
  }

  listArtifactsBefore(cutoff: string): Artifact[] {
    return this.db
      .select()
      .from(schema.artifacts)
      .where(lt(schema.artifacts.createdAt, cutoff))
      .orderBy(schema.artifacts.createdAt)
      .all()
      .map((row) => ArtifactSchema.parse({ ...row, provenance: parseJson(row.provenanceJson) }));
  }

  deleteArtifact(artifactId: string): boolean {
    const result = this.db
      .delete(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId))
      .run();
    return result.changes === 1;
  }

  createDiagnosis(diagnosis: Diagnosis): Diagnosis {
    const parsed = DiagnosisSchema.parse(diagnosis);
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
    const parsed = PatchSchema.parse(patch);
    this.db
      .insert(schema.patches)
      .values({ ...parsed, filesJson: JSON.stringify(parsed.files) })
      .run();
    return parsed;
  }

  getPatch(runId: string): Patch | null {
    return this.listPatches(runId).at(-1) ?? null;
  }

  listPatches(runId: string): Patch[] {
    const rows = this.database
      .prepare('SELECT * FROM patches WHERE run_id = ? ORDER BY created_at, rowid')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) =>
      PatchSchema.parse({
        id: row.id,
        runId: row.run_id,
        diagnosisId: row.diagnosis_id,
        artifactId: row.artifact_id,
        summary: row.summary,
        files: parseJson(String(row.files_json)),
        risk: row.risk,
        applied: Number(row.applied) === 1,
        createdAt: row.created_at,
      })
    );
  }

  createVerification(verification: Verification): Verification {
    const parsed = VerificationSchema.parse(verification);
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
        const parsed = TestCaseSchema.parse(testCase);
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
    const parsed = ProviderCallSchema.parse(call);
    this.db
      .insert(schema.providerCalls)
      .values({
        ...parsed,
        costUsdMicros: parsed.costUsd === null ? null : Math.round(parsed.costUsd * 1_000_000),
      })
      .run();
    return parsed;
  }

  listProviderCalls(runId: string): ProviderCall[] {
    return this.db
      .select()
      .from(schema.providerCalls)
      .where(eq(schema.providerCalls.runId, runId))
      .orderBy(schema.providerCalls.createdAt)
      .all()
      .map((row) =>
        ProviderCallSchema.parse({
          ...row,
          costUsd: row.costUsdMicros === null ? null : row.costUsdMicros / 1_000_000,
        })
      );
  }

  upsertIntegration(integration: Integration): Integration {
    const parsed = IntegrationSchema.parse(integration);
    this.db
      .insert(schema.integrations)
      .values({ ...parsed, provenanceJson: JSON.stringify(parsed.provenance) })
      .onConflictDoUpdate({
        target: schema.integrations.provider,
        set: {
          status: parsed.status,
          detail: parsed.detail,
          provenanceJson: JSON.stringify(parsed.provenance),
          updatedAt: parsed.updatedAt,
        },
      })
      .run();
    return parsed;
  }

  listIntegrations(): Integration[] {
    return this.db
      .select()
      .from(schema.integrations)
      .orderBy(schema.integrations.provider)
      .all()
      .map((row) => IntegrationSchema.parse({ ...row, provenance: parseJson(row.provenanceJson) }));
  }

  importKnowledgeEntries(entries: KnowledgeEntry[]): number {
    return this.database.transaction(() => {
      let imported = 0;
      for (const entry of entries) {
        const parsed = KnowledgeEntrySchema.parse(entry);
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

  acquireLease(projectId: string, runId: string, ttlMs = 60_000): boolean {
    return this.database.transaction(() => {
      const timestamp = Date.now();
      const current = this.db.query.projectLeases
        .findFirst({ where: eq(schema.projectLeases.projectId, projectId) })
        .sync();
      if (current && Date.parse(current.expiresAt) > timestamp && current.runId !== runId) {
        return false;
      }
      this.db
        .insert(schema.projectLeases)
        .values({
          projectId,
          runId,
          ownerPid: process.pid,
          expiresAt: new Date(timestamp + ttlMs).toISOString(),
        })
        .onConflictDoUpdate({
          target: schema.projectLeases.projectId,
          set: {
            runId,
            ownerPid: process.pid,
            expiresAt: new Date(timestamp + ttlMs).toISOString(),
          },
        })
        .run();
      return true;
    })();
  }

  renewLease(projectId: string, runId: string, ttlMs = 60_000): boolean {
    const result = this.db
      .update(schema.projectLeases)
      .set({ expiresAt: new Date(Date.now() + ttlMs).toISOString(), ownerPid: process.pid })
      .where(
        and(eq(schema.projectLeases.projectId, projectId), eq(schema.projectLeases.runId, runId))
      )
      .run();
    return result.changes === 1;
  }

  releaseLease(projectId: string, runId: string): void {
    this.db
      .delete(schema.projectLeases)
      .where(
        and(eq(schema.projectLeases.projectId, projectId), eq(schema.projectLeases.runId, runId))
      )
      .run();
  }
}
