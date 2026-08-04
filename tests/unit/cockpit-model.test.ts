import { describe, expect, it } from 'vitest';
import type { Artifact, RunEvent } from '@qagent/contracts';
import {
  deriveBrowserCheckpoints,
  deriveConsoleRecords,
  deriveSpecialistBay,
  extractSpecialistSignals,
} from '../../apps/desktop/src/renderer/components/cockpit/model.js';

const RUN_ID = '22222222-2222-4222-8222-222222222222';
const LOG_ONE = '33333333-3333-4333-8333-333333333331';
const LOG_TWO = '33333333-3333-4333-8333-333333333332';
const SCREENSHOT = '33333333-3333-4333-8333-333333333333';
const REPORT = '33333333-3333-4333-8333-333333333334';
const UNRELATED_SCREENSHOT = '33333333-3333-4333-8333-333333333335';
const COMMAND_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const CHECKPOINT_ID = '66666666-6666-4666-8666-666666666666';
const SERVICE_ID = '99999999-9999-4999-8999-999999999999';

describe('cockpit truth model', () => {
  it('serially pairs repeated legacy commands and links only completed log artifacts', () => {
    const firstStart = commandStarted(1);
    const firstComplete = commandCompleted(2, 0, 410, [LOG_ONE, SCREENSHOT]);
    const secondStart = commandStarted(3);
    const secondComplete = commandCompleted(4, 1, 920, [LOG_TWO]);

    const records = deriveConsoleRecords(
      [secondComplete, firstStart, secondStart, firstComplete],
      [artifact(LOG_ONE, 'log'), artifact(LOG_TWO, 'log'), artifact(SCREENSHOT, 'screenshot')]
    );

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      commandId: null,
      executable: 'pnpm',
      args: ['test'],
      status: 'succeeded',
      startSequence: 1,
      endSequence: 2,
      exitCode: 0,
      durationMs: 410,
      artifact: { id: LOG_ONE, kind: 'log' },
    });
    expect(records[1]).toMatchObject({
      status: 'failed',
      startSequence: 3,
      endSequence: 4,
      exitCode: 1,
      artifact: { id: LOG_TWO, kind: 'log' },
    });
  });

  it('keeps an uncompleted persisted command in the running state', () => {
    const records = deriveConsoleRecords([commandStarted(7)], []);

    expect(records).toEqual([
      expect.objectContaining({
        executable: 'pnpm',
        status: 'running',
        startedAt: '2026-07-23T20:00:07.000Z',
        completedAt: null,
        startSequence: 7,
        endSequence: null,
        artifact: null,
      }),
    ]);
  });

  it('keeps exact command.output identity separate from uncorrelated legacy command metadata', () => {
    const output = event({
      sequence: 2,
      kind: 'command.output',
      payload: {
        commandId: COMMAND_ID,
        attempt: 1,
        stream: 'stderr',
        chunkIndex: 0,
        output: boundedOutput('grounded failure\n', {
          truncated: true,
          omittedBytes: 12,
          redactionCount: 1,
        }),
      },
    });
    const failed = event({
      sequence: 3,
      kind: 'command.failed',
      payload: {
        commandId: COMMAND_ID,
        attempt: 1,
        error: 'Command failed',
        durationMs: 650,
        output: boundedOutput('grounded failure\n'),
      },
    });

    const records = deriveConsoleRecords(
      [commandStarted(1), output, failed, commandCompleted(4, 1, 650, [LOG_ONE])],
      [artifact(LOG_ONE, 'log')]
    );

    expect(records).toEqual([
      expect.objectContaining({
        commandId: null,
        executable: 'pnpm',
        args: ['test'],
        status: 'failed',
        startSequence: 1,
        endSequence: 4,
        exitCode: 1,
        durationMs: 650,
        artifact: expect.objectContaining({ id: LOG_ONE }),
        streams: [],
      }),
      expect.objectContaining({
        id: COMMAND_ID,
        commandId: COMMAND_ID,
        executable: null,
        args: [],
        status: 'failed',
        startedAt: null,
        completedAt: '2026-07-23T20:00:03.000Z',
        startSequence: null,
        endSequence: 3,
        durationMs: 650,
        artifact: null,
        streams: [
          {
            sequence: 2,
            occurredAt: '2026-07-23T20:00:02.000Z',
            stream: 'stderr',
            text: 'grounded failure\n',
            truncated: true,
            omittedBytes: 12,
            redactionCount: 1,
          },
        ],
      }),
    ]);
  });

  it('renders bounded terminal output when no streamed chunks were persisted', () => {
    const failed = event({
      sequence: 2,
      kind: 'command.failed',
      payload: {
        commandId: COMMAND_ID,
        attempt: 1,
        error: 'Command failed',
        durationMs: 650,
        output: boundedOutput('last retained bytes\n', {
          truncated: true,
          omittedBytes: 32,
          redactionCount: 2,
        }),
      },
    });

    expect(deriveConsoleRecords([failed], [])).toEqual([
      expect.objectContaining({
        commandId: COMMAND_ID,
        status: 'failed',
        streams: [
          {
            sequence: 2,
            occurredAt: '2026-07-23T20:00:02.000Z',
            stream: 'combined',
            text: 'last retained bytes\n',
            truncated: true,
            omittedBytes: 32,
            redactionCount: 2,
          },
        ],
      }),
    ]);
  });

  it('correlates structured output only when start and completion persist the same command id', () => {
    const output = event({
      sequence: 2,
      kind: 'command.output',
      payload: {
        commandId: COMMAND_ID,
        attempt: 1,
        stream: 'stdout',
        chunkIndex: 0,
        output: boundedOutput('all checks passed\n'),
      },
    });

    const records = deriveConsoleRecords(
      [commandStarted(1, COMMAND_ID), output, commandCompleted(3, 0, 540, [LOG_ONE], COMMAND_ID)],
      [artifact(LOG_ONE, 'log')]
    );

    expect(records).toEqual([
      expect.objectContaining({
        commandId: COMMAND_ID,
        executable: 'pnpm',
        args: ['test'],
        status: 'succeeded',
        startedAt: '2026-07-23T20:00:01.000Z',
        completedAt: '2026-07-23T20:00:03.000Z',
        startSequence: 1,
        endSequence: 3,
        exitCode: 0,
        durationMs: 540,
        artifact: expect.objectContaining({ id: LOG_ONE }),
        streams: [
          expect.objectContaining({
            sequence: 2,
            stream: 'stdout',
            text: 'all checks passed\n',
          }),
        ],
      }),
    ]);
  });

  it('joins persisted target service lifecycle events to their structured command output', () => {
    const output = event({
      sequence: 1,
      kind: 'command.output',
      payload: {
        commandId: COMMAND_ID,
        attempt: 1,
        stream: 'stdout',
        chunkIndex: 0,
        output: boundedOutput('ready on 4173\n'),
      },
    });
    const started = event({
      sequence: 2,
      kind: 'target.service_started',
      payload: {
        serviceId: SERVICE_ID,
        commandId: COMMAND_ID,
        attempt: 1,
        executable: 'pnpm',
        args: ['fixture'],
      },
    });
    const exited = event({
      sequence: 3,
      kind: 'target.service_exited',
      payload: {
        serviceId: SERVICE_ID,
        attempt: 1,
        exitCode: null,
        signal: 'SIGTERM',
        durationMs: 1_250,
        expected: true,
      },
    });

    expect(deriveConsoleRecords([output, started, exited], [])).toEqual([
      expect.objectContaining({
        commandId: COMMAND_ID,
        executable: 'pnpm',
        args: ['fixture'],
        status: 'succeeded',
        startedAt: '2026-07-23T20:00:02.000Z',
        completedAt: '2026-07-23T20:00:03.000Z',
        startSequence: 2,
        endSequence: 3,
        exitCode: null,
        durationMs: 1_250,
        streams: [
          expect.objectContaining({
            sequence: 1,
            stream: 'stdout',
            text: 'ready on 4173\n',
          }),
        ],
      }),
    ]);
  });

  it('uses browser.checkpoint links and excludes unrelated or legacy screenshots', () => {
    const legacy = event({
      sequence: 1,
      kind: 'evidence.captured',
      artifactIds: [UNRELATED_SCREENSHOT],
      payload: { name: 'Legacy flow', kind: 'browser' },
    });
    const checkpoint = event({
      sequence: 2,
      kind: 'browser.checkpoint',
      artifactIds: [SCREENSHOT, REPORT],
      payload: {
        sessionId: SESSION_ID,
        checkpointId: CHECKPOINT_ID,
        flow: 'Increment counter',
        url: 'http://127.0.0.1:4173/',
        title: 'Counter fixture',
        attempt: 1,
      },
    });

    const checkpoints = deriveBrowserCheckpoints(
      [legacy, checkpoint],
      [
        artifact(SCREENSHOT, 'screenshot'),
        artifact(REPORT, 'report'),
        artifact(UNRELATED_SCREENSHOT, 'screenshot'),
      ]
    );

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      id: CHECKPOINT_ID,
      sessionId: SESSION_ID,
      flow: 'Increment counter',
      url: 'http://127.0.0.1:4173/',
      title: 'Counter fixture',
      provider: 'QAgent',
      screenshot: { id: SCREENSHOT },
      report: { id: REPORT },
      legacy: false,
    });
  });

  it('falls back to explicitly linked legacy browser evidence only when no checkpoint exists', () => {
    const browserEvidence = event({
      sequence: 4,
      kind: 'evidence.captured',
      artifactIds: [SCREENSHOT, REPORT],
      payload: { name: 'Legacy flow', kind: 'browser' },
    });
    const unrelatedEvidence = event({
      sequence: 5,
      kind: 'evidence.captured',
      artifactIds: [UNRELATED_SCREENSHOT],
      payload: { name: 'Process output', kind: 'log' },
    });

    const checkpoints = deriveBrowserCheckpoints(
      [browserEvidence, unrelatedEvidence],
      [
        artifact(SCREENSHOT, 'screenshot'),
        artifact(REPORT, 'report'),
        artifact(UNRELATED_SCREENSHOT, 'screenshot'),
      ]
    );

    expect(checkpoints).toEqual([
      expect.objectContaining({
        id: browserEvidence.id,
        flow: 'Legacy flow',
        url: null,
        title: null,
        screenshot: expect.objectContaining({ id: SCREENSHOT }),
        report: expect.objectContaining({ id: REPORT }),
        legacy: true,
      }),
    ]);
  });

  it('uses only persisted specialist events and never infers activity from run stages', () => {
    const ordinaryEvents = [
      event({
        sequence: 1,
        kind: 'stage.started',
        payload: { message: 'Diagnosing grounded failure' },
      }),
      event({
        sequence: 2,
        kind: 'model.call_completed',
        payload: {
          providerCallId: COMMAND_ID,
          durationMs: 500,
          inputTokens: 10,
          outputTokens: 5,
          costUsd: null,
        },
      }),
    ];

    expect(extractSpecialistSignals(ordinaryEvents)).toEqual([]);
    expect(deriveSpecialistBay(ordinaryEvents)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'trace',
          status: null,
          latestMessage: null,
          signals: [],
        }),
      ])
    );

    const activity = specialistEvent(3, 'specialist.activity', {
      activity: {
        id: '77777777-7777-4777-8777-777777777777',
        runId: RUN_ID,
        role: 'trace',
        status: 'started',
        summary: 'Inspecting the persisted command failure',
        source: { kind: 'provider_call', providerCallId: COMMAND_ID },
        occurredAt: '2026-07-23T20:00:03.000Z',
        attempt: 1,
        evidenceIds: [LOG_ONE],
        handoffTarget: null,
      },
    });
    const handoff = specialistEvent(4, 'specialist.handoff', {
      handoff: {
        id: '88888888-8888-4888-8888-888888888888',
        runId: RUN_ID,
        from: 'trace',
        to: 'patch',
        summary: 'Root cause is grounded in the failed assertion',
        actionRequired: 'Prepare the bounded repair',
        source: { kind: 'provider_call', providerCallId: COMMAND_ID },
        occurredAt: '2026-07-23T20:00:04.000Z',
        attempt: 1,
        evidenceIds: [LOG_ONE],
      },
    });

    const signals = extractSpecialistSignals([activity, handoff]);
    expect(signals).toMatchObject([
      {
        kind: 'activity',
        role: 'trace',
        status: 'started',
        message: 'Inspecting the persisted command failure',
      },
      {
        kind: 'handoff',
        role: 'trace',
        handoffFrom: 'trace',
        handoffTo: 'patch',
        message: 'Root cause is grounded in the failed assertion',
        actionRequired: 'Prepare the bounded repair',
      },
      {
        kind: 'handoff',
        role: 'patch',
        handoffFrom: 'trace',
        handoffTo: 'patch',
        message: 'Root cause is grounded in the failed assertion',
        actionRequired: 'Prepare the bounded repair',
      },
    ]);
    expect(deriveSpecialistBay([activity, handoff])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'patch',
          latestMessage: 'Root cause is grounded in the failed assertion',
        }),
      ])
    );
  });
});

function commandStarted(sequence: number, commandId?: string): RunEvent {
  return event({
    sequence,
    kind: 'command.started',
    payload: {
      executable: 'pnpm',
      args: ['test'],
      ...(commandId ? { commandId, attempt: 1 } : {}),
    },
  });
}

function commandCompleted(
  sequence: number,
  exitCode: number | null,
  durationMs: number,
  artifactIds: string[],
  commandId?: string
): RunEvent {
  return event({
    sequence,
    kind: 'command.completed',
    artifactIds,
    payload: {
      executable: 'pnpm',
      args: ['test'],
      exitCode,
      durationMs,
      ...(commandId ? { commandId, attempt: 1 } : {}),
    },
  });
}

function event(input: {
  sequence: number;
  kind: RunEvent['kind'];
  payload: unknown;
  artifactIds?: string[];
}): RunEvent {
  return {
    schemaVersion: 1,
    id: `11111111-1111-4111-8111-${String(input.sequence).padStart(12, '0')}`,
    runId: RUN_ID,
    sequence: input.sequence,
    stage: 'test',
    occurredAt: `2026-07-23T20:00:${String(input.sequence).padStart(2, '0')}.000Z`,
    provenance: {
      source: 'local',
      provider: 'QAgent',
      capturedAt: `2026-07-23T20:00:${String(input.sequence).padStart(2, '0')}.000Z`,
    },
    artifactIds: input.artifactIds ?? [],
    kind: input.kind,
    payload: input.payload,
  } as RunEvent;
}

function specialistEvent(sequence: number, kind: RunEvent['kind'], payload: unknown): unknown {
  return event({ sequence, kind, payload });
}

function artifact(id: string, kind: Artifact['kind']): Artifact {
  return {
    id,
    runId: RUN_ID,
    kind,
    name: `${kind}-${id.slice(-4)}`,
    path: `/tmp/${id}`,
    sha256: 'a'.repeat(64),
    mimeType: kind === 'screenshot' ? 'image/png' : 'text/plain',
    bytes: 100,
    provenance: {
      source: 'local',
      provider: 'QAgent',
      capturedAt: '2026-07-23T20:00:00.000Z',
    },
    createdAt: '2026-07-23T20:00:00.000Z',
  };
}

function boundedOutput(
  text: string,
  overrides: Partial<{
    truncated: boolean;
    omittedBytes: number;
    redactionCount: number;
  }> = {}
) {
  const retainedBytes = Buffer.byteLength(text);
  const omittedBytes = overrides.omittedBytes ?? 0;
  return {
    text,
    originalBytes: retainedBytes + omittedBytes,
    retainedBytes,
    omittedBytes,
    truncated: overrides.truncated ?? omittedBytes > 0,
    redactionCount: overrides.redactionCount ?? 0,
    backpressure: null,
  };
}
