import type { SpecialistRole } from '@qagent/contracts';
import scoutPortrait from '../../assets/agents/scout.png';
import tracePortrait from '../../assets/agents/trace.png';
import patchPortrait from '../../assets/agents/patch.png';
import proofPortrait from '../../assets/agents/proof.png';
import gatePortrait from '../../assets/agents/gate.png';
import {
  deriveSpecialistBay,
  type SpecialistBayRecord,
  type SpecialistSignalRecord,
} from './model.js';

interface SpecialistBayProps {
  events: readonly unknown[];
}

interface SpecialistDefinition {
  role: SpecialistRole;
  label: string;
  remit: string;
  portrait: string;
}

const specialists: SpecialistDefinition[] = [
  { role: 'scout', label: 'Scout', remit: 'Browser evidence', portrait: scoutPortrait },
  { role: 'trace', label: 'Trace', remit: 'Diagnosis', portrait: tracePortrait },
  { role: 'patch', label: 'Patch', remit: 'Repair', portrait: patchPortrait },
  { role: 'proof', label: 'Proof', remit: 'Verification', portrait: proofPortrait },
  { role: 'gate', label: 'Gate', remit: 'Security + publish', portrait: gatePortrait },
];

export function SpecialistBay({ events }: SpecialistBayProps) {
  const bay = deriveSpecialistBay(events);
  const signalCount = new Set(
    bay.flatMap((station) => station.signals.map((signal) => signal.eventId))
  ).size;
  return (
    <section className="signal-specialist-bay" data-testid="specialist-bay">
      <header>
        <span>
          <small>Persisted specialist events</small>
          <strong>Specialist bay</strong>
        </span>
        <code>{signalCount} signals</code>
      </header>
      <div className="signal-specialist-grid">
        {specialists.map((specialist) => (
          <SpecialistStation
            key={specialist.role}
            specialist={specialist}
            station={bay.find((candidate) => candidate.role === specialist.role)!}
          />
        ))}
      </div>
    </section>
  );
}

function SpecialistStation({
  specialist,
  station,
}: {
  specialist: SpecialistDefinition;
  station: SpecialistBayRecord;
}) {
  const latest = station.signals.at(-1) ?? null;
  const presentation = latest ? describeSignal(specialist.role, latest) : null;
  return (
    <article
      className="signal-specialist-station"
      data-role={specialist.role}
      data-signal={presentation?.status ?? 'none'}
    >
      <div className="signal-specialist-portrait" aria-hidden="true">
        <img src={specialist.portrait} alt="" />
        <span />
      </div>
      <div className="signal-specialist-copy">
        <span>
          <strong>{specialist.label}</strong>
          <small>{specialist.remit}</small>
        </span>
        <p title={presentation?.summary}>{presentation?.summary ?? 'Awaiting specialist signal'}</p>
        {presentation && (
          <small className="signal-specialist-meta">
            {presentation.label} · {new Date(presentation.occurredAt).toLocaleTimeString()}
          </small>
        )}
      </div>
    </article>
  );
}

function describeSignal(role: SpecialistRole, signal: SpecialistSignalRecord) {
  if (signal.kind === 'activity') {
    const label =
      signal.status === 'succeeded'
        ? 'Completed'
        : signal.status === 'started'
          ? 'Started'
          : signal.status;
    return {
      status: signal.status,
      label,
      summary: signal.message,
      occurredAt: signal.occurredAt,
    };
  }
  if (signal.kind === 'handoff') {
    const outgoing = signal.handoffFrom === role;
    return {
      status: 'handoff',
      label: outgoing
        ? `Handoff to ${capitalize(signal.handoffTo ?? 'unknown')}`
        : `From ${capitalize(signal.handoffFrom ?? 'unknown')}`,
      summary: signal.message,
      occurredAt: signal.occurredAt,
    };
  }
  if (signal.kind === 'decision') {
    return {
      status: signal.action,
      label: `Decision: ${signal.action ?? 'recorded'}`,
      summary: signal.message,
      occurredAt: signal.occurredAt,
    };
  }
  if (signal.kind === 'critique') {
    return {
      status: signal.action,
      label: `Critique: ${(signal.action ?? 'recorded').replace('_', ' ')}`,
      summary: signal.message,
      occurredAt: signal.occurredAt,
    };
  }
  return {
    status: 'objection',
    label: 'Objection',
    summary: signal.message,
    occurredAt: signal.occurredAt,
  };
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
