import type { RunDetailData } from '../types.js';
import { Activity, Cpu, Database, Radio, type LucideIcon } from 'lucide-react';
import { eventMessage, runOutcomeTitle, stageAction } from '../run-observability.js';
import { AgentPresence, type AgentPresenceMode } from './agent-presence.js';

export function LiveRunSignal({ detail }: { detail: RunDetailData }) {
  const latestEvent = detail.events.at(-1);
  const traceEvent = detail.events.findLast((event) => event.kind === 'trace.status');
  const traceState = traceEvent?.kind === 'trace.status' ? traceEvent.payload.state : null;
  const active = detail.run.status === 'running' || detail.run.status === 'queued';
  const mode: AgentPresenceMode =
    detail.run.status === 'succeeded'
      ? 'ready'
      : detail.run.status === 'failed' || detail.run.status === 'policy_blocked'
        ? 'blocked'
        : active
          ? 'working'
          : 'idle';
  const source = latestEvent
    ? (latestEvent.provenance.provider ?? latestEvent.provenance.source)
    : 'local';
  const observedAt = latestEvent?.occurredAt ?? detail.run.updatedAt;
  const latestArtifact = detail.artifacts.at(-1);
  const latestProviderCall = detail.providerCalls.at(-1);

  return (
    <div className={`run-live-signal run-live-signal-${mode}`}>
      <AgentPresence
        mode={mode}
        title={
          (active ? null : runOutcomeTitle(detail.run)) ??
          (latestEvent ? eventMessage(latestEvent) : stageAction(detail.run.stage))
        }
        detail={
          detail.run.error ??
          (active
            ? undefined
            : latestEvent
              ? stageAction(latestEvent.stage)
              : 'Waiting for the first persisted event')
        }
        meta={`${source} / ${new Date(observedAt).toLocaleTimeString()}${
          latestEvent ? ` / event ${latestEvent.sequence}` : ''
        }`}
        compact
        announce={!active}
      />
      <dl className="observation-strip" aria-label="Run observations">
        <Observation
          icon={Database}
          label="Evidence"
          value={detail.artifacts.length > 0 ? String(detail.artifacts.length) : 'None yet'}
          source={
            latestArtifact
              ? (latestArtifact.provenance.provider ?? latestArtifact.provenance.source)
              : 'artifact store'
          }
          observedAt={latestArtifact?.createdAt ?? detail.run.updatedAt}
        />
        <Observation
          icon={Activity}
          label="Events"
          value={String(detail.events.length)}
          source={source}
          observedAt={observedAt}
        />
        <Observation
          icon={Cpu}
          label="Models"
          value={
            detail.providerCalls.length > 0
              ? String(detail.providerCalls.length)
              : active
                ? 'None yet'
                : 'Not used'
          }
          source={latestProviderCall?.provider ?? 'provider ledger'}
          observedAt={latestProviderCall?.createdAt ?? detail.run.updatedAt}
        />
        <Observation
          icon={Radio}
          label="Trace"
          value={traceState ?? (active ? 'Pending' : 'Not recorded')}
          source={
            traceEvent?.provenance.provider ?? traceEvent?.provenance.source ?? 'event stream'
          }
          observedAt={traceEvent?.occurredAt ?? detail.run.updatedAt}
        />
      </dl>
    </div>
  );
}

function Observation({
  icon: Icon,
  label,
  value,
  source,
  observedAt,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  source: string;
  observedAt: string;
}) {
  return (
    <div>
      <dt>
        <Icon size={13} aria-hidden="true" /> {label}
      </dt>
      <dd>
        <strong>{value}</strong>
        <small title={new Date(observedAt).toLocaleString()}>
          {source} ·{' '}
          {new Date(observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </small>
      </dd>
    </div>
  );
}
