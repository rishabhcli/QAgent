import type { RunEvent, RunEventPayload } from './events.js';

type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
type IsPresent<T> = IsNever<T> extends true ? false : true;

export type CommandFailedEventIsExtractable = Assert<
  IsPresent<Extract<RunEvent, { kind: 'command.failed' }>>
>;
export type CommandCancelledEventIsExtractable = Assert<
  IsPresent<Extract<RunEvent, { kind: 'command.cancelled' }>>
>;
export type ModelCallFailedEventIsExtractable = Assert<
  IsPresent<Extract<RunEvent, { kind: 'model.call_failed' }>>
>;
export type ModelCallCancelledEventIsExtractable = Assert<
  IsPresent<Extract<RunEvent, { kind: 'model.call_cancelled' }>>
>;
export type RecoveryCompletedEventIsExtractable = Assert<
  IsPresent<Extract<RunEvent, { kind: 'recovery.completed' }>>
>;
export type RecoveryFailedEventIsExtractable = Assert<
  IsPresent<Extract<RunEvent, { kind: 'recovery.failed' }>>
>;

export type CommandFailedPayloadIsExtractable = Assert<
  IsPresent<RunEventPayload<'command.failed'>>
>;
export type CommandCancelledPayloadIsExtractable = Assert<
  IsPresent<RunEventPayload<'command.cancelled'>>
>;
export type ModelCallFailedPayloadIsExtractable = Assert<
  IsPresent<RunEventPayload<'model.call_failed'>>
>;
export type ModelCallCancelledPayloadIsExtractable = Assert<
  IsPresent<RunEventPayload<'model.call_cancelled'>>
>;
export type RecoveryCompletedPayloadIsExtractable = Assert<
  IsPresent<RunEventPayload<'recovery.completed'>>
>;
export type RecoveryFailedPayloadIsExtractable = Assert<
  IsPresent<RunEventPayload<'recovery.failed'>>
>;
