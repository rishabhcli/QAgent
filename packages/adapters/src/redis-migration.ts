import { randomUUID } from 'node:crypto';
import type { KnowledgeEntry, Provenance } from '@qagent/contracts';
import type { QAgentStorage } from '@qagent/storage';
import { createClient } from 'redis';

interface LegacyRedisClient {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  scanIterator(options: { MATCH: string; COUNT: number }): AsyncIterable<string[]>;
  json: {
    get(key: string): Promise<unknown>;
  };
}

interface LegacyFailure {
  errorMessage?: unknown;
  failureType?: unknown;
  file?: unknown;
  fixDescription?: unknown;
  fixDiff?: unknown;
  success?: unknown;
  createdAt?: unknown;
}

export interface RedisMigrationResult {
  scanned: number;
  imported: number;
  skipped: number;
}

export async function migrateLegacyRedis(
  storage: QAgentStorage,
  url: string,
  options: {
    clientFactory?: (url: string) => LegacyRedisClient;
  } = {}
): Promise<RedisMigrationResult> {
  const client: LegacyRedisClient =
    options.clientFactory?.(url) ?? (createClient({ url }) as unknown as LegacyRedisClient);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const entries: KnowledgeEntry[] = [];
    let scanned = 0;
    let skipped = 0;
    for await (const keys of client.scanIterator({ MATCH: 'failure:*', COUNT: 100 })) {
      for (const key of keys) {
        scanned += 1;
        const document = (await client.json.get(key)) as LegacyFailure | null;
        if (!document || typeof document.errorMessage !== 'string') {
          skipped += 1;
          continue;
        }
        const importedAt = new Date().toISOString();
        const provenance: Provenance = {
          source: 'legacy-redis',
          provider: 'redis',
          capturedAt:
            typeof document.createdAt === 'number' && Number.isFinite(document.createdAt)
              ? new Date(document.createdAt).toISOString()
              : importedAt,
        };
        entries.push({
          id: randomUUID(),
          failureSummary: document.errorMessage,
          failureType: typeof document.failureType === 'string' ? document.failureType : 'UNKNOWN',
          file: typeof document.file === 'string' ? document.file : null,
          fixSummary: typeof document.fixDescription === 'string' ? document.fixDescription : null,
          fixPatch: typeof document.fixDiff === 'string' ? document.fixDiff : null,
          successful: document.success === true,
          provenance,
          importedAt,
        });
      }
    }
    return { scanned, imported: storage.importKnowledgeEntries(entries), skipped };
  } finally {
    if (connected) await client.quit();
  }
}
