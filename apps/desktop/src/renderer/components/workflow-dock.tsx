import { useEffect, useMemo, useState } from 'react';
import type {
  CorrectiveAction,
  InterventionResolution,
  Run,
  RunAction,
  RunActionRequest,
  RunActionResult,
  RunDetail,
  RunLaunch,
} from '@qagent/contracts';
import {
  Ban,
  CheckCircle2,
  ExternalLink,
  FileSearch,
  GitBranch,
  LoaderCircle,
  Play,
  RefreshCw,
  ShieldCheck,
  Wifi,
} from 'lucide-react';
import { desktopApi } from '../api.js';
import { formatCommand } from '../command-format.js';
import { SourceStamp } from './source-stamp.js';
import { StatusPill } from './status-pill.js';

const ongoingStatuses = new Set<Run['status']>([
  'queued',
  'running',
  'waiting_for_intervention',
  'interrupted',
]);

export function WorkflowDock({
  runs,
  selectedRunId,
  lastLaunch,
  onOpenRun,
  onRunAction,
  onOpenSettings,
  onOpenProjects,
}: {
  runs: Run[];
  selectedRunId: string | null;
  lastLaunch: RunLaunch | null;
  onOpenRun: (runId: string) => void;
  onRunAction: (request: RunActionRequest) => Promise<RunActionResult>;
  onOpenSettings: () => void;
  onOpenProjects: () => void;
}) {
  const run = useMemo(
    () => selectWorkflowRun(runs, selectedRunId, lastLaunch?.run.id ?? null),
    [lastLaunch?.run.id, runs, selectedRunId]
  );
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<RunAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resolution, setResolution] = useState<InterventionResolution | null>(null);

  useEffect(() => {
    if (!run) {
      setDetail(null);
      return;
    }
    let current = true;
    void desktopApi
      .runDetail(run.id)
      .then((value) => {
        if (!current) return;
        setDetail(value);
        setDetailError(null);
      })
      .catch((caught) => {
        if (current) {
          setDetailError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      current = false;
    };
  }, [run]);

  useEffect(() => {
    setResolution(run?.intervention?.resolutionOptions[0] ?? null);
  }, [run?.intervention?.id, run?.intervention?.resolutionOptions]);

  if (!run) return null;

  const visibleDetail = detail?.run.id === run.id ? detail : null;
  const currentRun = visibleDetail?.run ?? run;
  const launch = lastLaunch?.run.id === currentRun.id ? lastLaunch : null;
  const isolationEvent = visibleDetail?.events.findLast(
    (event) => event.kind === 'run.isolation_ready'
  );
  const isolation =
    launch?.isolation ??
    (isolationEvent?.kind === 'run.isolation_ready' ? isolationEvent.payload.isolation : null);
  const policy =
    launch?.policyBoundary ??
    (isolationEvent?.kind === 'run.isolation_ready' ? isolationEvent.payload.policyBoundary : null);
  const specialists = visibleDetail ? specialistEntries(visibleDetail).slice(0, 3) : [];

  async function perform(action: RunAction) {
    const intervention = currentRun.intervention;
    let request: RunActionRequest;
    if (action === 'cancel') {
      request = {
        action,
        runId: currentRun.id,
        requestedBy: 'desktop',
        reason: 'Cancellation requested from desktop',
      };
    } else if (action === 'reconnect') {
      request = {
        action,
        runId: currentRun.id,
        requestedBy: 'desktop',
        afterSequence: visibleDetail?.cursor.latestSequence ?? 0,
      };
    } else if (action === 'resolve_intervention') {
      if (!intervention || !resolution) return;
      request = {
        action,
        runId: currentRun.id,
        requestedBy: 'desktop',
        interventionId: intervention.id,
        resolution: { kind: resolution, evidenceArtifactIds: [] },
      };
    } else {
      request = { action, runId: currentRun.id, requestedBy: 'desktop' };
    }
    setBusyAction(action);
    setActionError(null);
    try {
      await onRunAction(request);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyAction(null);
    }
  }

  async function applyRequiredAction(action: CorrectiveAction) {
    setActionError(null);
    try {
      if (action.type === 'external') {
        await desktopApi.openExternal(action.url);
        return;
      }
      if (action.type === 'run') {
        if (currentRun.availableActions.includes(action.action)) await perform(action.action);
        return;
      }
      if (action.type === 'application') {
        if (action.action === 'configure_provider' || action.action === 'install_browser') {
          onOpenSettings();
          return;
        }
        if (action.action === 'review_policy') {
          onOpenRun(currentRun.id);
          return;
        }
        onOpenProjects();
      }
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <section className="workflow-dock" aria-label="Persistent run workflow">
      <header className="workflow-dock-heading">
        <div>
          <span className="workflow-live-mark" data-active={ongoingStatuses.has(currentRun.status)}>
            <i aria-hidden="true" />
            RUN {currentRun.id.slice(0, 8)}
          </span>
          <strong>{workflowTitle(currentRun)}</strong>
        </div>
        <div className="workflow-dock-state">
          <StatusPill status={currentRun.status} />
          <button
            type="button"
            className="icon-button"
            title="Inspect run evidence"
            onClick={() => onOpenRun(currentRun.id)}
          >
            <FileSearch size={16} />
          </button>
        </div>
      </header>

      <div className="workflow-dock-grid">
        <div className="workflow-boundary">
          <span>
            <GitBranch size={15} aria-hidden="true" />
            <strong>Isolated worktree</strong>
          </span>
          <code title={isolation?.worktreePath ?? currentRun.worktreePath ?? undefined}>
            {isolation?.worktreePath ?? currentRun.worktreePath ?? 'Preparing dedicated worktree'}
          </code>
          <small>
            {isolation?.branch ?? currentRun.branch ?? 'Branch pending'} · active checkout mutation{' '}
            {policy?.activeCheckoutMutationAllowed ? 'allowed' : 'blocked'}
          </small>
        </div>

        <div className="workflow-boundary">
          <span>
            <ShieldCheck size={15} aria-hidden="true" />
            <strong>Policy boundary</strong>
          </span>
          <p>
            {policy
              ? `${policy.publishProvider} publication ${
                  policy.publicationAllowed ? 'allowed' : 'blocked'
                }; auto-merge ${policy.autoMergeAllowed ? 'allowed' : 'blocked'}`
              : 'Dedicated worktree required; policy is being evaluated.'}
          </p>
          {policy?.blockedReasons.at(0) && <small>{policy.blockedReasons.at(0)}</small>}
        </div>

        <div className="workflow-specialists">
          {specialists.length > 0 ? (
            specialists.map((activity) => (
              <button
                type="button"
                key={activity.id}
                className="workflow-specialist-row"
                onClick={() => onOpenRun(currentRun.id)}
              >
                <span>{activity.role}</span>
                <strong>
                  {activity.label}: {activity.summary}
                </strong>
                <small title={activity.evidenceIds.join(', ')}>
                  {activity.supportingText} · {activity.evidenceIds.length} evidence
                </small>
              </button>
            ))
          ) : (
            <div className="workflow-specialist-empty">
              <LoaderCircle
                size={16}
                className={ongoingStatuses.has(currentRun.status) ? 'spin' : ''}
              />
              <span>
                {detailError
                  ? `Collaboration evidence unavailable: ${detailError}`
                  : 'Waiting for the first persisted specialist record'}
              </span>
            </div>
          )}
        </div>
      </div>

      {currentRun.intervention && (
        <div className="workflow-intervention">
          <div>
            <strong>{currentRun.intervention.summary}</strong>
            <p>{currentRun.intervention.requiredAction.description}</p>
          </div>
          {currentRun.intervention.requiredAction.type === 'command' ? (
            <code className="doctor-command">
              {formatCommand(currentRun.intervention.requiredAction.command)}
            </code>
          ) : (
            <button
              type="button"
              className="button quiet"
              onClick={() => void applyRequiredAction(currentRun.intervention!.requiredAction)}
            >
              {currentRun.intervention.requiredAction.type === 'external' ? (
                <ExternalLink size={15} />
              ) : (
                <ShieldCheck size={15} />
              )}
              {currentRun.intervention.requiredAction.label}
            </button>
          )}
          {currentRun.availableActions.includes('resolve_intervention') && (
            <>
              <select
                value={resolution ?? ''}
                onChange={(event) => setResolution(event.target.value as InterventionResolution)}
                aria-label="Intervention resolution"
              >
                {currentRun.intervention.resolutionOptions.map((option) => (
                  <option value={option} key={option}>
                    {option.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="button primary"
                disabled={busyAction === 'resolve_intervention' || !resolution}
                onClick={() => void perform('resolve_intervention')}
              >
                {busyAction === 'resolve_intervention' ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <CheckCircle2 size={15} />
                )}
                Recheck and continue
              </button>
            </>
          )}
        </div>
      )}

      <footer className="workflow-dock-footer">
        <div className="workflow-actions">
          {currentRun.availableActions
            .filter((action) => action !== 'resolve_intervention')
            .map((action) => {
              const Icon = actionIcon(action);
              return (
                <button
                  type="button"
                  className={action === 'cancel' ? 'button danger' : 'button quiet'}
                  key={action}
                  disabled={busyAction !== null}
                  onClick={() => void perform(action)}
                >
                  {busyAction === action ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Icon size={15} />
                  )}
                  {actionLabel(action)}
                </button>
              );
            })}
        </div>
        <SourceStamp
          provenance={{
            source: 'local',
            provider: 'QAgent workflow',
            capturedAt: currentRun.updatedAt,
          }}
        />
      </footer>
      {actionError && (
        <div className="workflow-action-error" role="alert">
          {actionError}
        </div>
      )}
    </section>
  );
}

function selectWorkflowRun(
  runs: Run[],
  selectedRunId: string | null,
  launchRunId: string | null
): Run | null {
  const selected = runs.find((run) => run.id === selectedRunId);
  if (selected && (ongoingStatuses.has(selected.status) || selected.availableActions.length > 0)) {
    return selected;
  }
  const launched = runs.find((run) => run.id === launchRunId);
  if (launched && (ongoingStatuses.has(launched.status) || launched.availableActions.length > 0)) {
    return launched;
  }
  return (
    runs.find((run) => run.status === 'waiting_for_intervention') ??
    runs.find((run) => run.status === 'interrupted') ??
    runs.find((run) => run.status === 'running' || run.status === 'queued') ??
    runs.find((run) => run.availableActions.length > 0) ??
    null
  );
}

function workflowTitle(run: Run): string {
  if (run.intervention) return run.intervention.summary;
  if (run.status === 'interrupted') return 'Recovery is ready';
  if (run.status === 'waiting_for_intervention') return 'Action is required';
  if (run.status === 'running' || run.status === 'queued') {
    return `${run.stage.replaceAll('_', ' ')} in progress`;
  }
  return run.error ?? run.summary ?? run.status.replaceAll('_', ' ');
}

function actionLabel(action: RunAction): string {
  if (action === 'resume') return 'Resume';
  if (action === 'retry') return 'Retry';
  if (action === 'reconnect') return 'Reconnect';
  if (action === 'cancel') return 'Cancel';
  return 'Resolve';
}

function actionIcon(action: RunAction) {
  if (action === 'resume') return Play;
  if (action === 'retry') return RefreshCw;
  if (action === 'reconnect') return Wifi;
  if (action === 'cancel') return Ban;
  return CheckCircle2;
}

function specialistEntries(detail: RunDetail) {
  return [
    ...detail.specialistActivities.map((activity) => ({
      id: activity.id,
      role: activity.role,
      label: activity.status.replaceAll('_', ' '),
      summary: activity.summary,
      supportingText: activity.handoffTarget
        ? `Handoff to ${activity.handoffTarget}`
        : specialistSource(activity.source),
      evidenceIds: activity.evidenceIds,
      occurredAt: activity.occurredAt,
    })),
    ...detail.specialistCritiques.map((critique) => ({
      id: critique.id,
      role: critique.role,
      label: critique.verdict.replaceAll('_', ' '),
      summary: critique.summary,
      supportingText: critique.actionRequired ?? specialistSource(critique.source),
      evidenceIds: critique.evidenceIds,
      occurredAt: critique.occurredAt,
    })),
    ...detail.specialistDecisions.map((decision) => ({
      id: decision.id,
      role: decision.role,
      label: `decision · ${decision.action}`,
      summary: decision.summary,
      supportingText: decision.handoffTarget
        ? `Handoff to ${decision.handoffTarget}`
        : specialistSource(decision.source),
      evidenceIds: decision.evidenceIds,
      occurredAt: decision.occurredAt,
    })),
    ...detail.specialistObjections.map((objection) => ({
      id: objection.id,
      role: objection.role,
      label: 'objection',
      summary: objection.summary,
      supportingText: objection.actionRequired,
      evidenceIds: objection.evidenceIds,
      occurredAt: objection.occurredAt,
    })),
    ...detail.specialistHandoffs.map((handoff) => ({
      id: handoff.id,
      role: handoff.from,
      label: `handoff · ${handoff.to}`,
      summary: handoff.summary,
      supportingText: handoff.actionRequired ?? specialistSource(handoff.source),
      evidenceIds: handoff.evidenceIds,
      occurredAt: handoff.occurredAt,
    })),
  ].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

function specialistSource(
  source:
    | { kind: 'provider_call'; providerCallId: string }
    | { kind: 'policy_worker'; worker: string; invocationId: string }
): string {
  return source.kind === 'provider_call'
    ? 'Provider-backed record'
    : `Policy worker ${source.worker}`;
}
