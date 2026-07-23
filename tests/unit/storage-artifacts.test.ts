import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Provenance } from '@qagent/contracts';
import { ArtifactStore, QAgentStorage } from '@qagent/storage';
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
      call,
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
      { ...integration, status: 'healthy', detail: 'Probe passed' },
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
    ]);
    database.close();
    const reopened = new QAgentStorage(databasePath);
    openStorage.push(reopened);
    expect(reopened.listProjects()).toEqual([]);
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
