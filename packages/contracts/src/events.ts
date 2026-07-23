import { z } from 'zod';
import { ProvenanceSchema, RunStageSchema } from './records.js';

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

const messagePayload = z.object({ message: z.string() });

export const RunEventSchema = z.discriminatedUnion('kind', [
  BaseEventSchema.extend({ kind: z.literal('run.created'), payload: messagePayload }),
  BaseEventSchema.extend({ kind: z.literal('stage.started'), payload: messagePayload }),
  BaseEventSchema.extend({ kind: z.literal('stage.completed'), payload: messagePayload }),
  BaseEventSchema.extend({
    kind: z.literal('command.started'),
    payload: z.object({ executable: z.string(), args: z.array(z.string()) }),
  }),
  BaseEventSchema.extend({
    kind: z.literal('command.completed'),
    payload: z.object({
      executable: z.string(),
      args: z.array(z.string()),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().nonnegative(),
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
    payload: z.object({ state: z.enum(['local', 'queued', 'synced', 'failed', 'disabled']) }),
  }),
  BaseEventSchema.extend({ kind: z.literal('run.completed'), payload: messagePayload }),
  BaseEventSchema.extend({ kind: z.literal('run.failed'), payload: messagePayload }),
  BaseEventSchema.extend({ kind: z.literal('run.cancelled'), payload: messagePayload }),
  BaseEventSchema.extend({ kind: z.literal('run.policy_blocked'), payload: messagePayload }),
]);

export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventKind = RunEvent['kind'];
export type RunEventPayload<K extends RunEventKind> = Extract<RunEvent, { kind: K }>['payload'];
