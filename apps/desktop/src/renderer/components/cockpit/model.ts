import type { Artifact, RunEvent, RunStage } from '@qagent/contracts';

export interface ConsoleStreamRecord {
  sequence: number;
  occurredAt: string;
  stream: 'stdout' | 'stderr' | 'combined';
  text: string;
  truncated: boolean;
  omittedBytes: number;
  redactionCount: number;
}

export interface ConsoleRecord {
  id: string;
  commandId: string | null;
  executable: string | null;
  args: string[];
  cwd: string | null;
  stage: RunStage;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  startedAt: string | null;
  completedAt: string | null;
  startSequence: number | null;
  endSequence: number | null;
  exitCode: number | null;
  durationMs: number | null;
  source: string;
  streams: ConsoleStreamRecord[];
  artifact: Artifact | null;
}

export interface BrowserCheckpointRecord {
  id: string;
  event: RunEvent;
  sessionId: string | null;
  checkpointId: string | null;
  flow: string;
  url: string | null;
  title: string | null;
  attempt: number | null;
  stage: RunStage;
  sequence: number;
  occurredAt: string;
  capturedAt: string | null;
  source: string;
  provider: string | null;
  screenshot: Artifact | null;
  report: Artifact | null;
  legacy: boolean;
}

export type SpecialistRoleName = 'scout' | 'trace' | 'patch' | 'proof' | 'gate';
export type SpecialistActivityStatus = 'started' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';

export interface SpecialistSignalRecord {
  id: string;
  eventId: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  stage: RunStage;
  kind: 'activity' | 'critique' | 'decision' | 'objection' | 'handoff';
  role: SpecialistRoleName;
  status: SpecialistActivityStatus | null;
  action: string | null;
  message: string;
  reason: string | null;
  actionRequired: string | null;
  handoffFrom: SpecialistRoleName | null;
  handoffTo: SpecialistRoleName | null;
  evidenceIds: string[];
  source: string;
}

export interface SpecialistBayRecord {
  role: SpecialistRoleName;
  status: SpecialistActivityStatus | null;
  latestMessage: string | null;
  latestAction: string | null;
  handoffTo: SpecialistRoleName | null;
  signals: SpecialistSignalRecord[];
}

const SPECIALIST_ROLES: SpecialistRoleName[] = ['scout', 'trace', 'patch', 'proof', 'gate'];
const SPECIALIST_STATUSES: SpecialistActivityStatus[] = [
  'started',
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
];
const RUN_STAGES: RunStage[] = [
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

export function deriveConsoleRecords(
  events: readonly RunEvent[],
  artifacts: readonly Artifact[]
): ConsoleRecord[] {
  const ordered = orderEvents(events);
  const structured = deriveStructuredConsoleRecords(ordered, artifacts);
  const legacy = deriveLegacyConsoleRecords(
    ordered.filter(
      (event) =>
        !(
          (event.kind === 'command.started' || event.kind === 'command.completed') &&
          event.payload.commandId
        )
    ),
    artifacts
  );
  return [...structured, ...legacy].sort(
    (left, right) => recordSequence(left) - recordSequence(right)
  );
}

export function deriveBrowserCheckpoints(
  events: readonly RunEvent[],
  artifacts: readonly Artifact[]
): BrowserCheckpointRecord[] {
  const ordered = orderEvents(events);
  const checkpoints = ordered.filter((event) => event.kind === 'browser.checkpoint');
  const sourceEvents =
    checkpoints.length > 0
      ? checkpoints
      : ordered.filter(
          (event) => event.kind === 'evidence.captured' && event.payload.kind === 'browser'
        );

  return sourceEvents.flatMap((event): BrowserCheckpointRecord[] => {
    const linked = linkedArtifacts(event, artifacts);
    const screenshot = linked.find((artifact) => artifact.kind === 'screenshot') ?? null;
    const report = linked.find((artifact) => artifact.kind === 'report') ?? null;

    if (event.kind === 'browser.checkpoint') {
      return [
        {
          id: event.payload.checkpointId,
          event,
          sessionId: event.payload.sessionId,
          checkpointId: event.payload.checkpointId,
          flow: event.payload.flow,
          url: event.payload.url,
          title: event.payload.title,
          attempt: event.payload.attempt,
          stage: event.stage,
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          capturedAt: event.provenance.capturedAt ?? null,
          source: eventSource(event),
          provider: event.provenance.provider ?? null,
          screenshot,
          report,
          legacy: false,
        },
      ];
    }

    if (event.kind !== 'evidence.captured') return [];
    return [
      {
        id: event.id,
        event,
        sessionId: null,
        checkpointId: null,
        flow: event.payload.name,
        url: null,
        title: null,
        attempt: null,
        stage: event.stage,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        capturedAt: event.provenance.capturedAt ?? null,
        source: eventSource(event),
        provider: event.provenance.provider ?? null,
        screenshot,
        report,
        legacy: true,
      },
    ];
  });
}

export function extractSpecialistSignals(events: readonly unknown[]): SpecialistSignalRecord[] {
  const signals = events.flatMap((value) => {
    const event = specialistEventEnvelope(value);
    if (!event) return [];

    switch (event.kind) {
      case 'specialist.activity':
        return specialistActivitySignal(event);
      case 'specialist.critique':
        return specialistCritiqueSignal(event);
      case 'specialist.decision':
        return specialistDecisionSignal(event);
      case 'specialist.objection':
        return specialistObjectionSignal(event);
      case 'specialist.handoff':
        return specialistHandoffSignal(event);
      default:
        return [];
    }
  });

  return signals.sort((left, right) => left.sequence - right.sequence);
}

export function deriveSpecialistBay(events: readonly unknown[]): SpecialistBayRecord[] {
  const signals = extractSpecialistSignals(events);
  return SPECIALIST_ROLES.map((role) => {
    const roleSignals = signals.filter((signal) => signal.role === role);
    const latest = roleSignals.at(-1) ?? null;
    const latestActivity = roleSignals.findLast((signal) => signal.kind === 'activity') ?? null;
    const latestDecision = roleSignals.findLast((signal) => signal.kind === 'decision') ?? null;
    const latestHandoff = roleSignals.findLast((signal) => signal.kind === 'handoff') ?? null;

    return {
      role,
      status: latestActivity?.status ?? null,
      latestMessage: latest?.message ?? null,
      latestAction: latestDecision?.action ?? null,
      handoffTo:
        latestHandoff?.handoffTo ?? latestDecision?.handoffTo ?? latestActivity?.handoffTo ?? null,
      signals: roleSignals,
    };
  });
}

function deriveStructuredConsoleRecords(
  events: readonly RunEvent[],
  artifacts: readonly Artifact[]
): ConsoleRecord[] {
  const records = new Map<string, ConsoleRecord>();
  const serviceCommands = new Map<string, string>();

  for (const event of events) {
    if (event.kind === 'command.started' && event.payload.commandId) {
      const record = structuredRecord(records, event.payload.commandId, event);
      record.executable = event.payload.executable;
      record.args = [...event.payload.args];
      record.stage = event.stage;
      record.status = 'running';
      record.startedAt = event.occurredAt;
      record.startSequence = event.sequence;
      record.source = eventSource(event);
      continue;
    }

    if (event.kind === 'target.service_started') {
      serviceCommands.set(event.payload.serviceId, event.payload.commandId);
      const record = structuredRecord(records, event.payload.commandId, event);
      record.executable = event.payload.executable;
      record.args = [...event.payload.args];
      record.stage = event.stage;
      record.status = 'running';
      record.startedAt = event.occurredAt;
      record.startSequence = event.sequence;
      record.source = eventSource(event);
      continue;
    }

    if (event.kind === 'command.output') {
      const record = structuredRecord(records, event.payload.commandId, event);
      record.streams.push({
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        stream: event.payload.stream,
        text: event.payload.output.text,
        truncated: event.payload.output.truncated,
        omittedBytes: event.payload.output.omittedBytes,
        redactionCount: event.payload.output.redactionCount,
      });
      continue;
    }

    if (event.kind === 'command.completed' && event.payload.commandId) {
      const record = structuredRecord(records, event.payload.commandId, event);
      record.executable = event.payload.executable;
      record.args = [...event.payload.args];
      record.status =
        event.payload.exitCode === 0
          ? 'succeeded'
          : event.payload.exitCode === null
            ? 'unknown'
            : 'failed';
      record.completedAt = event.occurredAt;
      record.endSequence = event.sequence;
      record.exitCode = event.payload.exitCode;
      record.durationMs = event.payload.durationMs;
      record.source = eventSource(event);
      record.artifact =
        linkedArtifacts(event, artifacts).find((artifact) => artifact.kind === 'log') ?? null;
      continue;
    }

    if (event.kind === 'command.failed' || event.kind === 'command.cancelled') {
      const record = structuredRecord(records, event.payload.commandId, event);
      record.status = event.kind === 'command.failed' ? 'failed' : 'cancelled';
      record.completedAt = event.occurredAt;
      record.endSequence = event.sequence;
      record.durationMs = event.payload.durationMs;
      record.source = eventSource(event);
      if (
        record.streams.length === 0 &&
        (event.payload.output.text ||
          event.payload.output.truncated ||
          event.payload.output.omittedBytes > 0)
      ) {
        record.streams.push({
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          stream: 'combined',
          text: event.payload.output.text,
          truncated: event.payload.output.truncated,
          omittedBytes: event.payload.output.omittedBytes,
          redactionCount: event.payload.output.redactionCount,
        });
      }
    }

    if (event.kind === 'target.service_exited') {
      const commandId = serviceCommands.get(event.payload.serviceId);
      if (!commandId) continue;
      const record = structuredRecord(records, commandId, event);
      record.status =
        event.payload.expected || event.payload.exitCode === 0 ? 'succeeded' : 'failed';
      record.completedAt = event.occurredAt;
      record.endSequence = event.sequence;
      record.exitCode = event.payload.exitCode;
      record.durationMs = event.payload.durationMs;
      record.source = eventSource(event);
      continue;
    }

    if (event.kind === 'target.service_failed') {
      const commandId = serviceCommands.get(event.payload.serviceId);
      if (!commandId) continue;
      const record = structuredRecord(records, commandId, event);
      record.status = 'failed';
      record.completedAt = event.occurredAt;
      record.endSequence = event.sequence;
      record.source = eventSource(event);
      record.artifact =
        linkedArtifacts(event, artifacts).find((artifact) => artifact.kind === 'log') ?? null;
    }
  }

  return [...records.values()].sort((left, right) => recordSequence(left) - recordSequence(right));
}

function structuredRecord(
  records: Map<string, ConsoleRecord>,
  commandId: string,
  event: RunEvent
): ConsoleRecord {
  const existing = records.get(commandId);
  if (existing) return existing;
  const record: ConsoleRecord = {
    id: commandId,
    commandId,
    executable: null,
    args: [],
    cwd: null,
    stage: event.stage,
    status: 'unknown',
    startedAt: null,
    completedAt: null,
    startSequence: null,
    endSequence: null,
    exitCode: null,
    durationMs: null,
    source: eventSource(event),
    streams: [],
    artifact: null,
  };
  records.set(commandId, record);
  return record;
}

function deriveLegacyConsoleRecords(
  events: readonly RunEvent[],
  artifacts: readonly Artifact[]
): ConsoleRecord[] {
  const records: ConsoleRecord[] = [];
  const pending: ConsoleRecord[] = [];

  for (const event of events) {
    if (event.kind === 'command.started') {
      const record: ConsoleRecord = {
        id: event.id,
        commandId: null,
        executable: event.payload.executable,
        args: [...event.payload.args],
        cwd: null,
        stage: event.stage,
        status: 'running',
        startedAt: event.occurredAt,
        completedAt: null,
        startSequence: event.sequence,
        endSequence: null,
        exitCode: null,
        durationMs: null,
        source: eventSource(event),
        streams: [],
        artifact: null,
      };
      records.push(record);
      pending.push(record);
      continue;
    }

    if (event.kind !== 'command.completed') continue;
    const pendingIndex = pending.findIndex(
      (record) =>
        record.commandId === null &&
        record.executable === event.payload.executable &&
        stringArraysEqual(record.args, event.payload.args)
    );
    const matched = pendingIndex >= 0 ? pending.splice(pendingIndex, 1)[0] : undefined;
    const record: ConsoleRecord = matched ?? {
      id: event.id,
      commandId: null,
      executable: event.payload.executable,
      args: [...event.payload.args],
      cwd: null,
      stage: event.stage,
      status: 'unknown',
      startedAt: null,
      completedAt: null,
      startSequence: null,
      endSequence: null,
      exitCode: null,
      durationMs: null,
      source: eventSource(event),
      streams: [],
      artifact: null,
    };
    if (!matched) records.push(record);

    record.status =
      event.payload.exitCode === 0
        ? 'succeeded'
        : event.payload.exitCode === null
          ? 'unknown'
          : 'failed';
    record.completedAt = event.occurredAt;
    record.endSequence = event.sequence;
    record.exitCode = event.payload.exitCode;
    record.durationMs = event.payload.durationMs;
    record.source = eventSource(event);
    record.artifact =
      linkedArtifacts(event, artifacts).find((artifact) => artifact.kind === 'log') ?? null;
  }

  return records;
}

function recordSequence(record: ConsoleRecord): number {
  return (
    record.startSequence ??
    record.streams.at(0)?.sequence ??
    record.endSequence ??
    Number.MAX_SAFE_INTEGER
  );
}

function orderEvents(events: readonly RunEvent[]): RunEvent[] {
  return [...events].sort((left, right) => left.sequence - right.sequence);
}

function linkedArtifacts(event: RunEvent, artifacts: readonly Artifact[]): Artifact[] {
  const byId = new Map(
    artifacts
      .filter((artifact) => artifact.runId === event.runId)
      .map((artifact) => [artifact.id, artifact])
  );
  return event.artifactIds.flatMap((artifactId) => {
    const artifact = byId.get(artifactId);
    return artifact ? [artifact] : [];
  });
}

function eventSource(event: RunEvent): string {
  return event.provenance.provider ?? event.provenance.source;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface SpecialistEventEnvelope {
  id: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  stage: RunStage;
  kind:
    | 'specialist.activity'
    | 'specialist.critique'
    | 'specialist.decision'
    | 'specialist.objection'
    | 'specialist.handoff';
  payload: Record<string, unknown>;
  source: string;
}

function specialistEventEnvelope(value: unknown): SpecialistEventEnvelope | null {
  if (!isRecord(value) || !isSpecialistKind(value.kind)) return null;
  if (
    !isString(value.id) ||
    !isString(value.runId) ||
    !isPositiveInteger(value.sequence) ||
    !isString(value.occurredAt) ||
    !isRunStage(value.stage) ||
    !isRecord(value.payload) ||
    !isRecord(value.provenance) ||
    !isString(value.provenance.source)
  ) {
    return null;
  }
  const provider = value.provenance.provider;
  if (provider !== undefined && !isString(provider)) return null;
  return {
    id: value.id,
    runId: value.runId,
    sequence: value.sequence,
    occurredAt: value.occurredAt,
    stage: value.stage,
    kind: value.kind,
    payload: value.payload,
    source: provider ?? value.provenance.source,
  };
}

function specialistActivitySignal(event: SpecialistEventEnvelope): SpecialistSignalRecord[] {
  const activity = event.payload.activity;
  if (!isRecord(activity)) return [];
  if (
    !isString(activity.id) ||
    !isSpecialistRole(activity.role) ||
    !isSpecialistStatus(activity.status) ||
    !isString(activity.summary) ||
    !isString(activity.occurredAt) ||
    !isStringArray(activity.evidenceIds)
  ) {
    return [];
  }
  const handoffTo =
    activity.handoffTarget === null
      ? null
      : isSpecialistRole(activity.handoffTarget)
        ? activity.handoffTarget
        : undefined;
  if (handoffTo === undefined) return [];
  return [
    signalBase(event, {
      id: activity.id,
      occurredAt: activity.occurredAt,
      kind: 'activity',
      role: activity.role,
      status: activity.status,
      action: null,
      message: activity.summary,
      reason: null,
      actionRequired: null,
      handoffFrom: null,
      handoffTo,
      evidenceIds: activity.evidenceIds,
    }),
  ];
}

function specialistCritiqueSignal(event: SpecialistEventEnvelope): SpecialistSignalRecord[] {
  const critique = event.payload.critique;
  if (!isRecord(critique)) return [];
  if (
    !isString(critique.id) ||
    !isSpecialistRole(critique.role) ||
    !isString(critique.verdict) ||
    !isString(critique.summary) ||
    !isString(critique.occurredAt) ||
    !isStringArray(critique.evidenceIds)
  ) {
    return [];
  }
  const actionRequired = nullableString(critique.actionRequired);
  if (actionRequired === undefined) return [];
  return [
    signalBase(event, {
      id: critique.id,
      occurredAt: critique.occurredAt,
      kind: 'critique',
      role: critique.role,
      status: null,
      action: critique.verdict,
      message: critique.summary,
      reason: null,
      actionRequired,
      handoffFrom: null,
      handoffTo: null,
      evidenceIds: critique.evidenceIds,
    }),
  ];
}

function specialistDecisionSignal(event: SpecialistEventEnvelope): SpecialistSignalRecord[] {
  const decision = event.payload.decision;
  if (!isRecord(decision)) return [];
  if (
    !isString(decision.id) ||
    !isSpecialistRole(decision.role) ||
    !isString(decision.action) ||
    !isString(decision.summary) ||
    !isString(decision.occurredAt) ||
    !isStringArray(decision.evidenceIds)
  ) {
    return [];
  }
  const handoffTo = nullableRole(decision.handoffTarget);
  if (handoffTo === undefined) return [];
  return [
    signalBase(event, {
      id: decision.id,
      occurredAt: decision.occurredAt,
      kind: 'decision',
      role: decision.role,
      status: null,
      action: decision.action,
      message: decision.summary,
      reason: null,
      actionRequired: null,
      handoffFrom: null,
      handoffTo,
      evidenceIds: decision.evidenceIds,
    }),
  ];
}

function specialistObjectionSignal(event: SpecialistEventEnvelope): SpecialistSignalRecord[] {
  const objection = event.payload.objection;
  if (!isRecord(objection)) return [];
  if (
    !isString(objection.id) ||
    !isSpecialistRole(objection.role) ||
    !isString(objection.summary) ||
    !isString(objection.reason) ||
    !isString(objection.actionRequired) ||
    !isString(objection.occurredAt) ||
    !isStringArray(objection.evidenceIds)
  ) {
    return [];
  }
  return [
    signalBase(event, {
      id: objection.id,
      occurredAt: objection.occurredAt,
      kind: 'objection',
      role: objection.role,
      status: null,
      action: null,
      message: objection.summary,
      reason: objection.reason,
      actionRequired: objection.actionRequired,
      handoffFrom: null,
      handoffTo: null,
      evidenceIds: objection.evidenceIds,
    }),
  ];
}

function specialistHandoffSignal(event: SpecialistEventEnvelope): SpecialistSignalRecord[] {
  const handoff = event.payload.handoff;
  if (!isRecord(handoff)) return [];
  if (
    !isString(handoff.id) ||
    !isSpecialistRole(handoff.from) ||
    !isSpecialistRole(handoff.to) ||
    !isString(handoff.summary) ||
    !isString(handoff.occurredAt) ||
    !isStringArray(handoff.evidenceIds)
  ) {
    return [];
  }
  const actionRequired = nullableString(handoff.actionRequired);
  if (actionRequired === undefined) return [];
  const shared = {
    occurredAt: handoff.occurredAt,
    kind: 'handoff' as const,
    status: null,
    action: null,
    message: handoff.summary,
    reason: null,
    actionRequired,
    handoffFrom: handoff.from,
    handoffTo: handoff.to,
    evidenceIds: handoff.evidenceIds,
  };
  return [
    signalBase(event, { ...shared, id: `${handoff.id}:from`, role: handoff.from }),
    signalBase(event, { ...shared, id: `${handoff.id}:to`, role: handoff.to }),
  ];
}

function signalBase(
  event: SpecialistEventEnvelope,
  signal: Omit<SpecialistSignalRecord, 'eventId' | 'runId' | 'sequence' | 'stage' | 'source'>
): SpecialistSignalRecord {
  return {
    ...signal,
    eventId: event.id,
    runId: event.runId,
    sequence: event.sequence,
    stage: event.stage,
    source: event.source,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isRunStage(value: unknown): value is RunStage {
  return isString(value) && RUN_STAGES.includes(value as RunStage);
}

function isSpecialistRole(value: unknown): value is SpecialistRoleName {
  return isString(value) && SPECIALIST_ROLES.includes(value as SpecialistRoleName);
}

function isSpecialistStatus(value: unknown): value is SpecialistActivityStatus {
  return isString(value) && SPECIALIST_STATUSES.includes(value as SpecialistActivityStatus);
}

function isSpecialistKind(value: unknown): value is SpecialistEventEnvelope['kind'] {
  return (
    value === 'specialist.activity' ||
    value === 'specialist.critique' ||
    value === 'specialist.decision' ||
    value === 'specialist.objection' ||
    value === 'specialist.handoff'
  );
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : isString(value) ? value : undefined;
}

function nullableRole(value: unknown): SpecialistRoleName | null | undefined {
  return value === null ? null : isSpecialistRole(value) ? value : undefined;
}
