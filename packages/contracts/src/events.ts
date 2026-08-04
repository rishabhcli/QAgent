import { z } from 'zod';
import { BoundedOutputSchema, Sha256Schema, TraceStateSchema } from './lifecycle.js';
import { ProvenanceSchema, RunStageSchema } from './records.js';
import {
  SpecialistActivitySchema,
  SpecialistCritiqueSchema,
  SpecialistDecisionSchema,
  SpecialistHandoffSchema,
  SpecialistObjectionSchema,
  SpecialistRoleSchema,
} from './specialists.js';
import {
  InterventionResolutionInputSchema,
  RunActionSchema,
  RunInterventionSchema,
  RunIsolationSchema,
  RunPolicyBoundarySchema,
  TerminalEvidenceSchema,
} from './workflow.js';

const BaseEventSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  runId: z.uuid(),
  sequence: z.number().int().positive(),
  stage: RunStageSchema,
  occurredAt: z.iso.datetime(),
  provenance: ProvenanceSchema,
  artifactIds: z.array(z.uuid()).default([]),
});

const boundedText = z.string().max(4_096);
const boundedError = z.string().max(4_096);
const messagePayload = z.object({ message: z.string() });
const stageStartedPayload = messagePayload.extend({
  stageAttemptId: z.uuid().optional(),
  attempt: z.number().int().positive().optional(),
});
const stageCompletedPayload = stageStartedPayload.extend({
  status: z.enum(['succeeded', 'failed', 'cancelled', 'interrupted']).optional(),
});
const callPurpose = z.enum(['triage', 'patch', 'browser', 'other']);
const nullableUsage = {
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
};

export const RunEventSchema = z.discriminatedUnion('kind', [
  BaseEventSchema.extend({ kind: z.literal('run.created'), payload: messagePayload }),
  BaseEventSchema.extend({ kind: z.literal('stage.started'), payload: stageStartedPayload }),
  BaseEventSchema.extend({ kind: z.literal('stage.completed'), payload: stageCompletedPayload }),
  BaseEventSchema.extend({
    kind: z.literal('command.started'),
    payload: z.object({
      executable: z.string(),
      args: z.array(z.string()),
      commandId: z.uuid().optional(),
      attempt: z.number().int().positive().optional(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('command.completed'),
    payload: z.object({
      executable: z.string(),
      args: z.array(z.string()),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().nonnegative(),
      commandId: z.uuid().optional(),
      attempt: z.number().int().positive().optional(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('evidence.captured'),
    payload: z.object({ name: z.string(), kind: z.string() }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('diagnosis.created'),
    payload: z.object({ diagnosisId: z.uuid(), summary: z.string(), confidence: z.number() }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('patch.created'),
    payload: z.object({ patchId: z.uuid(), summary: z.string(), files: z.array(z.string()) }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('verification.completed'),
    payload: z.object({ verificationId: z.uuid(), passed: z.boolean() }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('publication.created'),
    payload: z.object({ url: z.url(), number: z.number().int(), autoMerge: z.boolean() }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('publication.updated'),
    payload: z.object({ state: z.string(), detail: z.string().optional() }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('trace.status'),
    payload: z.object({ state: TraceStateSchema }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('run.isolation_ready'),
    payload: z.object({
      isolation: RunIsolationSchema,
      policyBoundary: RunPolicyBoundarySchema,
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('run.interrupted'),
    payload: z.object({
      message: z.string(),
      recoveryCount: z.number().int().nonnegative(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('run.retrying'),
    payload: z.object({
      message: z.string(),
      attempt: z.number().int().positive(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('run.resumed'),
    payload: z.object({
      message: z.string(),
      recoveryCount: z.number().int().nonnegative(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('run.reconnected'),
    payload: z.object({
      message: z.string(),
      afterSequence: z.number().int().nonnegative(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('intervention.required'),
    payload: z.object({ intervention: RunInterventionSchema }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('intervention.resolved'),
    payload: z.object({
      interventionId: z.uuid(),
      resolution: InterventionResolutionInputSchema,
      message: z.string(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('action.rejected'),
    payload: z.object({
      action: RunActionSchema,
      reason: z.string().min(1),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('specialist.activity'),
    payload: z.object({ activity: SpecialistActivitySchema }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('terminal.evidence'),
    payload: z.object({ evidence: TerminalEvidenceSchema }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('stage.retry_scheduled'),
    payload: z.object({
      stageAttemptId: z.uuid(),
      attempt: z.number().int().positive(),
      nextAttempt: z.number().int().positive(),
      reason: boundedText,
      nextRetryAt: z.iso.datetime(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('stage.heartbeat'),
    payload: z.object({
      stageAttemptId: z.uuid(),
      attempt: z.number().int().positive(),
      currentAction: boundedText,
      waitingOn: boundedText.nullable(),
      heartbeatAt: z.iso.datetime(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('command.output'),
    payload: z.object({
      commandId: z.uuid(),
      attempt: z.number().int().positive(),
      stream: z.enum(['stdout', 'stderr', 'combined']),
      chunkIndex: z.number().int().nonnegative(),
      output: BoundedOutputSchema,
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('command.failed'),
    payload: z.object({
      commandId: z.uuid(),
      attempt: z.number().int().positive(),
      error: boundedError,
      durationMs: z.number().nonnegative(),
      output: BoundedOutputSchema,
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('command.cancelled'),
    payload: z.object({
      commandId: z.uuid(),
      attempt: z.number().int().positive(),
      error: boundedError,
      durationMs: z.number().nonnegative(),
      output: BoundedOutputSchema,
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('target.service_started'),
    payload: z.object({
      serviceId: z.uuid(),
      commandId: z.uuid(),
      attempt: z.number().int().positive(),
      executable: z.string().max(512),
      args: z.array(z.string().max(4_096)).max(256),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('target.service_ready'),
    payload: z.object({
      serviceId: z.uuid(),
      attempt: z.number().int().positive(),
      healthUrl: z.string().max(8_192),
      statusCode: z.number().int().min(100).max(599).nullable(),
      durationMs: z.number().nonnegative(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('target.service_exited'),
    payload: z.object({
      serviceId: z.uuid(),
      attempt: z.number().int().positive(),
      exitCode: z.number().int().nullable(),
      signal: z.string().max(64).nullable(),
      durationMs: z.number().nonnegative(),
      expected: z.boolean(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('target.service_failed'),
    payload: z.object({
      serviceId: z.uuid(),
      attempt: z.number().int().positive(),
      error: boundedError,
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('model.call_started'),
    payload: z.object({
      providerCallId: z.uuid(),
      provider: z.string().max(256),
      model: z.string().max(512),
      purpose: callPurpose,
      attempt: z.number().int().positive(),
      specialistRole: SpecialistRoleSchema,
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('model.call_completed'),
    payload: z.object({
      providerCallId: z.uuid(),
      durationMs: z.number().nonnegative(),
      ...nullableUsage,
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('model.call_failed'),
    payload: z.object({
      providerCallId: z.uuid(),
      durationMs: z.number().nonnegative(),
      error: boundedError,
      ...nullableUsage,
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('model.call_cancelled'),
    payload: z.object({
      providerCallId: z.uuid(),
      durationMs: z.number().nonnegative(),
      error: boundedError,
      ...nullableUsage,
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('browser.session_started'),
    payload: z.object({
      sessionId: z.uuid(),
      provider: z.string().max(256),
      browserName: z.string().max(512),
      attempt: z.number().int().positive(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('browser.session_closed'),
    payload: z.object({
      sessionId: z.uuid(),
      attempt: z.number().int().positive(),
      status: z.enum(['succeeded', 'failed', 'cancelled']),
      durationMs: z.number().nonnegative(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('browser.navigation_started'),
    payload: z.object({
      sessionId: z.uuid(),
      navigationId: z.uuid(),
      url: z.string().max(8_192),
      attempt: z.number().int().positive(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('browser.navigation_completed'),
    payload: z.object({
      sessionId: z.uuid(),
      navigationId: z.uuid(),
      finalUrl: z.string().max(8_192),
      statusCode: z.number().int().min(100).max(599).nullable(),
      durationMs: z.number().nonnegative(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('browser.action_started'),
    payload: z.object({
      sessionId: z.uuid(),
      actionId: z.uuid(),
      flow: z.string().max(512),
      stepIndex: z.number().int().nonnegative(),
      attempt: z.number().int().positive(),
      summary: boundedText,
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('browser.action_completed'),
    payload: z.object({
      sessionId: z.uuid(),
      actionId: z.uuid(),
      durationMs: z.number().nonnegative(),
      summary: boundedText,
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('browser.checkpoint'),
    payload: z.object({
      sessionId: z.uuid(),
      checkpointId: z.uuid(),
      flow: z.string().max(512),
      url: z.string().max(8_192),
      title: z.string().max(2_048),
      attempt: z.number().int().positive(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('browser.failed'),
    payload: z.object({
      sessionId: z.uuid(),
      operation: z.string().max(256),
      attempt: z.number().int().positive(),
      error: boundedError,
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('artifact.created'),
    payload: z.object({
      artifactId: z.uuid(),
      kind: z.string().max(128),
      name: z.string().max(1_024),
      sha256: Sha256Schema,
      mimeType: z.string().max(256),
      bytes: z.number().int().nonnegative(),
      originalBytes: z.number().int().nonnegative(),
      omittedBytes: z.number().int().nonnegative(),
      truncated: z.boolean(),
      redactionCount: z.number().int().nonnegative(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('recovery.started'),
    payload: z.object({
      recoveryId: z.uuid(),
      fromSequence: z.number().int().nonnegative(),
      previousStage: RunStageSchema,
      previousStatus: z.string().max(128),
      attempt: z.number().int().positive(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('recovery.completed'),
    payload: z.object({
      recoveryId: z.uuid(),
      resumedSequence: z.number().int().nonnegative(),
      currentAction: boundedText,
      error: boundedError.nullable(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('recovery.failed'),
    payload: z.object({
      recoveryId: z.uuid(),
      resumedSequence: z.number().int().nonnegative(),
      currentAction: boundedText,
      error: boundedError.nullable(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('specialist.critique'),
    payload: z.object({ critique: SpecialistCritiqueSchema }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('specialist.decision'),
    payload: z.object({ decision: SpecialistDecisionSchema }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('specialist.objection'),
    payload: z.object({ objection: SpecialistObjectionSchema }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('specialist.handoff'),
    payload: z.object({ handoff: SpecialistHandoffSchema }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('run.manifest_created'),
    payload: z.object({
      manifestId: z.uuid(),
      artifactId: z.uuid(),
      sha256: Sha256Schema,
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('output.truncated'),
    payload: z.object({
      scope: z.enum(['command', 'browser_console', 'dom', 'model', 'manifest']),
      ownerId: z.string().min(1).max(128),
      originalBytes: z.number().int().nonnegative(),
      retainedBytes: z.number().int().nonnegative(),
      omittedBytes: z.number().int().nonnegative(),
      limitBytes: z.number().int().positive(),
    }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('stream.backpressure'),
    payload: z.object({
      scope: z.enum(['subscriber', 'command', 'browser']),
      ownerId: z.string().min(1).max(128),
      droppedRecords: z.number().int().nonnegative(),
      droppedBytes: z.number().int().nonnegative(),
      resumeAfterSequence: z.number().int().nonnegative(),
    }),
  }),
  BaseEventSchema.extend({ kind: z.literal('run.completed'), payload: messagePayload }),
  BaseEventSchema.extend({ kind: z.literal('run.failed'), payload: messagePayload }),
  BaseEventSchema.extend({ kind: z.literal('run.cancelled'), payload: messagePayload }),
  BaseEventSchema.extend({ kind: z.literal('run.policy_blocked'), payload: messagePayload }),
]);

export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventKind = RunEvent['kind'];
export type RunEventPayload<K extends RunEventKind> = Extract<RunEvent, { kind: K }>['payload'];

export const RunEventCursorSchema = z.string().min(1).max(512);

export const ReplayEventsRequestSchema = z
  .object({
    runId: z.uuid(),
    cursor: RunEventCursorSchema.optional(),
    afterSequence: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(500).default(250),
  })
  .superRefine((value, context) => {
    if (value.cursor !== undefined && value.afterSequence !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Use either cursor or afterSequence, not both',
        path: ['cursor'],
      });
    }
  });

export const RunEventReplayPageSchema = z.object({
  runId: z.uuid(),
  events: z.array(RunEventSchema),
  afterSequence: z.number().int().nonnegative(),
  nextSequence: z.number().int().nonnegative(),
  nextCursor: RunEventCursorSchema,
  highWaterSequence: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export type ReplayEventsRequest = z.infer<typeof ReplayEventsRequestSchema>;
export type RunEventReplayPage = z.infer<typeof RunEventReplayPageSchema>;
