import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@qagent/contracts';
import {
  eventDetail,
  eventMessage,
  runOutcomeTitle,
  stageAction,
  stageLabel,
} from '../../apps/desktop/src/renderer/run-observability.js';

const baseEvent = {
  schemaVersion: 1,
  id: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  sequence: 4,
  stage: 'test',
  occurredAt: '2026-07-22T20:00:00.000Z',
  provenance: {
    source: 'local',
    provider: 'QAgent',
    capturedAt: '2026-07-22T20:00:00.000Z',
  },
  artifactIds: ['33333333-3333-4333-8333-333333333333'],
} as const;

describe('desktop run observability wording', () => {
  it('turns command events into concise current actions', () => {
    const started = {
      ...baseEvent,
      kind: 'command.started',
      payload: { executable: 'pnpm', args: ['test'] },
    } satisfies RunEvent;
    const completed = {
      ...baseEvent,
      kind: 'command.completed',
      payload: { executable: 'pnpm', args: ['test'], exitCode: 0, durationMs: 418 },
    } satisfies RunEvent;

    expect(eventMessage(started)).toBe('Running pnpm');
    expect(eventMessage(completed)).toBe('pnpm passed');
  });

  it('keeps source and artifact provenance in the compact detail', () => {
    const event = {
      ...baseEvent,
      kind: 'evidence.captured',
      payload: { name: 'test-output.log', kind: 'log' },
    } satisfies RunEvent;

    expect(eventMessage(event)).toBe('Captured test-output.log');
    expect(eventDetail(event)).toBe('test / QAgent / 1 artifact');
  });

  it('uses readable labels for long-running stages', () => {
    expect(stageLabel('wait_checks')).toBe('checks');
    expect(stageAction('wait_checks')).toBe('Watching required repository checks');
    expect(stageAction('complete')).toBe('Repair loop complete');
  });

  it('distinguishes a clean check from a verified repair', () => {
    const run = {
      id: baseEvent.runId,
      projectId: '44444444-4444-4444-8444-444444444444',
      status: 'succeeded',
      stage: 'complete',
      requestedBy: 'desktop',
      branch: null,
      worktreePath: null,
      baseSha: null,
      summary: 'No defects found; every configured check passed.',
      error: null,
      cancelRequestedAt: null,
      createdAt: baseEvent.occurredAt,
      updatedAt: baseEvent.occurredAt,
      completedAt: baseEvent.occurredAt,
    } as const;

    expect(runOutcomeTitle(run)).toBe('Checks passed');
    expect(runOutcomeTitle({ ...run, summary: 'Repair verified on local branch.' })).toBe(
      'Repair verified'
    );
  });
});
