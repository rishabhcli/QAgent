import { z } from 'zod';
import { CommandSchema } from './config.js';
export {
  SpecialistActivitySchema,
  SpecialistCritiqueSchema,
  SpecialistDecisionSchema,
  SpecialistHandoffSchema,
  SpecialistObjectionSchema,
  SpecialistRoleSchema,
  SpecialistSourceSchema,
  SpecialistStatusSchema,
} from './specialists.js';
export type {
  SpecialistActivity,
  SpecialistCritique,
  SpecialistDecision,
  SpecialistHandoff,
  SpecialistObjection,
  SpecialistRole,
  SpecialistSource,
  SpecialistStatus,
} from './specialists.js';

export const RunActionSchema = z.enum([
  'retry',
  'resume',
  'reconnect',
  'cancel',
  'resolve_intervention',
]);

export const RunAttentionReasonSchema = z.enum([
  'policy_blocked',
  'provider_outage',
  'invalid_model_output',
  'browser_startup_failure',
  'dirty_checkout',
  'merge_waiting',
  'interrupted_recovery',
  'configuration_invalid',
  'target_startup_failure',
  'worktree_recovery_failed',
  'github_auth_required',
  'merge_conflict',
  'verification_failed',
  'publication_failed',
  'unexpected_failure',
]);

export const InterventionResolutionSchema = z.enum([
  'provider_reconfigured',
  'browser_installed',
  'checkout_cleaned',
  'policy_acknowledged',
  'github_requirements_recheck_requested',
  'recovery_confirmed',
]);

export const ApplicationActionSchema = z.enum([
  'configure_project',
  'configure_provider',
  'install_browser',
  'clean_checkout',
  'review_policy',
  'review_pull_request',
  'trust_project',
  'rerun_doctor',
]);

const CorrectiveActionBaseSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
});

export const CorrectiveActionSchema = z.discriminatedUnion('type', [
  CorrectiveActionBaseSchema.extend({
    type: z.literal('command'),
    command: CommandSchema,
  }),
  CorrectiveActionBaseSchema.extend({
    type: z.literal('application'),
    action: ApplicationActionSchema,
  }),
  CorrectiveActionBaseSchema.extend({
    type: z.literal('run'),
    action: RunActionSchema,
  }),
  CorrectiveActionBaseSchema.extend({
    type: z.literal('external'),
    url: z.url().refine((value) => {
      const parsed = new URL(value);
      return (
        parsed.protocol === 'https:' &&
        parsed.username === '' &&
        parsed.password === '' &&
        parsed.search === '' &&
        parsed.hash === ''
      );
    }, 'External corrective-action URLs must be sanitized HTTPS URLs without credentials, query parameters, or fragments'),
  }),
]);

export const InterventionResolutionInputSchema = z.object({
  kind: InterventionResolutionSchema,
  note: z.string().min(1).max(2_000).optional(),
  evidenceArtifactIds: z.array(z.uuid()).default([]),
});

export const RunInterventionSchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    reason: RunAttentionReasonSchema,
    summary: z.string().min(1).max(2_000),
    requiredAction: CorrectiveActionSchema,
    resolutionOptions: z.array(InterventionResolutionSchema).min(1),
    evidenceArtifactIds: z.array(z.uuid()).default([]),
    requestedAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().nullable(),
    resolution: InterventionResolutionInputSchema.nullable(),
  })
  .superRefine((value, context) => {
    if ((value.resolvedAt === null) !== (value.resolution === null)) {
      context.addIssue({
        code: 'custom',
        message: 'resolvedAt and resolution must either both be present or both be null',
        path: ['resolution'],
      });
    }
    if (value.resolution && !value.resolutionOptions.includes(value.resolution.kind)) {
      context.addIssue({
        code: 'custom',
        message: 'The resolution must be one of the offered resolutionOptions',
        path: ['resolution', 'kind'],
      });
    }
  });

export const RunActionRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('retry'),
    runId: z.uuid(),
    requestedBy: z.enum(['desktop', 'cli', 'mcp', 'recovery']).default('desktop'),
  }),
  z.object({
    action: z.literal('resume'),
    runId: z.uuid(),
    requestedBy: z.enum(['desktop', 'cli', 'mcp', 'recovery']).default('desktop'),
  }),
  z.object({
    action: z.literal('reconnect'),
    runId: z.uuid(),
    requestedBy: z.enum(['desktop', 'cli', 'mcp', 'recovery']).default('desktop'),
    afterSequence: z.number().int().nonnegative().default(0),
  }),
  z.object({
    action: z.literal('cancel'),
    runId: z.uuid(),
    requestedBy: z.enum(['desktop', 'cli', 'mcp', 'recovery']).default('desktop'),
    reason: z.string().min(1).max(500),
  }),
  z.object({
    action: z.literal('resolve_intervention'),
    runId: z.uuid(),
    requestedBy: z.enum(['desktop', 'cli', 'mcp', 'recovery']).default('desktop'),
    interventionId: z.uuid(),
    resolution: InterventionResolutionInputSchema,
  }),
]);

export const RunActionResultSchema = z.object({
  action: RunActionSchema,
  requestedRunId: z.uuid(),
  runId: z.uuid(),
  accepted: z.boolean(),
  eventIds: z.array(z.uuid()).default([]),
  reason: z.string().min(1).nullable(),
  occurredAt: z.iso.datetime(),
});

export const EvidenceAvailabilitySchema = z.enum(['ready', 'unavailable']);

export const EvidenceLinkSchema = z.object({
  artifactId: z.uuid(),
  label: z.string().min(1).max(500),
  relationship: z.enum(['supports', 'contradicts', 'produced', 'verifies']),
});

export const RunIsolationSchema = z
  .object({
    state: z.enum(['pending', 'ready', 'unavailable']),
    canonicalProjectPath: z.string().min(1),
    worktreePath: z.string().min(1).nullable(),
    branch: z.string().min(1).nullable(),
    baseSha: z.string().min(1).nullable(),
  })
  .superRefine((value, context) => {
    if (
      value.state === 'ready' &&
      (value.worktreePath === null || value.branch === null || value.baseSha === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Ready isolation requires a worktree path, branch, and base SHA',
      });
    }
  });

export const RunPolicyBoundarySchema = z.object({
  mutationMode: z.literal('dedicated-worktree'),
  activeCheckoutMutationAllowed: z.literal(false),
  dirtyCheckoutPublicationAllowed: z.literal(false),
  highRiskAutoMergeAllowed: z.literal(false),
  originalCheckoutDirty: z.boolean(),
  publishProvider: z.enum(['github', 'local']),
  baseBranch: z.string().min(1),
  autoMergeRequested: z.boolean(),
  publicationAllowed: z.boolean(),
  autoMergeAllowed: z.boolean(),
  blockedReasons: z.array(z.string().min(1)).default([]),
});

export const PublicationStateSchema = z.object({
  provider: z.literal('github'),
  repository: z.string().min(1),
  number: z.number().int().positive(),
  url: z.url(),
  headBranch: z.string().min(1),
  baseBranch: z.string().min(1),
  state: z.enum([
    'creating',
    'waiting_for_checks',
    'waiting_for_review',
    'merge_queue',
    'merge_conflict',
    'merged',
    'closed',
  ]),
  requiredAction: CorrectiveActionSchema.nullable(),
  capturedAt: z.iso.datetime(),
});

export const RunCursorSchema = z.object({
  runId: z.uuid(),
  afterSequence: z.number().int().nonnegative(),
  latestSequence: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export const TerminalEvidenceSchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    outcome: z.enum(['succeeded', 'failed', 'cancelled', 'policy_blocked']),
    summary: z.string().min(1).max(4_000),
    evidenceAvailability: EvidenceAvailabilitySchema,
    artifactIds: z.array(z.uuid()).default([]),
    evidenceLinks: z.array(EvidenceLinkSchema).default([]),
    evidenceUnavailableReason: z.string().min(1).max(1_000).nullable(),
    verificationId: z.uuid().nullable(),
    publication: PublicationStateSchema.nullable(),
    createdAt: z.iso.datetime(),
  })
  .superRefine((value, context) => {
    if (
      value.evidenceAvailability === 'ready' &&
      value.artifactIds.length === 0 &&
      value.evidenceLinks.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Ready terminal evidence requires an artifact reference',
        path: ['artifactIds'],
      });
    }
    if (value.evidenceAvailability === 'unavailable' && value.evidenceUnavailableReason === null) {
      context.addIssue({
        code: 'custom',
        message: 'Unavailable terminal evidence requires an explanation',
        path: ['evidenceUnavailableReason'],
      });
    }
  });

export type RunAction = z.infer<typeof RunActionSchema>;
export type RunAttentionReason = z.infer<typeof RunAttentionReasonSchema>;
export type InterventionResolution = z.infer<typeof InterventionResolutionSchema>;
export type CorrectiveAction = z.infer<typeof CorrectiveActionSchema>;
export type InterventionResolutionInput = z.infer<typeof InterventionResolutionInputSchema>;
export type RunIntervention = z.infer<typeof RunInterventionSchema>;
export type RunActionRequest = z.infer<typeof RunActionRequestSchema>;
export type RunActionResult = z.infer<typeof RunActionResultSchema>;
export type EvidenceAvailability = z.infer<typeof EvidenceAvailabilitySchema>;
export type EvidenceLink = z.infer<typeof EvidenceLinkSchema>;
export type RunIsolation = z.infer<typeof RunIsolationSchema>;
export type RunPolicyBoundary = z.infer<typeof RunPolicyBoundarySchema>;
export type PublicationState = z.infer<typeof PublicationStateSchema>;
export type RunCursor = z.infer<typeof RunCursorSchema>;
export type TerminalEvidence = z.infer<typeof TerminalEvidenceSchema>;
