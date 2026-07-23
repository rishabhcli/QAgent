import { z } from 'zod';

export const AvailabilitySchema = z.enum(['loading', 'ready', 'empty', 'unavailable', 'error']);

export const ProvenanceSchema = z.object({
  source: z.enum(['local', 'system', 'provider', 'github', 'weave', 'legacy-redis']),
  provider: z.string().optional(),
  capturedAt: z.iso.datetime(),
});

export const ProjectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  path: z.string(),
  trusted: z.boolean(),
  configPath: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const RunStageSchema = z.enum([
  'preflight',
  'discover',
  'test',
  'triage',
  'patch',
  'verify',
  'publish',
  'wait_checks',
  'merge',
  'postverify',
  'learn',
  'complete',
]);

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'policy_blocked',
]);

export const RunSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  status: RunStatusSchema,
  stage: RunStageSchema,
  requestedBy: z.enum(['desktop', 'cli', 'mcp', 'resume']),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  baseSha: z.string().nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  cancelRequestedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export const ArtifactSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  kind: z.enum(['log', 'screenshot', 'dom', 'patch', 'report', 'other']),
  name: z.string(),
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.string(),
  bytes: z.number().int().nonnegative(),
  provenance: ProvenanceSchema,
  createdAt: z.iso.datetime(),
});

export const DiagnosisSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  summary: z.string(),
  rootCause: z.string(),
  confidence: z.number().min(0).max(1),
  evidenceArtifactIds: z.array(z.uuid()),
  provenance: ProvenanceSchema,
  createdAt: z.iso.datetime(),
});

export const PatchSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  diagnosisId: z.uuid(),
  artifactId: z.uuid(),
  summary: z.string(),
  files: z.array(z.string()),
  risk: z.enum(['normal', 'high']),
  applied: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const VerificationSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  passed: z.boolean(),
  commands: z.array(
    z.object({
      executable: z.string(),
      args: z.array(z.string()),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().nonnegative(),
      artifactId: z.uuid(),
    })
  ),
  artifactIds: z.array(z.uuid()).default([]),
  createdAt: z.iso.datetime(),
});

export const TestCaseSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  kind: z.enum(['command', 'browser']),
  definition: z.record(z.string(), z.unknown()),
  provenance: ProvenanceSchema,
  createdAt: z.iso.datetime(),
});

export const ProviderCallSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  provider: z.string(),
  model: z.string(),
  purpose: z.enum(['triage', 'patch', 'browser', 'other']),
  status: z.enum(['succeeded', 'failed']),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const IntegrationSchema = z.object({
  id: z.uuid(),
  provider: z.string(),
  status: z.enum(['unconfigured', 'configured', 'healthy', 'end-to-end-verified', 'error']),
  detail: z.string().nullable(),
  provenance: ProvenanceSchema,
  updatedAt: z.iso.datetime(),
});

export const KnowledgeEntrySchema = z.object({
  id: z.uuid(),
  failureSummary: z.string(),
  failureType: z.string(),
  file: z.string().nullable(),
  fixSummary: z.string().nullable(),
  fixPatch: z.string().nullable(),
  successful: z.boolean(),
  provenance: ProvenanceSchema,
  importedAt: z.iso.datetime(),
});

export type Availability = z.infer<typeof AvailabilitySchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type RunStage = z.infer<typeof RunStageSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type Run = z.infer<typeof RunSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type Diagnosis = z.infer<typeof DiagnosisSchema>;
export type Patch = z.infer<typeof PatchSchema>;
export type Verification = z.infer<typeof VerificationSchema>;
export type TestCase = z.infer<typeof TestCaseSchema>;
export type ProviderCall = z.infer<typeof ProviderCallSchema>;
export type Integration = z.infer<typeof IntegrationSchema>;
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

export interface DataEnvelope<T> {
  availability: Availability;
  data: T | null;
  provenance: Provenance;
  message?: string;
}
