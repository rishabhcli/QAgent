import { z } from 'zod';
import { CommandSchema } from './config.js';
import {
  ArtifactSchema,
  ProviderCallSchema,
  ProvenanceSchema,
  RunStageSchema,
  RunStatusSchema,
} from './records.js';
import {
  SpecialistActivitySchema,
  SpecialistCritiqueSchema,
  SpecialistDecisionSchema,
} from './specialists.js';

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const TraceStateSchema = z.enum(['local', 'queued', 'synced', 'failed', 'disabled']);

export const BoundedOutputSchema = z
  .object({
    text: z.string().max(65_536),
    originalBytes: z.number().int().nonnegative(),
    retainedBytes: z.number().int().nonnegative(),
    omittedBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    redactionCount: z.number().int().nonnegative(),
    backpressure: z
      .object({
        droppedChunks: z.number().int().nonnegative(),
        droppedBytes: z.number().int().nonnegative(),
      })
      .nullable(),
  })
  .superRefine((value, context) => {
    if (value.retainedBytes + value.omittedBytes !== value.originalBytes) {
      context.addIssue({
        code: 'custom',
        message: 'retainedBytes and omittedBytes must equal originalBytes',
        path: ['retainedBytes'],
      });
    }
    if (value.truncated !== value.omittedBytes > 0) {
      context.addIssue({
        code: 'custom',
        message: 'truncated must match whether bytes were omitted',
        path: ['truncated'],
      });
    }
  });

export const StageAttemptStatusSchema = z.enum([
  'started',
  'running',
  'waiting',
  'retry_scheduled',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

export const StageAttemptSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  stage: RunStageSchema,
  attempt: z.number().int().positive(),
  status: StageAttemptStatusSchema,
  summary: z.string().min(1).max(2_048),
  waitingOn: z.string().max(1_024).nullable(),
  nextRetryAt: z.iso.datetime().nullable(),
  lastHeartbeatAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  evidenceIds: z.array(z.uuid()).max(64),
});

export const CurrentActionSchema = z.object({
  kind: z.enum([
    'stage',
    'command',
    'target_service',
    'model_call',
    'browser',
    'specialist',
    'recovery',
    'policy',
    'terminal',
  ]),
  id: z.string().min(1).max(128),
  summary: z.string().min(1).max(2_048),
  status: z.enum(['running', 'waiting', 'retrying', 'recovering', 'terminal']),
  source: ProvenanceSchema,
  startedAt: z.iso.datetime(),
  attempt: z.number().int().positive(),
  evidenceIds: z.array(z.uuid()).max(64),
});

export const WaitingOnSchema = z.object({
  kind: z.enum([
    'service_readiness',
    'retry_delay',
    'provider',
    'browser',
    'repository_checks',
    'lease',
    'policy',
  ]),
  summary: z.string().min(1).max(2_048),
  since: z.iso.datetime(),
  nextRetryAt: z.iso.datetime().nullable(),
  evidenceIds: z.array(z.uuid()).max(64),
});

export const RunProjectionSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  status: RunStatusSchema,
  stage: RunStageSchema,
  attempt: z.number().int().positive(),
  currentAction: CurrentActionSchema.nullable(),
  waitingOn: WaitingOnSchema.nullable(),
  activeStageAttemptId: z.uuid().nullable(),
  activeCommandId: z.uuid().nullable(),
  activeServiceId: z.uuid().nullable(),
  activeProviderCallId: z.uuid().nullable(),
  activeBrowserSessionId: z.uuid().nullable(),
  activeSpecialistActivityId: z.uuid().nullable(),
  recoveryState: z.enum(['none', 'required', 'recovering', 'resumed', 'failed']),
  lastEventSequence: z.number().int().nonnegative(),
  lastHeartbeatAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export const PolicyWorkerCallSchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    worker: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9._-]+$/),
    version: z.string().min(1).max(64),
    attempt: z.number().int().positive(),
    status: z.enum(['started', 'succeeded', 'failed', 'cancelled']),
    inputDigest: Sha256Schema,
    outputDigest: Sha256Schema.nullable(),
    error: z.string().min(1).max(4_096).nullable(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .superRefine((value, context) => {
    if (value.status === 'started') {
      if (value.completedAt !== null) {
        context.addIssue({
          code: 'custom',
          message: 'A started policy worker cannot have a completion timestamp',
          path: ['completedAt'],
        });
      }
      if (value.outputDigest !== null || value.error !== null) {
        context.addIssue({
          code: 'custom',
          message: 'A started policy worker cannot have terminal output or error data',
          path: ['status'],
        });
      }
      return;
    }
    if (value.completedAt === null) {
      context.addIssue({
        code: 'custom',
        message: 'A terminal policy worker requires a completion timestamp',
        path: ['completedAt'],
      });
    }
    if (value.status === 'succeeded') {
      if (value.outputDigest === null) {
        context.addIssue({
          code: 'custom',
          message: 'A succeeded policy worker requires an output digest',
          path: ['outputDigest'],
        });
      }
      if (value.error !== null) {
        context.addIssue({
          code: 'custom',
          message: 'A succeeded policy worker cannot include an error',
          path: ['error'],
        });
      }
    } else if (value.error === null) {
      context.addIssue({
        code: 'custom',
        message: 'A failed or cancelled policy worker requires an error',
        path: ['error'],
      });
    }
  });

const gitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/);
const checkpointBaseSchema = z.object({
  runId: z.uuid(),
  updatedAt: z.iso.datetime(),
});

export const RunCheckpointRecordSchema = z.discriminatedUnion('kind', [
  checkpointBaseSchema.extend({
    kind: z.literal('worktree_created'),
    data: z
      .object({
        worktreePath: z.string().min(1).max(4_096),
        branch: z.string().min(1).max(1_024),
        baseSha: gitObjectIdSchema,
      })
      .strict(),
  }),
  checkpointBaseSchema.extend({
    kind: z.literal('patch_applied'),
    data: z.object({ patchId: z.uuid(), artifactId: z.uuid() }).strict(),
  }),
  checkpointBaseSchema.extend({
    kind: z.literal('verification_passed'),
    data: z.object({ verificationId: z.uuid() }).strict(),
  }),
  checkpointBaseSchema.extend({
    kind: z.literal('commit_created'),
    data: z.object({ commitSha: gitObjectIdSchema }).strict(),
  }),
  checkpointBaseSchema.extend({
    kind: z.literal('branch_pushed'),
    data: z
      .object({
        branch: z.string().min(1).max(1_024),
        commitSha: gitObjectIdSchema,
      })
      .strict(),
  }),
  checkpointBaseSchema.extend({
    kind: z.literal('pull_request_created'),
    data: z
      .object({
        number: z.number().int().positive(),
        url: z.url().max(8_192),
        headSha: gitObjectIdSchema,
      })
      .strict(),
  }),
  checkpointBaseSchema.extend({
    kind: z.literal('merge_observed'),
    data: z
      .object({
        number: z.number().int().positive(),
        mergeCommitSha: gitObjectIdSchema,
      })
      .strict(),
  }),
  checkpointBaseSchema.extend({
    kind: z.literal('postverify_passed'),
    data: z.object({ mergeCommitSha: gitObjectIdSchema }).strict(),
  }),
]);

const manifestCommandSchema = z.object({
  commandId: z.uuid(),
  stage: RunStageSchema,
  attempt: z.number().int().positive(),
  executable: z.string().min(1).max(512),
  args: z.array(z.string().max(4_096)).max(256),
  cwd: z.string().max(4_096),
  timeoutMs: z.number().int().positive(),
  envKeys: z.array(z.string().max(256)).max(256),
  status: z.enum(['started', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  output: BoundedOutputSchema.nullable(),
  evidenceIds: z.array(z.uuid()).max(64),
});

const manifestBrowserCheckSchema = z.object({
  checkId: z.uuid(),
  flow: z.string().min(1).max(512),
  attempt: z.number().int().positive(),
  status: z.enum(['started', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  sessionId: z.uuid().nullable(),
  url: z.string().max(8_192).nullable(),
  evidenceIds: z.array(z.uuid()).max(64),
});

export const RunManifestPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  generatedAt: z.iso.datetime(),
  config: z.object({
    sha256: Sha256Schema.nullable(),
    sourcePath: z.string().max(4_096).nullable(),
  }),
  repository: z.object({
    baseSha: z.string().max(128).nullable(),
    headSha: z.string().max(128).nullable(),
    branch: z.string().max(1_024).nullable(),
    worktreePath: z.string().max(4_096).nullable(),
  }),
  commands: z.array(manifestCommandSchema),
  browserChecks: z.array(manifestBrowserCheckSchema),
  stageAttempts: z.array(StageAttemptSchema),
  providerCalls: z.array(ProviderCallSchema),
  policyWorkerCalls: z.array(PolicyWorkerCallSchema).default([]),
  specialistActivities: z.array(SpecialistActivitySchema),
  specialistCritiques: z.array(SpecialistCritiqueSchema).default([]),
  specialistDecisions: z.array(SpecialistDecisionSchema).default([]),
  outcome: z.object({
    status: RunStatusSchema,
    stage: RunStageSchema,
    summary: z.string().max(4_096).nullable(),
    error: z.string().max(4_096).nullable(),
    completedAt: z.iso.datetime().nullable(),
  }),
  trace: z.object({
    state: TraceStateSchema,
    provider: z.string().max(256).nullable(),
    updatedAt: z.iso.datetime(),
    atManifest: z.literal(true),
  }),
  artifacts: z.array(
    ArtifactSchema.pick({
      id: true,
      kind: true,
      name: true,
      sha256: true,
      mimeType: true,
      bytes: true,
      createdAt: true,
    })
  ),
  redaction: z.object({
    version: z.literal(1),
    applied: z.boolean(),
    replacementCount: z.number().int().nonnegative(),
  }),
  manifestArtifactExcluded: z.literal(true),
});

export const RunManifestSchema = RunManifestPayloadSchema.extend({
  checksum: Sha256Schema,
});

export const RunManifestRecordSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  artifactId: z.uuid(),
  sha256: Sha256Schema,
  eventSequence: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});

export const RunManifestContextSchema = z.object({
  runId: z.uuid(),
  configDigest: Sha256Schema.nullable(),
  configPath: z.string().max(4_096).nullable(),
  baseSha: z.string().max(128).nullable(),
  headSha: z.string().max(128).nullable(),
  branch: z.string().max(1_024).nullable(),
  worktreePath: z.string().max(4_096).nullable(),
  commands: z.array(CommandSchema).max(1_024),
  browserChecks: z
    .array(
      z.object({
        name: z.string().min(1).max(512),
        steps: z.array(z.string().min(1).max(4_096)).max(256),
      })
    )
    .max(1_024),
  updatedAt: z.iso.datetime(),
});

export type TraceState = z.infer<typeof TraceStateSchema>;
export type BoundedOutput = z.infer<typeof BoundedOutputSchema>;
export type StageAttempt = z.infer<typeof StageAttemptSchema>;
export type CurrentAction = z.infer<typeof CurrentActionSchema>;
export type WaitingOn = z.infer<typeof WaitingOnSchema>;
export type RunProjection = z.infer<typeof RunProjectionSchema>;
export type PolicyWorkerCall = z.infer<typeof PolicyWorkerCallSchema>;
export type RunCheckpointRecord = z.infer<typeof RunCheckpointRecordSchema>;
export type RunManifestPayload = z.infer<typeof RunManifestPayloadSchema>;
export type RunManifest = z.infer<typeof RunManifestSchema>;
export type RunManifestRecord = z.infer<typeof RunManifestRecordSchema>;
export type RunManifestContext = z.infer<typeof RunManifestContextSchema>;
