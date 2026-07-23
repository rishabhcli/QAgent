import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import type { CredentialStatus, DesktopPreferences } from './ipc.js';

const PROVIDERS = ['openai', 'anthropic', 'google', 'github', 'weave', 'browserbase'] as const;
export type CredentialProvider = (typeof PROVIDERS)[number];

interface StoredCredentials {
  version: 1;
  values: Partial<Record<CredentialProvider, string>>;
}

export class CredentialStore {
  private readonly session = new Map<CredentialProvider, string>();

  constructor(private readonly path: string) {}

  async set(provider: CredentialProvider, value: string): Promise<CredentialStatus> {
    if (!PROVIDERS.includes(provider)) throw new Error('Unsupported credential provider');
    if (!value) {
      this.session.delete(provider);
      const stored = await this.readStored();
      delete stored.values[provider];
      await this.writeStored(stored);
      return this.status(provider);
    }
    if (!this.canPersist()) {
      this.session.set(provider, value);
      return this.status(provider);
    }
    const stored = await this.readStored();
    stored.values[provider] = safeStorage.encryptString(value).toString('base64');
    await this.writeStored(stored);
    return this.status(provider);
  }

  async values(): Promise<Partial<Record<CredentialProvider, string>>> {
    const stored = await this.readStored();
    const values: Partial<Record<CredentialProvider, string>> = {
      ...Object.fromEntries(this.session),
    };
    if (Object.keys(stored.values).length === 0) return values;
    if (process.platform === 'linux' && !safeStorage.isEncryptionAvailable()) return values;
    for (const provider of PROVIDERS) {
      const encrypted = stored.values[provider];
      if (!encrypted) continue;
      try {
        values[provider] = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch {
        delete values[provider];
      }
    }
    return values;
  }

  async statuses(): Promise<CredentialStatus[]> {
    return Promise.all(PROVIDERS.map((provider) => this.status(provider)));
  }

  private async status(provider: CredentialProvider): Promise<CredentialStatus> {
    const values = await this.values();
    return {
      provider,
      configured: Boolean(values[provider]),
      storage: this.storageMode(),
    };
  }

  private canPersist(): boolean {
    return this.storageMode() === 'encrypted';
  }

  private storageMode(): CredentialStatus['storage'] {
    if (!safeStorage.isEncryptionAvailable()) return 'unavailable';
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      return 'session-only';
    }
    return 'encrypted';
  }

  private async readStored(): Promise<StoredCredentials> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as StoredCredentials;
      return value.version === 1 && value.values ? value : { version: 1, values: {} };
    } catch {
      return { version: 1, values: {} };
    }
  }

  private async writeStored(credentials: StoredCredentials): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(credentials), { mode: 0o600 });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}

export class PreferencesStore {
  constructor(private readonly path: string) {}

  async read(): Promise<DesktopPreferences> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as Partial<DesktopPreferences>;
      return {
        weaveDisclosureAccepted: value.weaveDisclosureAccepted === true,
        weaveEnabled: value.weaveEnabled !== false,
      };
    } catch {
      return { weaveDisclosureAccepted: false, weaveEnabled: true };
    }
  }

  async write(value: DesktopPreferences): Promise<DesktopPreferences> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, this.path);
    return value;
  }
}
