import type Database from 'better-sqlite3';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

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
