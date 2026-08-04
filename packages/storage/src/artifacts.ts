import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import type {
  Artifact,
  BoundedOutput,
  Provenance,
  Run,
  RunEvent,
  RunManifest,
  RunManifestRecord,
  RunStage,
  RunStatus,
  TerminalEvidence,
  TraceState,
} from '@qagent/contracts';
import { RunManifestSchema } from '@qagent/contracts';
import type {
  QAgentStorage,
  TerminalRunDisposition,
  TerminalRunEvent,
  TerminalRunStatus,
} from './storage.js';

interface SaveArtifactInput {
  runId: string;
  kind: Artifact['kind'];
  name: string;
  mimeType: string;
  data: string | Uint8Array;
  provenance: Provenance;
}

export interface SaveRunManifestInput {
  runId: string;
  status: RunStatus;
  stage: RunStage;
  summary: string | null;
  error: string | null;
  completedAt: string | null;
  traceState: TraceState;
  traceProvider?: string | null;
}

export interface SavedRunManifest {
  manifest: RunManifest;
  record: RunManifestRecord;
  artifact: Artifact;
}

export interface FinalizeRunManifestInput {
  runId: string;
  status: TerminalRunStatus;
  stage: RunStage;
  completedAt: string;
  traceState: TraceState;
  traceProvider?: string | null;
  terminalEvidence: TerminalEvidence;
  terminalEvent: TerminalRunEvent;
  disposition?: TerminalRunDisposition;
}

export interface FinalizedRunManifest extends SavedRunManifest {
  run: Run;
  terminalEvidence: TerminalEvidence;
  events: RunEvent[];
}

const BINARY_ARTIFACT_LIMIT = 5 * 1_024 * 1_024;

function textLimit(kind: Artifact['kind']): number {
  switch (kind) {
    case 'log':
      return 1 * 1_024 * 1_024;
    case 'dom':
      return 1 * 1_024 * 1_024;
    case 'patch':
      return 2 * 1_024 * 1_024;
    case 'manifest':
      return 5 * 1_024 * 1_024;
    case 'report':
      return 1 * 1_024 * 1_024;
    default:
      return 1 * 1_024 * 1_024;
  }
}

function safeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'artifact';
}

function assertContained(root: string, candidate: string): void {
  const child = relative(root, candidate);
  if (child.startsWith('..') || child === '..') {
    throw new Error('Artifact path escaped the configured artifact directory');
  }
}

export class ArtifactStore {
  readonly root: string;
  private readonly manifestSaves = new Map<string, Promise<SavedRunManifest>>();
  private readonly manifestFinalizations = new Map<string, Promise<FinalizedRunManifest>>();

  constructor(
    root: string,
    private readonly storage: QAgentStorage
  ) {
    const resolved = resolve(root);
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    this.root = realpathSync(resolved);
  }

  async save(input: SaveArtifactInput): Promise<Artifact> {
    const prepared = await this.prepareArtifact(input);
    try {
      return this.storage.createArtifact(prepared.artifact, prepared.persistence);
    } catch (error) {
      await rm(prepared.artifact.path, { force: true });
      throw error;
    }
  }

  private async prepareArtifact(input: SaveArtifactInput): Promise<{
    artifact: Artifact;
    persistence: {
      originalBytes: number;
      omittedBytes: number;
      redactionCount: number;
    };
  }> {
    const id = randomUUID();
    const persistedName = this.storage.redactText(input.name);
    const extension = extname(persistedName);
    const filename = `${id}-${safeName(persistedName.replace(extension, ''))}${extension}`;
    const requestedDirectory = resolve(this.root, input.runId);
    assertContained(this.root, requestedDirectory);
    await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
    const directory = await realpath(requestedDirectory);
    assertContained(this.root, directory);
    const path = resolve(directory, filename);
    assertContained(this.root, path);

    const original = Buffer.from(input.data);
    const textual = isTextualArtifact(input.kind, input.mimeType);
    let text: string | null = null;
    if (typeof input.data === 'string') {
      text = input.data;
    } else if (textual) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(input.data);
      } catch {
        throw new Error('Text artifact data is not valid UTF-8');
      }
    } else {
      this.storage.assertBinarySafe(input.data);
    }
    const bounded = text === null ? null : this.storage.boundedOutput(text, textLimit(input.kind));
    if (!bounded && original.byteLength > BINARY_ARTIFACT_LIMIT) {
      throw new Error(`Binary artifact exceeds the ${BINARY_ARTIFACT_LIMIT} byte limit`);
    }
    if (input.kind === 'manifest' && bounded?.truncated) {
      throw new Error('Run manifest exceeds its bounded artifact limit');
    }
    const bytes = bounded ? Buffer.from(bounded.text) : original;
    const temporaryPath = `${path}.tmp`;
    try {
      await writeFile(temporaryPath, bytes, { mode: 0o600 });
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }

    const artifact: Artifact = {
      id,
      runId: input.runId,
      kind: input.kind,
      name: persistedName,
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mimeType: input.mimeType,
      bytes: bytes.byteLength,
      provenance: input.provenance,
      createdAt: new Date().toISOString(),
    };
    return {
      artifact,
      persistence: {
        originalBytes: bounded?.originalBytes ?? original.byteLength,
        omittedBytes: bounded?.omittedBytes ?? 0,
        redactionCount: bounded?.redactionCount ?? 0,
      },
    };
  }

  async saveRunManifest(input: SaveRunManifestInput): Promise<SavedRunManifest> {
    const pending = this.manifestSaves.get(input.runId);
    if (pending) return pending;
    const save = this.saveRunManifestOnce(input).finally(() => {
      if (this.manifestSaves.get(input.runId) === save) {
        this.manifestSaves.delete(input.runId);
      }
    });
    this.manifestSaves.set(input.runId, save);
    return save;
  }

  async finalizeRunManifest(input: FinalizeRunManifestInput): Promise<FinalizedRunManifest> {
    const pending = this.manifestFinalizations.get(input.runId);
    if (pending) return pending;
    const save = this.saveRunManifestOnce(input).finally(() => {
      if (this.manifestFinalizations.get(input.runId) === save) {
        this.manifestFinalizations.delete(input.runId);
      }
    });
    this.manifestFinalizations.set(input.runId, save);
    return save;
  }

  private saveRunManifestOnce(
    input: SaveRunManifestInput,
    snapshotRetry?: number
  ): Promise<SavedRunManifest>;
  private saveRunManifestOnce(
    input: FinalizeRunManifestInput,
    snapshotRetry?: number
  ): Promise<FinalizedRunManifest>;
  private async saveRunManifestOnce(
    input: SaveRunManifestInput | FinalizeRunManifestInput,
    snapshotRetry = 0
  ): Promise<SavedRunManifest | FinalizedRunManifest> {
    const finalizing = 'terminalEvidence' in input;
    const existing = this.storage.getRunManifest(input.runId);
    if (existing) {
      const artifact = this.storage.getArtifact(existing.artifactId);
      if (!artifact) throw new Error('Run manifest record references an unavailable artifact');
      const manifest = this.parseRunManifest(await this.read(artifact));
      if (finalizing) {
        const run = this.storage.getRun(input.runId);
        const events = this.storage.listEvents(input.runId);
        const evidenceEvent = events.findLast((event) => event.kind === 'terminal.evidence');
        const terminalEvent = events.findLast((event) =>
          ['run.completed', 'run.failed', 'run.cancelled', 'run.policy_blocked'].includes(
            event.kind
          )
        );
        if (
          !run ||
          !evidenceEvent ||
          evidenceEvent.kind !== 'terminal.evidence' ||
          !terminalEvent ||
          events.at(-1)?.id !== terminalEvent.id ||
          !evidenceEvent.payload.evidence.artifactIds.includes(artifact.id)
        ) {
          throw new Error('Existing run manifest was not atomically terminalized');
        }
        return {
          manifest,
          record: existing,
          artifact,
          run,
          terminalEvidence: evidenceEvent.payload.evidence,
          events: events.filter(
            (event) => event.sequence >= Math.max(1, existing.eventSequence - 1)
          ),
        };
      }
      return { manifest, record: existing, artifact };
    }

    const generatedAt = new Date().toISOString();
    const snapshot = this.storage.readRunManifestSnapshot(input.runId);
    const {
      run,
      context,
      events,
      artifacts,
      stageAttempts,
      providerCalls,
      policyWorkerCalls,
      specialistActivities,
      specialistCritiques,
      specialistDecisions,
    } = snapshot;
    const safeTerminalMessage = finalizing
      ? this.storage.boundedOutput(input.terminalEvent.payload.message, 4_096).text
      : null;
    const durableOutcome = finalizing
      ? {
          status: input.status,
          stage: input.stage,
          summary: input.status === 'succeeded' ? safeTerminalMessage : run.summary,
          error: input.status === 'succeeded' ? null : safeTerminalMessage,
          completedAt: input.completedAt,
        }
      : {
          status: run.status,
          stage: run.stage,
          summary: run.summary,
          error: run.error,
          completedAt: run.completedAt,
        };
    if (finalizing) {
      if (['succeeded', 'failed', 'cancelled', 'policy_blocked'].includes(run.status)) {
        if (this.storage.getRunManifest(input.runId)) {
          return this.saveRunManifestOnce(input, snapshotRetry);
        }
        throw new Error('Atomic run finalization requires a non-terminal durable run');
      }
      if (input.terminalEvent.stage !== input.stage) {
        throw new Error('Terminal event stage does not match the run manifest');
      }
    } else {
      if (!['succeeded', 'failed', 'cancelled', 'policy_blocked'].includes(run.status)) {
        throw new Error('Run manifests require a durable terminal run');
      }
      for (const key of ['status', 'stage', 'summary', 'error', 'completedAt'] as const) {
        if (input[key] !== durableOutcome[key]) {
          throw new Error(`Run manifest ${key} does not match the durable run`);
        }
      }
    }
    const boundedSummary =
      durableOutcome.summary === null
        ? null
        : this.storage.boundedOutput(durableOutcome.summary, 4_096);
    const boundedError =
      durableOutcome.error === null
        ? null
        : this.storage.boundedOutput(durableOutcome.error, 4_096);
    const manifestOutcome = {
      ...durableOutcome,
      summary: boundedSummary?.text ?? null,
      error: boundedError?.text ?? null,
    };
    const outcomeRedactionCount =
      (boundedSummary?.redactionCount ?? 0) + (boundedError?.redactionCount ?? 0);
    const repository = {
      baseSha: run.baseSha ?? context?.baseSha ?? null,
      headSha: context?.headSha ?? null,
      branch: run.branch ?? context?.branch ?? null,
      worktreePath: run.worktreePath ?? context?.worktreePath ?? null,
    };
    for (const key of ['baseSha', 'branch', 'worktreePath'] as const) {
      const durableValue = run[key];
      const contextValue = context?.[key] ?? null;
      if (durableValue !== null && contextValue !== null && durableValue !== contextValue) {
        throw new Error(`Run manifest ${key} context conflicts with the durable run`);
      }
    }
    const latestTrace = events.findLast((event) => event.kind === 'trace.status');
    const durableTrace = latestTrace
      ? {
          state: latestTrace.payload.state,
          provider: latestTrace.provenance.provider ?? null,
          updatedAt: latestTrace.occurredAt,
          atManifest: true as const,
        }
      : {
          state: 'local' as const,
          provider: null,
          updatedAt: generatedAt,
          atManifest: true as const,
        };
    if (input.traceState !== durableTrace.state) {
      throw new Error('Run manifest trace state does not match the durable event stream');
    }
    if (input.traceProvider !== undefined && input.traceProvider !== durableTrace.provider) {
      throw new Error('Run manifest trace provider does not match the durable event stream');
    }
    const snapshotSequence = events.at(-1)?.sequence ?? 0;
    const commandStarts = events.filter((event) => event.kind === 'command.started');
    const commands = commandStarts.map((started) => {
      const commandId = started.payload.commandId ?? started.id;
      const terminal = events.find(
        (event) =>
          event.sequence > started.sequence &&
          (event.kind === 'command.completed' ||
            event.kind === 'command.failed' ||
            event.kind === 'command.cancelled') &&
          ('commandId' in event.payload
            ? event.payload.commandId === commandId
            : event.kind === 'command.completed' &&
              event.payload.executable === started.payload.executable)
      );
      const outputs = events.flatMap((event) =>
        event.kind === 'command.output' && event.payload.commandId === commandId
          ? [event.payload.output]
          : []
      );
      const configured = context?.commands.find(
        (command) =>
          command.executable === started.payload.executable &&
          JSON.stringify(command.args) === JSON.stringify(started.payload.args)
      );
      const status =
        terminal?.kind === 'command.completed'
          ? terminal.payload.exitCode === 0
            ? 'succeeded'
            : 'failed'
          : terminal?.kind === 'command.cancelled'
            ? 'cancelled'
            : terminal?.kind === 'command.failed'
              ? 'failed'
              : 'started';
      return {
        commandId,
        stage: started.stage,
        attempt: started.payload.attempt ?? 1,
        executable: started.payload.executable,
        args: started.payload.args,
        cwd: configured?.cwd ?? '.',
        timeoutMs: configured?.timeoutMs ?? 120_000,
        envKeys: Object.keys(configured?.env ?? {}).sort(),
        status,
        exitCode: terminal?.kind === 'command.completed' ? terminal.payload.exitCode : null,
        durationMs:
          terminal &&
          (terminal.kind === 'command.completed' ||
            terminal.kind === 'command.failed' ||
            terminal.kind === 'command.cancelled')
            ? terminal.payload.durationMs
            : null,
        output: mergeBoundedOutputs(this.storage, outputs),
        evidenceIds: terminal?.artifactIds ?? [],
      } as const;
    });
    const browserChecks = events
      .filter((event) => event.kind === 'browser.checkpoint' || event.kind === 'browser.failed')
      .map((event) =>
        event.kind === 'browser.checkpoint'
          ? {
              checkId: event.payload.checkpointId,
              flow: event.payload.flow,
              attempt: event.payload.attempt,
              status: 'succeeded' as const,
              sessionId: event.payload.sessionId,
              url: event.payload.url,
              evidenceIds: event.artifactIds,
            }
          : {
              checkId: event.id,
              flow: event.payload.operation,
              attempt: event.payload.attempt,
              status: 'failed' as const,
              sessionId: event.payload.sessionId,
              url: null,
              evidenceIds: event.artifactIds,
            }
      );
    const artifactReplacementCount =
      outcomeRedactionCount +
      events
        .filter((event) => event.kind === 'artifact.created')
        .reduce((total, event) => total + event.payload.redactionCount, 0);
    const sanitized = this.storage.sanitizeForPersistenceWithCount({
      schemaVersion: 1 as const,
      runId: input.runId,
      generatedAt,
      config: {
        sha256: context?.configDigest ?? null,
        sourcePath: context?.configPath ?? null,
      },
      repository,
      commands,
      browserChecks,
      stageAttempts,
      providerCalls,
      policyWorkerCalls,
      specialistActivities,
      specialistCritiques,
      specialistDecisions,
      outcome: manifestOutcome,
      trace: durableTrace,
      artifacts: artifacts.map(({ id, kind, name, sha256, mimeType, bytes, createdAt }) => ({
        id,
        kind,
        name,
        sha256,
        mimeType,
        bytes,
        createdAt,
      })),
      redaction: {
        version: 1 as const,
        applied: artifactReplacementCount > 0,
        replacementCount: artifactReplacementCount,
      },
      manifestArtifactExcluded: true as const,
    });
    const replacementCount = artifactReplacementCount + sanitized.replacementCount;
    const payload = {
      ...sanitized.value,
      redaction: {
        version: 1 as const,
        applied: replacementCount > 0,
        replacementCount,
      },
    };
    const checksum = createHash('sha256').update(canonicalJson(payload)).digest('hex');
    const manifest = RunManifestSchema.parse({ ...payload, checksum });
    const provenance: Provenance = {
      source: 'local',
      provider: 'QAgent manifest',
      capturedAt: generatedAt,
    };
    const prepared = await this.prepareArtifact({
      runId: input.runId,
      kind: 'manifest',
      name: 'run-manifest.json',
      mimeType: 'application/json',
      data: `${canonicalJson(manifest)}\n`,
      provenance,
    });
    try {
      const record = {
        id: randomUUID(),
        runId: input.runId,
        artifactId: prepared.artifact.id,
        sha256: prepared.artifact.sha256,
        createdAt: generatedAt,
      };
      if (finalizing) {
        const committed = this.storage.finalizeRunWithManifestArtifact(
          prepared.artifact,
          prepared.persistence,
          record,
          input.stage,
          provenance,
          {
            status: input.status,
            completedAt: input.completedAt,
            terminalEvidence: input.terminalEvidence,
            terminalEvent: input.terminalEvent,
            disposition: input.disposition ?? {
              availableActions: input.status === 'succeeded' ? [] : ['retry'],
              failureCode:
                input.status === 'failed' || input.status === 'policy_blocked'
                  ? 'unexpected_failure'
                  : null,
            },
            expectation: {
              lastEventSequence: snapshotSequence,
              contextUpdatedAt: context?.updatedAt ?? null,
              run: {
                status: run.status,
                stage: run.stage,
                summary: run.summary,
                error: run.error,
                completedAt: run.completedAt,
                baseSha: run.baseSha,
                branch: run.branch,
                worktreePath: run.worktreePath,
                updatedAt: run.updatedAt,
              },
            },
          }
        );
        if (!committed.created) {
          await rm(prepared.artifact.path, { force: true });
          const durableManifest = this.parseRunManifest(await this.read(committed.artifact));
          return {
            manifest: durableManifest,
            record: committed.record,
            artifact: committed.artifact,
            run: committed.run,
            terminalEvidence: committed.terminalEvidence,
            events: committed.events,
          };
        }
        return {
          manifest,
          record: committed.record,
          artifact: committed.artifact,
          run: committed.run,
          terminalEvidence: committed.terminalEvidence,
          events: committed.events,
        };
      }

      const committed = this.storage.commitRunManifestArtifact(
        prepared.artifact,
        prepared.persistence,
        record,
        input.stage,
        provenance,
        {
          lastEventSequence: snapshotSequence,
          outcome: durableOutcome,
        }
      );
      if (!committed.created) {
        await rm(prepared.artifact.path, { force: true });
        const durableManifest = this.parseRunManifest(await this.read(committed.artifact));
        return {
          manifest: durableManifest,
          record: committed.record,
          artifact: committed.artifact,
        };
      }
      return {
        manifest,
        record: committed.record,
        artifact: committed.artifact,
      };
    } catch (error) {
      await rm(prepared.artifact.path, { force: true });
      if (
        snapshotRetry < 2 &&
        error instanceof Error &&
        error.message === 'Run manifest snapshot changed before commit'
      ) {
        if ('terminalEvidence' in input) {
          return this.saveRunManifestOnce(input, snapshotRetry + 1);
        }
        return this.saveRunManifestOnce(input, snapshotRetry + 1);
      }
      throw error;
    }
  }

  async read(artifact: Artifact): Promise<Buffer> {
    const path = await this.resolveArtifactPath(artifact);
    const bytes = await readFile(path);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== artifact.sha256)
      throw new Error(`Artifact ${artifact.id} failed integrity check`);
    return bytes;
  }

  async export(artifact: Artifact, destination: string): Promise<void> {
    const source = await this.resolveArtifactPath(artifact);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }

  async prune(olderThan: Date): Promise<{ deleted: number; bytes: number; retained: number }> {
    let deleted = 0;
    let bytes = 0;
    let retained = 0;
    for (const artifact of this.storage.listArtifactsBefore(olderThan.toISOString())) {
      try {
        const path = await this.resolveArtifactPath(artifact);
        if (!this.storage.deleteArtifact(artifact.id)) {
          retained += 1;
          continue;
        }
        await rm(path, { force: true });
        deleted += 1;
        bytes += artifact.bytes;
      } catch {
        // Patch artifacts referenced by durable repair records are retained.
        retained += 1;
      }
    }
    return { deleted, bytes, retained };
  }

  private async resolveArtifactPath(artifact: Artifact): Promise<string> {
    const path = await realpath(resolve(artifact.path));
    assertContained(this.root, path);
    return path;
  }

  private parseRunManifest(bytes: Uint8Array): RunManifest {
    const manifest = RunManifestSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
    const { checksum, ...payload } = manifest;
    const expected = createHash('sha256').update(canonicalJson(payload)).digest('hex');
    if (checksum !== expected) throw new Error('Run manifest content checksum is invalid');
    return manifest;
  }
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

function mergeBoundedOutputs(
  storage: QAgentStorage,
  outputs: BoundedOutput[]
): BoundedOutput | null {
  if (outputs.length === 0) return null;
  const merged = storage.boundedOutput(outputs.map((output) => output.text).join(''), 48 * 1_024);
  const previouslyOmitted = outputs.reduce((total, output) => total + output.omittedBytes, 0);
  const omittedBytes = previouslyOmitted + merged.omittedBytes;
  return {
    ...merged,
    originalBytes: merged.originalBytes + previouslyOmitted,
    omittedBytes,
    truncated: omittedBytes > 0,
    redactionCount:
      merged.redactionCount + outputs.reduce((total, output) => total + output.redactionCount, 0),
    backpressure:
      omittedBytes > 0
        ? {
            droppedChunks:
              outputs.reduce(
                (total, output) => total + (output.backpressure?.droppedChunks ?? 0),
                0
              ) + (merged.backpressure?.droppedChunks ?? 0),
            droppedBytes: omittedBytes,
          }
        : null,
  };
}

function isTextualArtifact(kind: Artifact['kind'], mimeType: string): boolean {
  if (kind === 'log' || kind === 'dom' || kind === 'patch' || kind === 'manifest') return true;
  const normalized = mimeType.toLowerCase().split(';', 1)[0]!.trim();
  return (
    normalized.startsWith('text/') ||
    normalized === 'application/json' ||
    normalized === 'application/ld+json' ||
    normalized === 'application/xml' ||
    normalized === 'application/yaml' ||
    normalized === 'application/javascript'
  );
}
