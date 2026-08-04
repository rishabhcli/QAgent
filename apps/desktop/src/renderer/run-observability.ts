import type { Run, RunEvent } from '@qagent/contracts';

export function eventMessage(event: RunEvent): string {
  switch (event.kind) {
    case 'run.created':
    case 'stage.started':
    case 'stage.completed':
    case 'run.completed':
    case 'run.failed':
    case 'run.cancelled':
    case 'run.policy_blocked':
      return event.payload.message;
    case 'command.started':
      return `Running ${event.payload.executable}`;
    case 'command.completed':
      return event.payload.exitCode === 0
        ? `${event.payload.executable} passed`
        : `${event.payload.executable} exited ${event.payload.exitCode ?? 'unknown'}`;
    case 'evidence.captured':
      return `Captured ${event.payload.name}`;
    case 'diagnosis.created':
    case 'patch.created':
      return event.payload.summary;
    case 'verification.completed':
      return event.payload.passed ? 'Verification passed' : 'Verification failed';
    case 'publication.created':
      return `Opened pull request #${event.payload.number}`;
    case 'publication.updated':
      return event.payload.detail ?? `Publication ${event.payload.state}`;
    case 'trace.status':
      return `Trace ${event.payload.state}`;
    case 'run.isolation_ready':
      return `Isolated worktree ready at ${event.payload.isolation.worktreePath}`;
    case 'run.interrupted':
    case 'run.retrying':
    case 'run.resumed':
    case 'run.reconnected':
      return event.payload.message;
    case 'intervention.required':
      return event.payload.intervention.summary;
    case 'intervention.resolved':
      return event.payload.message;
    case 'action.rejected':
      return `${event.payload.action} rejected: ${event.payload.reason}`;
    case 'specialist.activity':
      return `${event.payload.activity.role}: ${event.payload.activity.summary}`;
    case 'specialist.critique':
      return `${event.payload.critique.role} critique: ${event.payload.critique.summary}`;
    case 'specialist.decision':
      return `${event.payload.decision.role} decision: ${event.payload.decision.summary}`;
    case 'specialist.objection':
      return `${event.payload.objection.role} objection: ${event.payload.objection.summary}`;
    case 'specialist.handoff':
      return `${event.payload.handoff.from} handed off to ${event.payload.handoff.to}`;
    case 'terminal.evidence':
      return `Terminal evidence: ${event.payload.evidence.outcome}`;
    case 'stage.retry_scheduled':
      return `Retry ${event.payload.nextAttempt} scheduled: ${event.payload.reason}`;
    case 'stage.heartbeat':
      return event.payload.currentAction;
    case 'command.output':
      return `${event.payload.stream} output chunk ${event.payload.chunkIndex + 1}`;
    case 'command.failed':
    case 'command.cancelled':
      return event.payload.error;
    case 'target.service_started':
      return `Started ${event.payload.executable}`;
    case 'target.service_ready':
      return `Target service ready at ${event.payload.healthUrl}`;
    case 'target.service_exited':
      return event.payload.expected
        ? 'Target service stopped'
        : 'Target service exited unexpectedly';
    case 'target.service_failed':
      return `Target service failed: ${event.payload.error}`;
    case 'model.call_started':
      return `${event.payload.specialistRole} started ${event.payload.provider} model call`;
    case 'model.call_completed':
      return `Model call completed in ${Math.round(event.payload.durationMs)} ms`;
    case 'model.call_failed':
    case 'model.call_cancelled':
      return event.payload.error;
    case 'browser.session_started':
      return `${event.payload.provider} browser session started`;
    case 'browser.session_closed':
      return `Browser session ${event.payload.status}`;
    case 'browser.navigation_started':
      return `Navigating to ${event.payload.url}`;
    case 'browser.navigation_completed':
      return `Browser reached ${event.payload.finalUrl}`;
    case 'browser.action_started':
    case 'browser.action_completed':
      return event.payload.summary;
    case 'browser.checkpoint':
      return `Browser checkpoint: ${event.payload.title}`;
    case 'browser.failed':
      return `Browser ${event.payload.operation} failed: ${event.payload.error}`;
    case 'artifact.created':
      return `Created ${event.payload.name}`;
    case 'recovery.started':
      return `Recovering from ${event.payload.previousStage}`;
    case 'recovery.completed':
      return event.payload.currentAction;
    case 'recovery.failed':
      return event.payload.error ?? event.payload.currentAction;
    case 'run.manifest_created':
      return 'Created the terminal run manifest';
    case 'output.truncated':
      return `${event.payload.scope} output truncated by ${event.payload.omittedBytes} bytes`;
    case 'stream.backpressure':
      return `${event.payload.scope} stream dropped ${event.payload.droppedRecords} records`;
  }
}

export function eventDetail(event: RunEvent): string {
  const source = event.provenance.provider ?? event.provenance.source;
  const artifacts =
    event.artifactIds.length > 0
      ? ` / ${event.artifactIds.length} artifact${event.artifactIds.length === 1 ? '' : 's'}`
      : '';
  return `${stageLabel(event.stage)} / ${source}${artifacts}`;
}

export function stageLabel(stage: Run['stage']): string {
  if (stage === 'wait_checks') return 'checks';
  if (stage === 'postverify') return 'recheck';
  return stage.replace('_', ' ');
}

export function stageAction(stage: Run['stage']): string {
  const actions: Record<Run['stage'], string> = {
    preflight: 'Checking trust, Git, and run policy',
    discover: 'Detecting tests and target app',
    test: 'Running grounded checks',
    triage: 'Tracing the failure to a cause',
    patch: 'Preparing a bounded diff',
    verify: 'Executing verification commands',
    publish: 'Preparing the publication boundary',
    wait_checks: 'Watching required repository checks',
    merge: 'Applying repository merge policy',
    postverify: 'Rechecking the merged repair',
    learn: 'Persisting successful repair knowledge',
    complete: 'Repair loop complete',
  };
  return actions[stage];
}

export function runOutcomeTitle(run: Run): string {
  if (run.status === 'succeeded') {
    return run.summary?.startsWith('No defects found') ? 'Checks passed' : 'Repair verified';
  }
  if (run.status === 'failed') return 'Run failed';
  if (run.status === 'cancelled') return 'Run cancelled';
  if (run.status === 'policy_blocked') return 'Policy blocked';
  if (run.status === 'waiting_for_intervention') return 'Action required';
  if (run.status === 'interrupted') return 'Recovery available';
  if (run.status === 'queued') return 'Run queued';
  return stageAction(run.stage);
}
