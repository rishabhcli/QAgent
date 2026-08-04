import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import type { CredentialStatus, DesktopPreferences } from './ipc.js';

const PROVIDERS = ['openai', 'anthropic', 'google', 'github', 'weave', 'browserbase'] as const;
export type CredentialProvider = (typeof PROVIDERS)[number];

const ENVIRONMENT_CREDENTIALS: Record<CredentialProvider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  github: 'GITHUB_TOKEN',
  weave: 'WANDB_API_KEY',
  browserbase: 'BROWSERBASE_API_KEY',
};

interface StoredCredentials {
  version: 1;
  values: Partial<Record<CredentialProvider, string>>;
}

type SafeStorageBridge = Pick<
  typeof safeStorage,
  | 'decryptStringAsync'
  | 'encryptStringAsync'
  | 'getSelectedStorageBackend'
  | 'isAsyncEncryptionAvailable'
>;

export interface CredentialStoreRuntime {
  platform: NodeJS.Platform;
  storage: SafeStorageBridge;
}

export interface CredentialStoreOptions {
  persistentStorageAllowed: boolean;
}

export class CredentialStore {
  private readonly session = new Map<CredentialProvider, string>();
  private operationTail: Promise<void> = Promise.resolve();
  private observedStorageMode: CredentialStatus['storage'] | null = null;

  constructor(
    private readonly path: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly runtime: CredentialStoreRuntime = {
      platform: process.platform,
      storage: safeStorage,
    },
    private readonly options: CredentialStoreOptions = {
      persistentStorageAllowed: true,
    }
  ) {}

  async set(provider: CredentialProvider, value: string): Promise<CredentialStatus> {
    if (!PROVIDERS.includes(provider)) throw new Error('Unsupported credential provider');
    return this.runSerialized(() => this.setSerialized(provider, value));
  }

  async values(): Promise<Partial<Record<CredentialProvider, string>>> {
    return this.runSerialized(() => this.valuesSerialized());
  }

  private async setSerialized(
    provider: CredentialProvider,
    value: string
  ): Promise<CredentialStatus> {
    if (!value) {
      const stored = await this.readStored();
      if (Object.hasOwn(stored.values, provider)) {
        delete stored.values[provider];
        await this.writeStored(stored);
      }
      this.session.delete(provider);
      return this.credentialStatus(provider, {}, this.storageCapability());
    }
    const storage = await this.storageMode();
    if (storage !== 'encrypted') {
      const stored = await this.readStored();
      if (Object.hasOwn(stored.values, provider)) {
        delete stored.values[provider];
        await this.writeStored(stored);
      }
      this.session.set(provider, value);
      return this.credentialStatus(provider, { [provider]: value }, storage);
    }
    const stored = await this.readStored();
    stored.values[provider] = (await this.runtime.storage.encryptStringAsync(value)).toString(
      'base64'
    );
    await this.writeStored(stored);
    this.session.delete(provider);
    return this.credentialStatus(provider, { [provider]: value }, storage);
  }

  private async valuesSerialized(): Promise<Partial<Record<CredentialProvider, string>>> {
    const stored = await this.readStored();
    const values: Partial<Record<CredentialProvider, string>> = {
      ...Object.fromEntries(this.session),
    };
    if (Object.keys(stored.values).length === 0) return values;
    if ((await this.storageMode()) !== 'encrypted') return values;
    let rotated = false;
    for (const provider of PROVIDERS) {
      const encrypted = stored.values[provider];
      if (!encrypted) continue;
      try {
        const decrypted = await this.runtime.storage.decryptStringAsync(
          Buffer.from(encrypted, 'base64')
        );
        values[provider] = decrypted.result;
        if (decrypted.shouldReEncrypt) {
          stored.values[provider] = (
            await this.runtime.storage.encryptStringAsync(decrypted.result)
          ).toString('base64');
          rotated = true;
        }
      } catch {
        delete values[provider];
      }
    }
    if (rotated) await this.writeStored(stored);
    return values;
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async statuses(): Promise<CredentialStatus[]> {
    return this.runSerialized(() => this.statusesSerialized());
  }

  private async statusesSerialized(): Promise<CredentialStatus[]> {
    const storage = this.storageCapability();
    const stored: StoredCredentials =
      storage === 'encrypted' ? await this.readStored() : { version: 1, values: {} };
    const values: Partial<Record<CredentialProvider, string>> = {
      ...Object.fromEntries(this.session),
    };
    for (const provider of PROVIDERS) {
      if (stored.values[provider]) values[provider] = 'stored';
    }
    return PROVIDERS.map((provider) => this.credentialStatus(provider, values, storage));
  }

  private credentialStatus(
    provider: CredentialProvider,
    values: Partial<Record<CredentialProvider, string>>,
    storage: CredentialStatus['storage']
  ): CredentialStatus {
    const configured = Boolean(
      values[provider] || this.environment[ENVIRONMENT_CREDENTIALS[provider]]
    );
    return {
      provider,
      configured,
      storage,
      requirements: [
        {
          id: `${provider}.credential`,
          label: `${provider} credential`,
          state: configured ? 'configured' : 'missing',
          secret: true,
        },
      ],
    };
  }

  private storageCapability(includeObservedMode = true): CredentialStatus['storage'] {
    if (!this.options.persistentStorageAllowed) return 'session-only';
    if (this.runtime.platform !== 'linux') {
      return includeObservedMode ? (this.observedStorageMode ?? 'encrypted') : 'encrypted';
    }
    const backend = this.runtime.storage.getSelectedStorageBackend();
    if (backend === 'basic_text') {
      return 'session-only';
    }
    if (backend === 'unknown') return 'unavailable';
    return includeObservedMode ? (this.observedStorageMode ?? 'encrypted') : 'encrypted';
  }

  private async storageMode(): Promise<CredentialStatus['storage']> {
    const capability = this.storageCapability(false);
    if (capability !== 'encrypted') return capability;
    this.observedStorageMode = (await this.runtime.storage.isAsyncEncryptionAvailable())
      ? 'encrypted'
      : 'unavailable';
    return this.observedStorageMode;
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
        weaveEnabled: value.weaveEnabled === true,
        browserbaseProjectId:
          typeof value.browserbaseProjectId === 'string' ? value.browserbaseProjectId : '',
      };
    } catch {
      return {
        weaveDisclosureAccepted: false,
        weaveEnabled: false,
        browserbaseProjectId: '',
      };
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
