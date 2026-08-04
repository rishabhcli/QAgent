import { z } from 'zod';
import { CommandSchema, QAgentConfigSchema } from './config.js';
import { ReplayEventsRequestSchema, RunEventReplayPageSchema, RunEventSchema } from './events.js';
import { RunManifestRecordSchema, RunProjectionSchema, StageAttemptSchema } from './lifecycle.js';
import {
  ArtifactSchema,
  AvailabilitySchema,
  DiagnosisSchema,
  ExternalEvidenceSchema,
  IntegrationRequirementSchema,
  IntegrationSchema,
  IntegrationStatusSchema,
  PatchSchema,
  ProjectSchema,
  ProvenanceSchema,
  ProviderCallSchema,
  RunSchema,
  TestCaseSchema,
  VerificationSchema,
} from './records.js';
import {
  CorrectiveActionSchema,
  EvidenceLinkSchema,
  PublicationStateSchema,
  RunActionRequestSchema,
  RunActionResultSchema,
  RunCursorSchema,
  RunIsolationSchema,
  RunPolicyBoundarySchema,
  TerminalEvidenceSchema,
} from './workflow.js';
import {
  SpecialistActivitySchema,
  SpecialistCritiqueSchema,
  SpecialistDecisionSchema,
  SpecialistHandoffSchema,
  SpecialistObjectionSchema,
} from './specialists.js';

type CommandValue = z.infer<typeof CommandSchema>;

function commandEqual(left: CommandValue, right: CommandValue): boolean {
  const leftEnv = Object.entries(left.env).sort(([first], [second]) => first.localeCompare(second));
  const rightEnv = Object.entries(right.env).sort(([first], [second]) =>
    first.localeCompare(second)
  );
  return (
    left.executable === right.executable &&
    left.cwd === right.cwd &&
    left.timeoutMs === right.timeoutMs &&
    left.args.length === right.args.length &&
    left.args.every((argument, index) => argument === right.args[index]) &&
    leftEnv.length === rightEnv.length &&
    leftEnv.every(
      ([key, value], index) => key === rightEnv[index]?.[0] && value === rightEnv[index]?.[1]
    )
  );
}

function commandListsEqual(left: CommandValue[], right: CommandValue[]): boolean {
  return (
    left.length === right.length &&
    left.every((command, index) => {
      const other = right[index];
      return other !== undefined && commandEqual(command, other);
    })
  );
}

export const RunRequestSchema = z.object({
  projectId: z.uuid(),
  requestedBy: z.enum(['desktop', 'cli', 'mcp', 'resume']).default('desktop'),
  resumeRunId: z.uuid().optional(),
});

export const DoctorCheckSchema = z
  .object({
    id: z.string().min(1),
    code: z
      .string()
      .min(1)
      .regex(/^[a-z0-9._-]+$/),
    label: z.string().min(1),
    status: z.enum(['pass', 'warn', 'fail']),
    detail: z.string().min(1),
    source: z.string().min(1),
    checkedAt: z.iso.datetime(),
    providerState: IntegrationStatusSchema.optional(),
    correctiveAction: CorrectiveActionSchema.nullable(),
    evidence: z.array(ExternalEvidenceSchema).optional(),
  })
  .superRefine((value, context) => {
    if (value.status !== 'pass' && value.correctiveAction === null) {
      context.addIssue({
        code: 'custom',
        message: 'Every non-passing Doctor check requires a corrective action',
        path: ['correctiveAction'],
      });
    }
    if (value.status === 'pass' && value.correctiveAction !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Passing Doctor checks must not offer corrective actions',
        path: ['correctiveAction'],
      });
    }
  });

export const DoctorReportSchema = z.object({
  status: z.enum(['ready', 'degraded', 'blocked']),
  checks: z.array(DoctorCheckSchema),
  checkedAt: z.iso.datetime(),
});

export const ProjectStackSchema = z.enum([
  'node',
  'python',
  'ruby',
  'go',
  'java',
  'dotnet',
  'unknown',
]);

export const ProjectTrustPreviewSchema = z.object({
  requestedPath: z.string().min(1),
  canonicalPath: z.string().min(1),
  configPath: z.string().min(1).nullable(),
  exactCommands: z.object({
    test: z.array(CommandSchema),
    verify: z.array(CommandSchema),
    start: CommandSchema.nullable(),
  }),
  policyBoundary: z.object({
    commandsExecuteWithUserPrivileges: z.literal(true),
    mutationsUseDedicatedWorktree: z.literal(true),
    activeCheckoutMutationAllowed: z.literal(false),
    trustRequiredBeforeExecution: z.literal(true),
  }),
});

export const ProjectInspectionSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
    stack: ProjectStackSchema,
    configPath: z.string().min(1).nullable(),
    config: QAgentConfigSchema.nullable(),
    suggestedTestCommands: z.array(CommandSchema),
    suggestedVerifyCommands: z.array(CommandSchema),
    suggestedStartCommand: CommandSchema.nullable(),
    needsConfiguration: z.boolean(),
    trustPreview: ProjectTrustPreviewSchema,
  })
  .superRefine((value, context) => {
    if (value.path !== value.trustPreview.canonicalPath) {
      context.addIssue({
        code: 'custom',
        message: 'The inspected project path must be the canonical trust path',
        path: ['trustPreview', 'canonicalPath'],
      });
    }
    if (
      !commandListsEqual(value.suggestedTestCommands, value.trustPreview.exactCommands.test) ||
      !commandListsEqual(value.suggestedVerifyCommands, value.trustPreview.exactCommands.verify) ||
      (value.suggestedStartCommand === null) !==
        (value.trustPreview.exactCommands.start === null) ||
      (value.suggestedStartCommand !== null &&
        value.trustPreview.exactCommands.start !== null &&
        !commandEqual(value.suggestedStartCommand, value.trustPreview.exactCommands.start))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The trust preview must show the exact detected commands',
        path: ['trustPreview', 'exactCommands'],
      });
    }
  });

export const RunLaunchSchema = z.object({
  run: RunSchema,
  project: ProjectSchema,
  isolation: RunIsolationSchema,
  policyBoundary: RunPolicyBoundarySchema,
  commands: z.object({
    test: z.array(CommandSchema),
    verify: z.array(CommandSchema),
    start: CommandSchema.nullable(),
  }),
});

export const RunDetailSchema = z.object({
  run: RunSchema,
  events: z.array(RunEventSchema),
  artifacts: z.array(ArtifactSchema),
  diagnosis: DiagnosisSchema.nullable(),
  patch: PatchSchema.nullable(),
  verification: VerificationSchema.nullable(),
  providerCalls: z.array(ProviderCallSchema),
  specialistActivities: z.array(SpecialistActivitySchema).default([]),
  specialistCritiques: z.array(SpecialistCritiqueSchema).default([]),
  specialistDecisions: z.array(SpecialistDecisionSchema).default([]),
  specialistObjections: z.array(SpecialistObjectionSchema).default([]),
  specialistHandoffs: z.array(SpecialistHandoffSchema).default([]),
  stageAttempts: z.array(StageAttemptSchema).default([]),
  projection: RunProjectionSchema.nullable().default(null),
  manifest: RunManifestRecordSchema.nullable().default(null),
  terminalEvidence: TerminalEvidenceSchema.nullable().default(null),
  publication: PublicationStateSchema.nullable().default(null),
  cursor: RunCursorSchema,
  evidenceLinks: z.array(EvidenceLinkSchema).default([]),
});

export function dataEnvelopeSchema<T extends z.ZodType>(
  dataSchema: T
): z.ZodObject<{
  availability: typeof AvailabilitySchema;
  data: z.ZodNullable<T>;
  provenance: typeof ProvenanceSchema;
  message: z.ZodOptional<z.ZodString>;
}> {
  return z.object({
    availability: AvailabilitySchema,
    data: dataSchema.nullable(),
    provenance: ProvenanceSchema,
    message: z.string().optional(),
  });
}

export const BootstrapSnapshotSchema = z.object({
  projects: dataEnvelopeSchema(z.array(ProjectSchema)),
  runs: dataEnvelopeSchema(z.array(RunSchema)),
  tests: dataEnvelopeSchema(z.array(TestCaseSchema)),
  integrations: dataEnvelopeSchema(z.array(IntegrationSchema)),
});

export const IntegrationProviderSchema = z.enum(['model', 'browser', 'github', 'weave']);

export const IntegrationVerifyRequestSchema = z.object({
  provider: IntegrationProviderSchema,
  projectId: z.uuid().optional(),
  requestedBy: z.enum(['desktop', 'cli', 'mcp']).default('desktop'),
  weaveDisclosureAccepted: z.boolean().default(false),
});

export const IntegrationVerifyResultSchema = z
  .object({
    provider: IntegrationProviderSchema,
    integration: IntegrationSchema,
    disclosureRequired: z.boolean(),
    correctiveAction: CorrectiveActionSchema.nullable(),
    verifiedAt: z.iso.datetime(),
  })
  .superRefine((value, context) => {
    if (
      value.provider === 'weave' &&
      value.disclosureRequired &&
      (value.integration.status === 'healthy' || value.integration.status === 'end-to-end-verified')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Weave cannot be verified before disclosure is accepted',
        path: ['integration', 'status'],
      });
    }
  });

export const DesktopPreferencesSchema = z.object({
  weaveDisclosureAccepted: z.boolean(),
  weaveEnabled: z.boolean(),
  browserbaseProjectId: z.string().trim().max(256).default(''),
});

export const CredentialStatusSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'google', 'github', 'weave', 'browserbase']),
  configured: z.boolean(),
  storage: z.enum(['encrypted', 'session-only', 'unavailable']),
  requirements: z.array(IntegrationRequirementSchema).default([]),
});

export const ArtifactPreviewSchema = z.object({
  mimeType: z.string().min(1),
  encoding: z.enum(['base64', 'utf8']),
  data: z.string(),
});

export type RunRequest = z.infer<typeof RunRequestSchema>;
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;
export type DoctorReport = z.infer<typeof DoctorReportSchema>;
export type ProjectStack = z.infer<typeof ProjectStackSchema>;
export type ProjectTrustPreview = z.infer<typeof ProjectTrustPreviewSchema>;
export type ProjectInspection = z.infer<typeof ProjectInspectionSchema>;
export type RunLaunch = z.infer<typeof RunLaunchSchema>;
export type RunDetail = z.infer<typeof RunDetailSchema>;
export type BootstrapSnapshot = z.infer<typeof BootstrapSnapshotSchema>;
export type IntegrationProvider = z.infer<typeof IntegrationProviderSchema>;
export type IntegrationVerifyRequest = z.infer<typeof IntegrationVerifyRequestSchema>;
export type IntegrationVerifyResult = z.infer<typeof IntegrationVerifyResultSchema>;
export type DesktopPreferences = z.infer<typeof DesktopPreferencesSchema>;
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>;
export type ArtifactPreview = z.infer<typeof ArtifactPreviewSchema>;

export {
  ReplayEventsRequestSchema,
  RunEventReplayPageSchema,
  RunActionRequestSchema,
  RunActionResultSchema,
};
