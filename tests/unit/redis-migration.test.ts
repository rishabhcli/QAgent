import { join } from 'node:path';
import { QAgentStorage } from '@qagent/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { temporaryDirectory } from '../helpers.js';

const redisState = {
  documents: new Map<string, unknown>(),
  connect: vi.fn(async () => undefined),
  quit: vi.fn(async () => undefined),
  scanError: null as Error | null,
};

function clientFactory() {
  return {
    connect: redisState.connect,
    quit: redisState.quit,
    scanIterator: async function* () {
      if (redisState.scanError) throw redisState.scanError;
      yield [...redisState.documents.keys()];
    },
    json: {
      get: vi.fn(async (key: string) => redisState.documents.get(key) ?? null),
    },
  };
}

import { migrateLegacyRedis } from '@qagent/adapters';

const openStorage: QAgentStorage[] = [];

afterEach(() => {
  redisState.documents.clear();
  redisState.scanError = null;
  redisState.connect.mockClear();
  redisState.quit.mockClear();
  for (const storage of openStorage.splice(0)) storage.close();
});

describe('legacy Redis migration', () => {
  it('imports fix knowledge with legacy provenance and never maps credentials', async () => {
    redisState.documents.set('failure:one', {
      errorMessage: 'Counter failed',
      failureType: 'UI_BUG',
      file: 'src/counter.mjs',
      fixDescription: 'Increment once',
      fixDiff: 'diff',
      success: true,
      createdAt: Date.parse('2026-01-02T03:04:05.000Z'),
      apiKey: 'must-not-import',
    });
    redisState.documents.set('failure:invalid', { errorMessage: 42 });
    redisState.documents.set('failure:null', null);
    redisState.documents.set('failure:minimal', {
      errorMessage: 'Minimal legacy record',
      createdAt: 'not-a-number',
    });
    const storage = await createStorage();
    const result = await migrateLegacyRedis(storage, 'redis://127.0.0.1:6379', {
      clientFactory,
    });

    expect(result).toEqual({ scanned: 4, imported: 2, skipped: 2 });
    expect(redisState.connect).toHaveBeenCalledOnce();
    expect(redisState.quit).toHaveBeenCalledOnce();
    const entries = storage.listKnowledgeEntries();
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.failureSummary === 'Counter failed')).toMatchObject({
      failureSummary: 'Counter failed',
      successful: true,
      provenance: {
        source: 'legacy-redis',
        provider: 'redis',
        capturedAt: '2026-01-02T03:04:05.000Z',
      },
    });
    expect(JSON.stringify(entries)).not.toContain('must-not-import');
    expect(entries.find((entry) => entry.failureSummary === 'Minimal legacy record')).toMatchObject(
      {
        failureType: 'UNKNOWN',
        file: null,
        fixSummary: null,
        fixPatch: null,
        successful: false,
      }
    );
  });

  it('quits the Redis client when scanning fails', async () => {
    redisState.scanError = new Error('scan failed');
    const storage = await createStorage();
    await expect(migrateLegacyRedis(storage, 'redis://invalid', { clientFactory })).rejects.toThrow(
      'scan failed'
    );
    expect(redisState.quit).toHaveBeenCalledOnce();
  });

  it('does not quit a client that never connected', async () => {
    const storage = await createStorage();
    const connect = vi.fn(async () => {
      throw new Error('connect failed');
    });
    await expect(
      migrateLegacyRedis(storage, 'redis://invalid', {
        clientFactory: () => ({
          ...clientFactory(),
          connect,
        }),
      })
    ).rejects.toThrow('connect failed');
    expect(connect).toHaveBeenCalledOnce();
    expect(redisState.quit).not.toHaveBeenCalled();
  });
});

async function createStorage() {
  const root = await temporaryDirectory('qagent-redis-');
  const storage = new QAgentStorage(join(root, 'qagent.sqlite'));
  openStorage.push(storage);
  return storage;
}
