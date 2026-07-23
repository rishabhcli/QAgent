import { join } from 'node:path';
import {
  DisabledTraceSink,
  LocalTraceSink,
  resolveQAgentHome,
  WeaveTraceSink,
  type ModelCredentials,
} from '@qagent/adapters';
import { ArtifactStore, QAgentStorage } from '@qagent/storage';
import { QAgentEngine } from './engine.js';

export interface LocalRuntimeOptions {
  home?: string;
  modelCredentials?: ModelCredentials;
  githubToken?: string;
  weaveDisclosureAccepted?: boolean;
  weaveEnabled?: boolean;
  weaveProject?: string;
}

export interface LocalRuntime {
  home: string;
  storage: QAgentStorage;
  artifacts: ArtifactStore;
  engine: QAgentEngine;
  close(): void;
}

export function createLocalRuntime(options: LocalRuntimeOptions = {}): LocalRuntime {
  const home = options.home ?? resolveQAgentHome();
  const storage = new QAgentStorage(join(home, 'qagent.sqlite'));
  const artifacts = new ArtifactStore(join(home, 'artifacts'), storage);
  const weaveEnabled = options.weaveEnabled ?? strictEnvFlag('QAGENT_WEAVE_ENABLED', true);
  const disclosure =
    options.weaveDisclosureAccepted ?? strictEnvFlag('QAGENT_WEAVE_DISCLOSURE_ACCEPTED', false);
  const traceSink = !weaveEnabled
    ? new DisabledTraceSink()
    : disclosure && process.env.WANDB_API_KEY
      ? new WeaveTraceSink(options.weaveProject ?? process.env.WEAVE_PROJECT ?? 'qagent', true)
      : new LocalTraceSink();
  const engine = new QAgentEngine({
    storage,
    artifactStore: artifacts,
    qagentHome: home,
    modelCredentials: options.modelCredentials,
    githubToken: options.githubToken,
    traceSink,
  });
  return {
    home,
    storage,
    artifacts,
    engine,
    close: () => storage.close(),
  };
}

export function strictEnvFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}
