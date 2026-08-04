import type { Run, RunEvent } from '@qagent/contracts';
import { stageLabel } from '../../run-observability.js';

const stages: Run['stage'][] = [
  'preflight',
  'discover',
  'test',
  'triage',
  'patch',
  'verify',
  'publish',
  'wait_checks',
  'merge',
  'postverify',
  'learn',
  'complete',
];

export function StageStrip({ run, events }: { run: Run; events: RunEvent[] }) {
  const completed = new Set(
    events.filter((event) => event.kind === 'stage.completed').map((event) => event.stage)
  );
  const terminal = ['succeeded', 'failed', 'cancelled', 'policy_blocked'].includes(run.status);

  return (
    <ol className="signal-stage-strip" aria-label="Run stages">
      {stages.map((stage) => {
        const state =
          completed.has(stage) || (run.status === 'succeeded' && stage === run.stage)
            ? 'done'
            : stage === run.stage
              ? terminal
                ? 'stopped'
                : 'current'
              : 'unrecorded';
        return (
          <li
            key={stage}
            className={`signal-stage stage ${state}`}
            aria-current={state === 'current' ? 'step' : undefined}
            aria-label={`${stageLabel(stage)}: ${state}`}
            title={`${stageLabel(stage)} · ${state}`}
          >
            <span aria-hidden="true" />
            <small>{stageLabel(stage)}</small>
          </li>
        );
      })}
    </ol>
  );
}
