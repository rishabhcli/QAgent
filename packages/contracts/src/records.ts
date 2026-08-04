import { z } from 'zod';
import { RunActionSchema, RunAttentionReasonSchema, RunInterventionSchema } from './workflow.js';
import { SpecialistRoleSchema } from './specialists.js';

export const AvailabilitySchema = z.enum(['loading', 'ready', 'empty', 'unavailable', 'error']);

export const SanitizedHttpsUrlSchema = z.url().refine((value) => {
  const parsed = new URL(value);
  return (
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === ''
  );
}, 'Evidence URLs must be sanitized HTTPS URLs without credentials, query parameters, or fragments');

export const AuthorizationEvidenceSchema = z.enum(['not-applicable', 'unverified', 'verified']);

export const ExternalEvidenceSchema = z.object({
  sourceUrl: SanitizedHttpsUrlSchema,
  capturedAt: z.iso.datetime(),
  kind: z.enum(['page-inspection', 'provider-probe', 'end-to-end-workflow']),
  authorization: AuthorizationEvidenceSchema.default('unverified'),
  summary: z.string().min(1).max(2_000),
});

export const ProvenanceSchema = z.object({
  source: z.enum(['local', 'system', 'provider', 'github', 'weave', 'legacy-redis']),
  provider: z.string().optional(),
  capturedAt: z.iso.datetime(),
  sourceUrl: SanitizedHttpsUrlSchema.optional(),
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
  'waiting_for_intervention',
  'interrupted',
  'succeeded',
  'failed',
  'cancelled',
  'policy_blocked',
]);

export const RunSchema = z
  .object({
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
    attempt: z.number().int().positive().default(1),
    retryOfRunId: z.uuid().nullable().default(null),
    availableActions: z.array(RunActionSchema).default([]),
    intervention: RunInterventionSchema.nullable().default(null),
    failureCode: RunAttentionReasonSchema.nullable().default(null),
    lastHeartbeatAt: z.iso.datetime().nullable().default(null),
    recoveryCount: z.number().int().nonnegative().default(0),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .superRefine((value, context) => {
    if (new Set(value.availableActions).size !== value.availableActions.length) {
      context.addIssue({
        code: 'custom',
        message: 'availableActions must not contain duplicates',
        path: ['availableActions'],
      });
    }

    const terminal = ['succeeded', 'failed', 'cancelled', 'policy_blocked'].includes(value.status);
    if (terminal && value.availableActions.some((action) => action !== 'retry')) {
      context.addIssue({
        code: 'custom',
        message: 'Terminal runs may only offer retry',
        path: ['availableActions'],
      });
    }
    if (
      value.availableActions.includes('retry') &&
      value.status !== 'failed' &&
      value.status !== 'cancelled' &&
      value.status !== 'policy_blocked'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Retry is only available for a retryable terminal run',
        path: ['availableActions'],
      });
    }
    if (value.availableActions.includes('resume') && value.status !== 'interrupted') {
      context.addIssue({
        code: 'custom',
        message: 'Resume is only available for interrupted runs',
        path: ['availableActions'],
      });
    }
    if (
      value.availableActions.includes('resolve_intervention') &&
      value.status !== 'waiting_for_intervention'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Intervention resolution is only available while waiting for intervention',
        path: ['availableActions'],
      });
    }
    if (
      value.status === 'waiting_for_intervention' &&
      (value.intervention === null || !value.availableActions.includes('resolve_intervention'))
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Runs waiting for intervention require an unresolved intervention and a resolution action',
        path: ['intervention'],
      });
    }
    if (
      value.status === 'waiting_for_intervention' &&
      value.intervention &&
      (value.intervention.runId !== value.id ||
        value.intervention.resolution !== null ||
        value.failureCode !== value.intervention.reason)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A waiting run requires its own unresolved intervention and matching failure code',
        path: ['intervention'],
      });
    }
    if (value.status === 'interrupted' && !value.availableActions.includes('resume')) {
      context.addIssue({
        code: 'custom',
        message: 'Interrupted runs must offer durable resume',
        path: ['availableActions'],
      });
    }
    if (
      (value.status === 'failed' || value.status === 'policy_blocked') &&
      value.failureCode === null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Failed and policy-blocked runs require a stable failure code',
        path: ['failureCode'],
      });
    }
    if (value.status === 'succeeded' && value.failureCode !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Succeeded runs cannot retain a failure code',
        path: ['failureCode'],
      });
    }
    if (value.retryOfRunId === value.id) {
      context.addIssue({
        code: 'custom',
        message: 'A run cannot be its own retry ancestor',
        path: ['retryOfRunId'],
      });
    }
  });

export const ArtifactSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  kind: z.enum(['log', 'screenshot', 'dom', 'patch', 'report', 'manifest', 'other']),
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
  status: z.enum(['started', 'succeeded', 'failed', 'cancelled']),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  attempt: z.number().int().positive().optional(),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().nullable().optional(),
  durationMs: z.number().nonnegative().nullable().optional(),
  specialistRole: SpecialistRoleSchema.nullable().optional(),
  evidenceIds: z.array(z.uuid()).max(64).optional(),
  requestDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  responseDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  errorCode: z.string().max(128).nullable().optional(),
});

export const IntegrationStatusSchema = z.enum([
  'unconfigured',
  'configured',
  'healthy',
  'end-to-end-verified',
  'error',
]);

export const IntegrationRequirementSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  state: z.enum(['missing', 'configured', 'verified']),
  secret: z.boolean(),
});

export const IntegrationSchema = z.object({
  id: z.uuid(),
  provider: z.string(),
  status: IntegrationStatusSchema,
  detail: z.string().nullable(),
  requirements: z.array(IntegrationRequirementSchema).optional(),
  evidence: z.array(ExternalEvidenceSchema).optional(),
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
export type SanitizedHttpsUrl = z.infer<typeof SanitizedHttpsUrlSchema>;
export type AuthorizationEvidence = z.infer<typeof AuthorizationEvidenceSchema>;
export type ExternalEvidence = z.infer<typeof ExternalEvidenceSchema>;
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
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;
export type IntegrationRequirement = z.infer<typeof IntegrationRequirementSchema>;
export type Integration = z.infer<typeof IntegrationSchema>;
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

export interface DataEnvelope<T> {
  availability: Availability;
  data: T | null;
  provenance: Provenance;
  message?: string;
}
