import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    trusted: integer('trusted', { mode: 'boolean' }).notNull(),
    configPath: text('config_path'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('projects_path_unique').on(table.path)]
);

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  status: text('status').notNull(),
  stage: text('stage').notNull(),
  requestedBy: text('requested_by').notNull(),
  branch: text('branch'),
  worktreePath: text('worktree_path'),
  baseSha: text('base_sha'),
  summary: text('summary'),
  error: text('error'),
  cancelRequestedAt: text('cancel_requested_at'),
  attempt: integer('attempt').notNull().default(1),
  retryOfRunId: text('retry_of_run_id'),
  availableActionsJson: text('available_actions_json').notNull().default('[]'),
  interventionJson: text('intervention_json'),
  lastHeartbeatAt: text('last_heartbeat_at'),
  recoveryCount: integer('recovery_count').notNull().default(0),
  failureCode: text('failure_code'),
  lastEventSequence: integer('last_event_sequence').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
});

export const runCheckpoints = sqliteTable('run_checkpoints', {
  runId: text('run_id')
    .primaryKey()
    .references(() => runs.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  dataJson: text('data_json').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const runEvents = sqliteTable(
  'run_events',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    stage: text('stage').notNull(),
    kind: text('kind').notNull(),
    occurredAt: text('occurred_at').notNull(),
    provenanceJson: text('provenance_json').notNull(),
    artifactIdsJson: text('artifact_ids_json').notNull(),
    payloadJson: text('payload_json').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    idempotencyKey: text('idempotency_key'),
  },
  (table) => [uniqueIndex('run_events_sequence_unique').on(table.runId, table.sequence)]
);

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  path: text('path').notNull(),
  sha256: text('sha256').notNull(),
  mimeType: text('mime_type').notNull(),
  bytes: integer('bytes').notNull(),
  provenanceJson: text('provenance_json').notNull(),
  createdAt: text('created_at').notNull(),
  state: text('state').notNull().default('ready'),
  readyAt: text('ready_at'),
  originalBytes: integer('original_bytes'),
  omittedBytes: integer('omitted_bytes').notNull().default(0),
  redactionCount: integer('redaction_count').notNull().default(0),
});

export const diagnoses = sqliteTable('diagnoses', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  summary: text('summary').notNull(),
  rootCause: text('root_cause').notNull(),
  confidence: integer('confidence').notNull(),
  evidenceArtifactIdsJson: text('evidence_artifact_ids_json').notNull(),
  provenanceJson: text('provenance_json').notNull(),
  createdAt: text('created_at').notNull(),
});

export const patches = sqliteTable('patches', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  diagnosisId: text('diagnosis_id')
    .notNull()
    .references(() => diagnoses.id, { onDelete: 'cascade' }),
  artifactId: text('artifact_id')
    .notNull()
    .references(() => artifacts.id, { onDelete: 'restrict' }),
  summary: text('summary').notNull(),
  filesJson: text('files_json').notNull(),
  risk: text('risk').notNull(),
  applied: integer('applied', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
});

export const verifications = sqliteTable('verifications', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  passed: integer('passed', { mode: 'boolean' }).notNull(),
  commandsJson: text('commands_json').notNull(),
  artifactIdsJson: text('artifact_ids_json').notNull(),
  createdAt: text('created_at').notNull(),
});

export const testCases = sqliteTable('test_cases', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  definitionJson: text('definition_json').notNull(),
  provenanceJson: text('provenance_json').notNull(),
  createdAt: text('created_at').notNull(),
});

export const providerCalls = sqliteTable('provider_calls', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  purpose: text('purpose').notNull(),
  status: text('status').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costUsdMicros: integer('cost_usd_micros'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  attempt: integer('attempt').notNull().default(1),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  durationMs: integer('duration_ms'),
  specialistRole: text('specialist_role'),
  evidenceArtifactIdsJson: text('evidence_artifact_ids_json').notNull().default('[]'),
  requestDigest: text('request_digest'),
  responseDigest: text('response_digest'),
  errorCode: text('error_code'),
});

export const integrations = sqliteTable('integrations', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull().unique(),
  status: text('status').notNull(),
  detail: text('detail'),
  requirementsJson: text('requirements_json').notNull().default('[]'),
  evidenceJson: text('evidence_json').notNull().default('[]'),
  provenanceJson: text('provenance_json').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const projectLeases = sqliteTable('project_leases', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  ownerPid: integer('owner_pid').notNull(),
  expiresAt: text('expires_at').notNull(),
});

export const knowledgeEntries = sqliteTable('knowledge_entries', {
  id: text('id').primaryKey(),
  failureSummary: text('failure_summary').notNull(),
  failureType: text('failure_type').notNull(),
  file: text('file'),
  fixSummary: text('fix_summary'),
  fixPatch: text('fix_patch'),
  successful: integer('successful', { mode: 'boolean' }).notNull(),
  provenanceJson: text('provenance_json').notNull(),
  importedAt: text('imported_at').notNull(),
});

export const runProjections = sqliteTable('run_projections', {
  runId: text('run_id')
    .primaryKey()
    .references(() => runs.id, { onDelete: 'cascade' }),
  schemaVersion: integer('schema_version').notNull(),
  appliedSequence: integer('applied_sequence').notNull(),
  projectionJson: text('projection_json').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const stageAttempts = sqliteTable(
  'stage_attempts',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stage: text('stage').notNull(),
    attempt: integer('attempt').notNull(),
    status: text('status').notNull(),
    summary: text('summary').notNull(),
    waitingOn: text('waiting_on'),
    nextRetryAt: text('next_retry_at'),
    lastHeartbeatAt: text('last_heartbeat_at'),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    evidenceArtifactIdsJson: text('evidence_artifact_ids_json').notNull().default('[]'),
  },
  (table) => [uniqueIndex('stage_attempts_unique').on(table.runId, table.stage, table.attempt)]
);

export const policyWorkerCalls = sqliteTable('policy_worker_calls', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  worker: text('worker').notNull(),
  version: text('version').notNull(),
  attempt: integer('attempt').notNull(),
  status: text('status').notNull(),
  inputDigest: text('input_digest').notNull(),
  outputDigest: text('output_digest'),
  error: text('error'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
});

export const specialistActivities = sqliteTable('specialist_activities', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  status: text('status').notNull(),
  summary: text('summary').notNull(),
  sourceKind: text('source_kind').notNull(),
  providerCallId: text('provider_call_id'),
  policyWorkerCallId: text('policy_worker_call_id'),
  occurredAt: text('occurred_at').notNull(),
  attempt: integer('attempt').notNull(),
  evidenceArtifactIdsJson: text('evidence_artifact_ids_json').notNull(),
  handoffTarget: text('handoff_target'),
});

export const specialistCritiques = sqliteTable('specialist_critiques', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  activityId: text('activity_id').notNull(),
  role: text('role').notNull(),
  verdict: text('verdict').notNull(),
  summary: text('summary').notNull(),
  sourceKind: text('source_kind').notNull(),
  providerCallId: text('provider_call_id'),
  policyWorkerCallId: text('policy_worker_call_id'),
  occurredAt: text('occurred_at').notNull(),
  attempt: integer('attempt').notNull(),
  evidenceArtifactIdsJson: text('evidence_artifact_ids_json').notNull(),
  actionRequired: text('action_required'),
});

export const specialistDecisions = sqliteTable('specialist_decisions', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  action: text('action').notNull(),
  summary: text('summary').notNull(),
  sourceKind: text('source_kind').notNull(),
  providerCallId: text('provider_call_id'),
  policyWorkerCallId: text('policy_worker_call_id'),
  occurredAt: text('occurred_at').notNull(),
  attempt: integer('attempt').notNull(),
  evidenceArtifactIdsJson: text('evidence_artifact_ids_json').notNull(),
  handoffTarget: text('handoff_target'),
});

export const runManifestContexts = sqliteTable('run_manifest_contexts', {
  runId: text('run_id')
    .primaryKey()
    .references(() => runs.id, { onDelete: 'cascade' }),
  configDigest: text('config_digest'),
  configPath: text('config_path'),
  baseSha: text('base_sha'),
  headSha: text('head_sha'),
  branch: text('branch'),
  worktreePath: text('worktree_path'),
  commandsJson: text('commands_json').notNull().default('[]'),
  browserChecksJson: text('browser_checks_json').notNull().default('[]'),
  updatedAt: text('updated_at').notNull(),
});

export const runManifests = sqliteTable('run_manifests', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .unique()
    .references(() => runs.id, { onDelete: 'cascade' }),
  artifactId: text('artifact_id')
    .notNull()
    .unique()
    .references(() => artifacts.id, { onDelete: 'restrict' }),
  sha256: text('sha256').notNull(),
  eventSequence: integer('event_sequence').notNull(),
  createdAt: text('created_at').notNull(),
});
