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
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
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
});

export const integrations = sqliteTable('integrations', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull().unique(),
  status: text('status').notNull(),
  detail: text('detail'),
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
