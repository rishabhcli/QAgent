import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CredentialStore,
  type CredentialStoreRuntime,
} from '../../apps/desktop/src/secure-store.js';
import { temporaryDirectory } from '../helpers.js';

vi.mock('electron', () => ({
  safeStorage: {},
}));

describe('desktop credential storage', () => {
  it('persists only encrypted values and reports environment credentials', async () => {
    const directory = await temporaryDirectory('qagent-credentials-');
    const path = join(directory, 'credentials.json');
    const runtime = encryptedRuntime();
    const store = new CredentialStore(path, { GITHUB_TOKEN: 'environment-token' }, runtime);

    await store.set('openai', 'openai-secret');

    expect(await store.values()).toMatchObject({ openai: 'openai-secret' });
    expect(await readFile(path, 'utf8')).not.toContain('openai-secret');
    expect(await store.statuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'openai', configured: true, storage: 'encrypted' }),
        expect.objectContaining({ provider: 'github', configured: true, storage: 'encrypted' }),
      ])
    );
  });

  it('reports configured credentials without initializing the macOS Keychain provider', async () => {
    const directory = await temporaryDirectory('qagent-passive-credential-status-');
    const path = join(directory, 'credentials.json');
    await writeFile(
      path,
      JSON.stringify({ version: 1, values: { openai: 'encrypted:openai-secret' } }),
      { mode: 0o600 }
    );
    const runtime = encryptedRuntime();
    const store = new CredentialStore(path, { GITHUB_TOKEN: 'environment-token' }, runtime);

    expect(await store.statuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'openai', configured: true, storage: 'encrypted' }),
        expect.objectContaining({ provider: 'github', configured: true, storage: 'encrypted' }),
      ])
    );
    expect(runtime.storage.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
    expect(runtime.storage.decryptStringAsync).not.toHaveBeenCalled();
    expect(runtime.storage.encryptStringAsync).not.toHaveBeenCalled();
  });

  it('keeps unsigned macOS credentials in session without touching Keychain', async () => {
    const directory = await temporaryDirectory('qagent-unsigned-macos-credentials-');
    const path = join(directory, 'credentials.json');
    const runtime = encryptedRuntime();
    const store = new CredentialStore(path, {}, runtime, {
      persistentStorageAllowed: false,
    });

    expect(await store.set('openai', 'session-secret')).toMatchObject({
      configured: true,
      storage: 'session-only',
    });
    expect(await store.values()).toEqual({ openai: 'session-secret' });
    expect(await store.statuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'openai', configured: true, storage: 'session-only' }),
      ])
    );
    expect(runtime.storage.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
    expect(runtime.storage.decryptStringAsync).not.toHaveBeenCalled();
    expect(runtime.storage.encryptStringAsync).not.toHaveBeenCalled();
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  it('keeps Linux basic_text credentials in memory and removes stale persisted values', async () => {
    const directory = await temporaryDirectory('qagent-basic-text-');
    const path = join(directory, 'credentials.json');
    const encrypted = new CredentialStore(path, {}, encryptedRuntime());
    await encrypted.set('openai', 'stale-encrypted-secret');

    const session = new CredentialStore(path, {}, basicTextRuntime());
    await session.set('openai', 'session-secret');

    expect(await session.values()).toEqual({ openai: 'session-secret' });
    expect(await readFile(path, 'utf8')).not.toContain('session-secret');
    expect(JSON.parse(await readFile(path, 'utf8')).values).not.toHaveProperty('openai');
    expect(await session.statuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'openai', configured: true, storage: 'session-only' }),
      ])
    );
  });

  it('serializes concurrent encrypted credential updates without losing a provider', async () => {
    const directory = await temporaryDirectory('qagent-concurrent-credentials-');
    const path = join(directory, 'credentials.json');
    const firstEncryption = deferred();
    const firstEncryptionStarted = deferred();
    const encryptionAvailable = vi.fn(async () => true);
    const encrypt = vi.fn(async (value: string) => {
      if (value === 'openai-secret') {
        firstEncryptionStarted.resolve();
        await firstEncryption.promise;
      }
      return Buffer.from(`encrypted:${value}`);
    });
    const runtime = encryptedRuntime();
    runtime.storage.encryptStringAsync = encrypt;
    runtime.storage.isAsyncEncryptionAvailable = encryptionAvailable;
    const store = new CredentialStore(path, {}, runtime);

    const openai = store.set('openai', 'openai-secret');
    await firstEncryptionStarted.promise;
    const github = store.set('github', 'github-secret');

    expect(encryptionAvailable).toHaveBeenCalledTimes(1);
    expect(encrypt).toHaveBeenCalledTimes(1);
    firstEncryption.resolve();
    await Promise.all([openai, github]);

    expect(await store.values()).toEqual({
      openai: 'openai-secret',
      github: 'github-secret',
    });
    const persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain('openai-secret');
    expect(persisted).not.toContain('github-secret');
  });

  it('keeps the previous session credential when stale cleanup fails', async () => {
    const directory = await temporaryDirectory('qagent-session-rollback-');
    const path = join(directory, 'credentials.json');
    const store = new CredentialStore(path, {}, basicTextRuntime());
    await store.set('openai', 'original-session-secret');
    await writeFile(
      path,
      JSON.stringify({ version: 1, values: { openai: 'stale-encrypted-value' } }),
      { mode: 0o600 }
    );
    await mkdir(`${path}.tmp`);

    await expect(store.set('openai', 'replacement-session-secret')).rejects.toThrow();

    expect(await store.values()).toEqual({ openai: 'original-session-secret' });
    expect(await readFile(path, 'utf8')).toContain('stale-encrypted-value');
  });

  it('keeps a session credential when clearing stale persistence fails', async () => {
    const directory = await temporaryDirectory('qagent-session-clear-rollback-');
    const path = join(directory, 'credentials.json');
    const store = new CredentialStore(path, {}, basicTextRuntime());
    await store.set('openai', 'original-session-secret');
    await writeFile(
      path,
      JSON.stringify({ version: 1, values: { openai: 'stale-encrypted-value' } }),
      { mode: 0o600 }
    );
    await mkdir(`${path}.tmp`);

    await expect(store.set('openai', '')).rejects.toThrow();

    expect(await store.values()).toEqual({ openai: 'original-session-secret' });
    expect(await readFile(path, 'utf8')).toContain('stale-encrypted-value');
  });

  it('retains a session credential when encrypted persistence fails', async () => {
    const directory = await temporaryDirectory('qagent-persistence-rollback-');
    const path = join(directory, 'credentials.json');
    let encryptionAvailable = false;
    const runtime = encryptedRuntime();
    runtime.storage.isAsyncEncryptionAvailable = vi.fn(async () => encryptionAvailable);
    const store = new CredentialStore(path, {}, runtime);
    await store.set('openai', 'original-session-secret');
    encryptionAvailable = true;
    await mkdir(`${path}.tmp`);

    await expect(store.set('openai', 'replacement-persistent-secret')).rejects.toThrow();

    encryptionAvailable = false;
    expect(await store.values()).toEqual({ openai: 'original-session-secret' });
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });
});

function encryptedRuntime(): CredentialStoreRuntime {
  return {
    platform: 'darwin',
    storage: {
      encryptStringAsync: vi.fn(async (value: string) => Buffer.from(`encrypted:${value}`)),
      decryptStringAsync: vi.fn(async (value: Buffer) => ({
        result: value.toString('utf8').replace(/^encrypted:/, ''),
        shouldReEncrypt: false,
      })),
      getSelectedStorageBackend: vi.fn(() => 'keychain'),
      isAsyncEncryptionAvailable: vi.fn(async () => true),
    },
  };
}

function basicTextRuntime(): CredentialStoreRuntime {
  return {
    platform: 'linux',
    storage: {
      encryptStringAsync: vi.fn(async () => {
        throw new Error('basic_text must not encrypt persistent credentials');
      }),
      decryptStringAsync: vi.fn(async () => {
        throw new Error('basic_text must not decrypt persistent credentials');
      }),
      getSelectedStorageBackend: vi.fn(() => 'basic_text'),
      isAsyncEncryptionAvailable: vi.fn(async () => true),
    },
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
