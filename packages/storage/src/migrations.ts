import type Database from 'better-sqlite3';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const finalizedRunTables = [
  'run_events',
  'artifacts',
  'diagnoses',
  'patches',
  'verifications',
  'provider_calls',
  'run_checkpoints',
  'stage_attempts',
  'policy_worker_calls',
  'specialist_activities',
  'specialist_critiques',
  'specialist_decisions',
  'run_manifest_contexts',
] as const;

const finalizedRunGuards = [
  ...(['UPDATE', 'DELETE'] as const).map(
    (operation) => `
      CREATE TRIGGER finalized_runs_block_runs_${operation.toLowerCase()}
      BEFORE ${operation} ON runs
      WHEN EXISTS (SELECT 1 FROM run_manifests WHERE run_id = OLD.id)
      BEGIN
        SELECT RAISE(ABORT, 'run is finalized by its manifest');
      END;`
  ),
  ...finalizedRunTables.flatMap((table) =>
    (['INSERT', 'UPDATE', 'DELETE'] as const).map((operation) => {
      const reference = operation === 'INSERT' ? 'NEW' : 'OLD';
      return `
        CREATE TRIGGER finalized_runs_block_${table}_${operation.toLowerCase()}
        BEFORE ${operation} ON ${table}
        WHEN EXISTS (SELECT 1 FROM run_manifests WHERE run_id = ${reference}.run_id)
        BEGIN
          SELECT RAISE(ABORT, 'run is finalized by its manifest');
        END;`;
    })
  ),
].join('\n');

const migrations: Migration[] = [
  {
    version: 1,
    name: 'local-first-foundation',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        trusted INTEGER NOT NULL,
        config_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        branch TEXT,
        worktree_path TEXT,
        base_sha TEXT,
        summary TEXT,
        error TEXT,
        cancel_requested_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX runs_project_created_idx ON runs(project_id, created_at DESC);
      CREATE TABLE run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        stage TEXT NOT NULL,
        kind TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        artifact_ids_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(run_id, sequence)
      );
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE diagnoses (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        summary TEXT NOT NULL,
        root_cause TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        evidence_artifact_ids_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE patches (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        diagnosis_id TEXT NOT NULL REFERENCES diagnoses(id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
        summary TEXT NOT NULL,
        files_json TEXT NOT NULL,
        risk TEXT NOT NULL,
        applied INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE verifications (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        passed INTEGER NOT NULL,
        commands_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE test_cases (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE provider_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        purpose TEXT NOT NULL,
        status TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cost_usd_micros INTEGER,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE integrations (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        detail TEXT,
        provenance_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE project_leases (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        owner_pid INTEGER NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE knowledge_entries (
        id TEXT PRIMARY KEY,
        failure_summary TEXT NOT NULL,
        failure_type TEXT NOT NULL,
        file TEXT,
        fix_summary TEXT,
        fix_patch TEXT,
        successful INTEGER NOT NULL,
        provenance_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'verification-browser-evidence',
    sql: `
      ALTER TABLE verifications
      ADD COLUMN artifact_ids_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 3,
    name: 'durable-run-actions-and-recovery',
    sql: `
      ALTER TABLE runs
      ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE runs
      ADD COLUMN retry_of_run_id TEXT;
      ALTER TABLE runs
      ADD COLUMN available_actions_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE runs
      ADD COLUMN intervention_json TEXT;
      ALTER TABLE runs
      ADD COLUMN last_heartbeat_at TEXT;
      ALTER TABLE runs
      ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE runs
      ADD COLUMN failure_code TEXT;
      ALTER TABLE integrations
      ADD COLUMN requirements_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE integrations
      ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]';

      CREATE TABLE run_checkpoints (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 4,
    name: 'truthful-observability-protocol',
    sql: `
      ALTER TABLE runs
      ADD COLUMN last_event_sequence INTEGER NOT NULL DEFAULT 0;
      UPDATE runs
      SET last_event_sequence = COALESCE(
        (SELECT MAX(sequence) FROM run_events WHERE run_events.run_id = runs.id),
        0
      );
      UPDATE runs
      SET failure_code = CASE
            WHEN status = 'policy_blocked' THEN 'policy_blocked'
            ELSE 'unexpected_failure'
          END
      WHERE status IN ('failed', 'policy_blocked')
        AND failure_code IS NULL;
      UPDATE runs
      SET available_actions_json = '["resume","cancel"]',
          failure_code = COALESCE(failure_code, 'interrupted_recovery')
      WHERE status = 'interrupted';

      ALTER TABLE run_events
      ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE run_events
      ADD COLUMN idempotency_key TEXT;
      CREATE UNIQUE INDEX run_events_idempotency_unique
      ON run_events(run_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

      ALTER TABLE artifacts
      ADD COLUMN state TEXT NOT NULL DEFAULT 'ready';
      ALTER TABLE artifacts
      ADD COLUMN ready_at TEXT;
      ALTER TABLE artifacts
      ADD COLUMN original_bytes INTEGER;
      ALTER TABLE artifacts
      ADD COLUMN omitted_bytes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE artifacts
      ADD COLUMN redaction_count INTEGER NOT NULL DEFAULT 0;
      UPDATE artifacts
      SET ready_at = created_at, original_bytes = bytes
      WHERE ready_at IS NULL OR original_bytes IS NULL;

      ALTER TABLE provider_calls
      ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE provider_calls
      ADD COLUMN started_at TEXT;
      ALTER TABLE provider_calls
      ADD COLUMN completed_at TEXT;
      ALTER TABLE provider_calls
      ADD COLUMN duration_ms INTEGER;
      ALTER TABLE provider_calls
      ADD COLUMN specialist_role TEXT;
      ALTER TABLE provider_calls
      ADD COLUMN evidence_artifact_ids_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE provider_calls
      ADD COLUMN request_digest TEXT;
      ALTER TABLE provider_calls
      ADD COLUMN response_digest TEXT;
      ALTER TABLE provider_calls
      ADD COLUMN error_code TEXT;
      UPDATE provider_calls
      SET started_at = created_at,
          completed_at = CASE WHEN status = 'started' THEN NULL ELSE created_at END
      WHERE started_at IS NULL;

      CREATE TABLE run_projections (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL,
        applied_sequence INTEGER NOT NULL,
        projection_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE stage_attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        waiting_on TEXT,
        next_retry_at TEXT,
        last_heartbeat_at TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        evidence_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
        UNIQUE(run_id, stage, attempt)
      );
      CREATE INDEX stage_attempts_run_status_idx ON stage_attempts(run_id, status);

      CREATE TABLE policy_worker_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        worker TEXT NOT NULL,
        version TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        output_digest TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX policy_worker_calls_run_idx ON policy_worker_calls(run_id, started_at);

      CREATE TABLE specialist_activities (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        provider_call_id TEXT REFERENCES provider_calls(id) ON DELETE RESTRICT,
        policy_worker_call_id TEXT REFERENCES policy_worker_calls(id) ON DELETE RESTRICT,
        occurred_at TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        evidence_artifact_ids_json TEXT NOT NULL,
        handoff_target TEXT,
        CHECK (
          (source_kind = 'provider_call' AND provider_call_id IS NOT NULL AND policy_worker_call_id IS NULL)
          OR
          (source_kind = 'policy_worker' AND provider_call_id IS NULL AND policy_worker_call_id IS NOT NULL)
        )
      );
      CREATE INDEX specialist_activities_run_idx
      ON specialist_activities(run_id, occurred_at, id);

      CREATE TABLE specialist_critiques (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        activity_id TEXT NOT NULL REFERENCES specialist_activities(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        verdict TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        provider_call_id TEXT REFERENCES provider_calls(id) ON DELETE RESTRICT,
        policy_worker_call_id TEXT REFERENCES policy_worker_calls(id) ON DELETE RESTRICT,
        occurred_at TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        evidence_artifact_ids_json TEXT NOT NULL,
        action_required TEXT,
        CHECK (
          (source_kind = 'provider_call' AND provider_call_id IS NOT NULL AND policy_worker_call_id IS NULL)
          OR
          (source_kind = 'policy_worker' AND provider_call_id IS NULL AND policy_worker_call_id IS NOT NULL)
        )
      );
      CREATE INDEX specialist_critiques_run_idx
      ON specialist_critiques(run_id, occurred_at, id);

      CREATE TABLE specialist_decisions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        provider_call_id TEXT REFERENCES provider_calls(id) ON DELETE RESTRICT,
        policy_worker_call_id TEXT REFERENCES policy_worker_calls(id) ON DELETE RESTRICT,
        occurred_at TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        evidence_artifact_ids_json TEXT NOT NULL,
        handoff_target TEXT,
        CHECK (
          (source_kind = 'provider_call' AND provider_call_id IS NOT NULL AND policy_worker_call_id IS NULL)
          OR
          (source_kind = 'policy_worker' AND provider_call_id IS NULL AND policy_worker_call_id IS NOT NULL)
        )
      );
      CREATE INDEX specialist_decisions_run_idx
      ON specialist_decisions(run_id, occurred_at, id);

      CREATE TABLE run_manifest_contexts (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        config_digest TEXT,
        config_path TEXT,
        base_sha TEXT,
        head_sha TEXT,
        branch TEXT,
        worktree_path TEXT,
        commands_json TEXT NOT NULL DEFAULT '[]',
        browser_checks_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE run_manifests (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
        sha256 TEXT NOT NULL,
        event_sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 5,
    name: 'immutable-terminal-manifests',
    sql: finalizedRunGuards,
  },
  {
    version: 6,
    name: 'immutable-run-manifest-records',
    sql: `
      CREATE TRIGGER run_manifests_block_update
      BEFORE UPDATE ON run_manifests
      BEGIN
        SELECT RAISE(ABORT, 'run manifest record is immutable');
      END;

      CREATE TRIGGER run_manifests_block_delete
      BEFORE DELETE ON run_manifests
      BEGIN
        SELECT RAISE(ABORT, 'run manifest record is immutable');
      END;
    `,
  },
];

export function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => (row as { version: number }).version)
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}
