import { randomUUID } from 'node:crypto';
import { RunEventSchema } from '@qagent/contracts';
import { describe, expect, it } from 'vitest';

const occurredAt = '2026-07-23T20:00:00.000Z';

const boundedOutput = {
  text: 'bounded output',
  originalBytes: 14,
  retainedBytes: 14,
  omittedBytes: 0,
  truncated: false,
  redactionCount: 0,
  backpressure: null,
};

function event(kind: string, payload: unknown) {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    runId: randomUUID(),
    sequence: 1,
    stage: 'test',
    kind,
    occurredAt,
    provenance: { source: 'local', capturedAt: occurredAt },
    artifactIds: [],
    payload,
  };
}

describe('RunEvent literal discriminants', () => {
  it.each([
    [
      'command.failed',
      {
        commandId: randomUUID(),
        attempt: 1,
        error: 'Command exited with status 1',
        durationMs: 12,
        output: boundedOutput,
      },
    ],
    [
      'command.cancelled',
      {
        commandId: randomUUID(),
        attempt: 1,
        error: 'Cancellation requested',
        durationMs: 7,
        output: boundedOutput,
      },
    ],
    [
      'model.call_failed',
      {
        providerCallId: randomUUID(),
        durationMs: 22,
        error: 'Provider unavailable',
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      },
    ],
    [
      'model.call_cancelled',
      {
        providerCallId: randomUUID(),
        durationMs: 5,
        error: 'Cancellation requested',
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      },
    ],
    [
      'recovery.completed',
      {
        recoveryId: randomUUID(),
        resumedSequence: 18,
        currentAction: 'Reconnected to the durable run',
        error: null,
      },
    ],
    [
      'recovery.failed',
      {
        recoveryId: randomUUID(),
        resumedSequence: 18,
        currentAction: 'Validating the persisted worktree',
        error: 'The worktree is unavailable',
      },
    ],
  ] as const)('parses %s as its own event variant', (kind, payload) => {
    expect(RunEventSchema.parse(event(kind, payload)).kind).toBe(kind);
  });
});
