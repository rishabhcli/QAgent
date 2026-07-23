import type {
  Artifact,
  DataEnvelope,
  Diagnosis,
  DoctorReport,
  Integration,
  Patch,
  Project,
  ProviderCall,
  Run,
  RunEvent,
  TestCase,
  Verification,
} from '@qagent/contracts';

export interface BootstrapSnapshot {
  projects: DataEnvelope<Project[]>;
  runs: DataEnvelope<Run[]>;
  tests: DataEnvelope<TestCase[]>;
  integrations: DataEnvelope<Integration[]>;
}

export interface RunDetailData {
  run: Run;
  events: RunEvent[];
  artifacts: Artifact[];
  diagnosis: Diagnosis | null;
  patch: Patch | null;
  verification: Verification | null;
  providerCalls: ProviderCall[];
}

export interface DetectedProjectData {
  name: string;
  path: string;
  stack: string;
  configPath: string | null;
  config: unknown;
  suggestedTestCommands: Array<{ executable: string; args: string[] }>;
  suggestedVerifyCommands: Array<{ executable: string; args: string[] }>;
  needsConfiguration: boolean;
}

export interface ArtifactPreview {
  mimeType: string;
  encoding: 'base64' | 'utf8';
  data: string;
}

export type AppView = 'projects' | 'runs' | 'tests' | 'settings';

export type { DoctorReport };
