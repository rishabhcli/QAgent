import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import type { Artifact, Provenance } from '@qagent/contracts';
import type { QAgentStorage } from './storage.js';

interface SaveArtifactInput {
  runId: string;
  kind: Artifact['kind'];
  name: string;
  mimeType: string;
  data: string | Uint8Array;
  provenance: Provenance;
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

  constructor(
    root: string,
    private readonly storage: QAgentStorage
  ) {
    const resolved = resolve(root);
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    this.root = realpathSync(resolved);
  }

  async save(input: SaveArtifactInput): Promise<Artifact> {
    const id = randomUUID();
    const extension = extname(input.name);
    const filename = `${id}-${safeName(input.name.replace(extension, ''))}${extension}`;
    const requestedDirectory = resolve(this.root, input.runId);
    assertContained(this.root, requestedDirectory);
    await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
    const directory = await realpath(requestedDirectory);
    assertContained(this.root, directory);
    const path = resolve(directory, filename);
    assertContained(this.root, path);

    const bytes =
      typeof input.data === 'string' ? Buffer.from(input.data) : Buffer.from(input.data);
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
      name: input.name,
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mimeType: input.mimeType,
      bytes: bytes.byteLength,
      provenance: input.provenance,
      createdAt: new Date().toISOString(),
    };
    return this.storage.createArtifact(artifact);
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
        if (!this.storage.deleteArtifact(artifact.id)) continue;
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
}
