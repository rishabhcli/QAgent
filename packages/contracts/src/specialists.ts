import { z } from 'zod';

export const SpecialistRoleSchema = z.enum(['scout', 'trace', 'patch', 'proof', 'gate']);

const SPECIALIST_LABEL_BY_ROLE = {
  scout: 'Scout',
  trace: 'Trace',
  patch: 'Patch',
  proof: 'Proof',
  gate: 'Gate',
} as const;

export const SpecialistIdentitySchema = z
  .object({
    role: SpecialistRoleSchema,
    label: z.enum(['Scout', 'Trace', 'Patch', 'Proof', 'Gate']),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.label !== SPECIALIST_LABEL_BY_ROLE[value.role]) {
      context.addIssue({
        code: 'custom',
        message: `Specialist ${value.role} must use the ${SPECIALIST_LABEL_BY_ROLE[value.role]} identity`,
        path: ['label'],
      });
    }
  });

export const SPECIALIST_IDENTITIES = Object.freeze(
  SpecialistRoleSchema.options.map((role) =>
    SpecialistIdentitySchema.parse({ role, label: SPECIALIST_LABEL_BY_ROLE[role] })
  )
);

export const SpecialistStatusSchema = z.enum([
  'started',
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
]);

export const SpecialistSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('provider_call'),
    providerCallId: z.uuid(),
  }),
  z.object({
    kind: z.literal('policy_worker'),
    worker: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9._-]+$/),
    invocationId: z.uuid(),
  }),
]);

const evidenceIdsSchema = z.array(z.uuid()).max(64);
const summarySchema = z.string().min(1).max(2_048);

export const SpecialistActivitySchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    role: SpecialistRoleSchema,
    status: SpecialistStatusSchema,
    summary: summarySchema,
    source: SpecialistSourceSchema,
    occurredAt: z.iso.datetime(),
    attempt: z.number().int().positive(),
    evidenceIds: evidenceIdsSchema,
    handoffTarget: SpecialistRoleSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status !== 'started' &&
      value.status !== 'cancelled' &&
      value.evidenceIds.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Terminal specialist activity must cite durable evidence',
        path: ['evidenceIds'],
      });
    }
  });

export const SpecialistCritiqueSchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    activityId: z.uuid(),
    role: SpecialistRoleSchema,
    verdict: z.enum(['accepted', 'revision_required', 'rejected']),
    summary: summarySchema,
    source: SpecialistSourceSchema,
    occurredAt: z.iso.datetime(),
    attempt: z.number().int().positive(),
    evidenceIds: evidenceIdsSchema.min(1),
    actionRequired: z.string().min(1).max(2_048).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.verdict !== 'accepted' && value.actionRequired === null) {
      context.addIssue({
        code: 'custom',
        message: 'Revision and rejection critiques require an explicit action',
        path: ['actionRequired'],
      });
    }
  });

export const SpecialistObjectionSchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    activityId: z.uuid().nullable(),
    role: SpecialistRoleSchema,
    summary: summarySchema,
    reason: summarySchema,
    actionRequired: z.string().min(1).max(2_048),
    source: SpecialistSourceSchema,
    occurredAt: z.iso.datetime(),
    attempt: z.number().int().positive(),
    evidenceIds: evidenceIdsSchema.min(1),
  })
  .strict();

export const SpecialistDecisionSchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    role: SpecialistRoleSchema,
    action: z.enum(['continue', 'retry', 'handoff', 'complete', 'block']),
    summary: summarySchema,
    source: SpecialistSourceSchema,
    occurredAt: z.iso.datetime(),
    attempt: z.number().int().positive(),
    evidenceIds: evidenceIdsSchema.min(1),
    handoffTarget: SpecialistRoleSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.action === 'handoff') !== (value.handoffTarget !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'handoffTarget is required only for handoff decisions',
        path: ['handoffTarget'],
      });
    }
  });

export const SpecialistHandoffSchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    from: SpecialistRoleSchema,
    to: SpecialistRoleSchema,
    summary: summarySchema,
    actionRequired: z.string().min(1).max(2_048).nullable(),
    source: SpecialistSourceSchema,
    occurredAt: z.iso.datetime(),
    attempt: z.number().int().positive(),
    evidenceIds: evidenceIdsSchema.min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.from === value.to) {
      context.addIssue({
        code: 'custom',
        message: 'A specialist handoff must name a different destination',
        path: ['to'],
      });
    }
  });

export type SpecialistRole = z.infer<typeof SpecialistRoleSchema>;
export type SpecialistIdentity = z.infer<typeof SpecialistIdentitySchema>;
export type SpecialistStatus = z.infer<typeof SpecialistStatusSchema>;
export type SpecialistSource = z.infer<typeof SpecialistSourceSchema>;
export type SpecialistActivity = z.infer<typeof SpecialistActivitySchema>;
export type SpecialistCritique = z.infer<typeof SpecialistCritiqueSchema>;
export type SpecialistObjection = z.infer<typeof SpecialistObjectionSchema>;
export type SpecialistDecision = z.infer<typeof SpecialistDecisionSchema>;
export type SpecialistHandoff = z.infer<typeof SpecialistHandoffSchema>;
