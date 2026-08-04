import { useEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, RunEvent } from '@qagent/contracts';
import {
  Check,
  ChevronsDown,
  Clipboard,
  FileText,
  ListFilter,
  Pause,
  Play,
  Search,
  TerminalSquare,
} from 'lucide-react';
import { SourceStamp } from '../source-stamp.js';
import { StatusPill } from '../status-pill.js';
import type { ArtifactPreview, RunDetailData } from '../../types.js';
import type { ConsoleRecord } from './model.js';

type ConsoleTab = 'output' | 'dossier' | 'events';
type StreamFilter = 'all' | 'stdout' | 'stderr' | 'combined';

interface RunConsoleProps {
  detail: RunDetailData;
  records: ConsoleRecord[];
  previews: Record<string, ArtifactPreview>;
  previewErrors: Record<string, string>;
  onOpenArtifact: (artifact: Artifact, trigger: HTMLElement) => Promise<void>;
}

interface FrozenConsole {
  records: ConsoleRecord[];
  previews: Record<string, ArtifactPreview>;
  previewErrors: Record<string, string>;
}

export function RunConsole({
  detail,
  records,
  previews,
  previewErrors,
  onOpenArtifact,
}: RunConsoleProps) {
  const [tab, setTab] = useState<ConsoleTab>('output');
  const [query, setQuery] = useState('');
  const [streamFilter, setStreamFilter] = useState<StreamFilter>('all');
  const [stageFilter, setStageFilter] = useState('all');
  const [followTail, setFollowTail] = useState(true);
  const [frozen, setFrozen] = useState<FrozenConsole | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const scrollRef = useRef<HTMLDivElement>(null);
  const visibleRecords = frozen?.records ?? records;
  const visiblePreviews = frozen?.previews ?? previews;
  const visibleErrors = frozen?.previewErrors ?? previewErrors;
  const filteredRecords = useMemo(
    () =>
      visibleRecords.filter((record) => {
        if (stageFilter !== 'all' && record.stage !== stageFilter) return false;
        if (
          streamFilter !== 'all' &&
          record.streams.every((stream) => stream.stream !== streamFilter)
        ) {
          return false;
        }
        if (!query.trim()) return true;
        const haystack = [
          record.executable,
          record.args.join(' '),
          record.cwd,
          ...record.streams.map((stream) => stream.text),
          record.artifact ? visiblePreviews[record.artifact.id]?.data : null,
        ]
          .filter(Boolean)
          .join('\n')
          .toLowerCase();
        return haystack.includes(query.trim().toLowerCase());
      }),
    [query, stageFilter, streamFilter, visiblePreviews, visibleRecords]
  );
  const stageOptions = [...new Set(visibleRecords.map((record) => record.stage))];
  const tailKey = records
    .flatMap((record) => record.streams.map((stream) => stream.sequence))
    .at(-1);

  useEffect(() => {
    if (tab !== 'output' || frozen || !followTail) return;
    const target = scrollRef.current;
    if (target) target.scrollTop = target.scrollHeight;
  }, [followTail, frozen, records.length, tab, tailKey]);

  function toggleVisualPause() {
    if (frozen) {
      setFrozen(null);
      return;
    }
    setFrozen({
      records: structuredClone(records),
      previews: { ...previews },
      previewErrors: { ...previewErrors },
    });
  }

  async function copyVisibleOutput() {
    const text = filteredRecords
      .map((record) => serializeRecord(record, visiblePreviews))
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1200);
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <section className="signal-run-console" data-testid="run-console">
      <header className="signal-panel-heading signal-console-heading">
        <span>
          <small>Durable execution ledger</small>
          <strong>Execution output</strong>
        </span>
        <div className="signal-console-tabs" role="tablist" aria-label="Run console views">
          <ConsoleTabButton current={tab} value="output" label="Output" onChange={setTab} />
          <ConsoleTabButton current={tab} value="dossier" label="Dossier" onChange={setTab} />
          <ConsoleTabButton current={tab} value="events" label="Events" onChange={setTab} />
        </div>
      </header>

      {tab === 'output' && (
        <>
          <div className="signal-console-toolbar">
            <label className="signal-console-search">
              <Search size={13} aria-hidden="true" />
              <span className="sr-only">Filter execution output</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Filter output"
              />
            </label>
            <label className="signal-console-select">
              <ListFilter size={13} aria-hidden="true" />
              <span className="sr-only">Stage filter</span>
              <select
                value={stageFilter}
                onChange={(event) => setStageFilter(event.currentTarget.value)}
              >
                <option value="all">All stages</option>
                {stageOptions.map((stage) => (
                  <option key={stage} value={stage}>
                    {stage.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label className="signal-console-select">
              <TerminalSquare size={13} aria-hidden="true" />
              <span className="sr-only">Stream filter</span>
              <select
                value={streamFilter}
                onChange={(event) => setStreamFilter(event.currentTarget.value as StreamFilter)}
              >
                <option value="all">All streams</option>
                <option value="stdout">stdout</option>
                <option value="stderr">stderr</option>
                <option value="combined">combined</option>
              </select>
            </label>
            <div className="signal-console-actions">
              <button
                type="button"
                aria-label={frozen ? 'Resume visual output' : 'Pause visual output'}
                aria-pressed={Boolean(frozen)}
                title={frozen ? 'Resume visual output' : 'Pause visual output'}
                onClick={toggleVisualPause}
              >
                {frozen ? <Play size={14} /> : <Pause size={14} />}
              </button>
              <button
                type="button"
                aria-label="Toggle follow tail"
                aria-pressed={followTail}
                title="Toggle follow tail"
                onClick={() => setFollowTail((value) => !value)}
              >
                <ChevronsDown size={14} />
              </button>
              <button
                type="button"
                aria-label="Copy visible console"
                title="Copy visible console"
                onClick={() => void copyVisibleOutput()}
              >
                {copyState === 'copied' ? <Check size={14} /> : <Clipboard size={14} />}
              </button>
            </div>
          </div>
          <div className="signal-console-state" aria-live="polite">
            <span>
              {frozen ? 'Visual output paused' : 'Following persisted output'}
              {followTail && !frozen ? ' · tail on' : ''}
            </span>
            <code>{filteredRecords.length} commands</code>
            {copyState === 'failed' && (
              <span className="signal-copy-error">Clipboard unavailable</span>
            )}
          </div>
          <div
            ref={scrollRef}
            className="signal-console-scroll"
            onScroll={(event) => {
              const target = event.currentTarget;
              const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 24;
              if (!nearBottom && followTail) setFollowTail(false);
            }}
          >
            {filteredRecords.length > 0 ? (
              filteredRecords.map((record) => (
                <CommandRecord
                  key={record.id}
                  record={record}
                  streamFilter={streamFilter}
                  preview={record.artifact ? visiblePreviews[record.artifact.id] : undefined}
                  previewError={record.artifact ? visibleErrors[record.artifact.id] : undefined}
                  onOpenArtifact={onOpenArtifact}
                />
              ))
            ) : (
              <div className="signal-console-empty" role="status">
                <TerminalSquare size={21} aria-hidden="true" />
                <strong>
                  {records.length === 0
                    ? detail.run.status === 'running' || detail.run.status === 'queued'
                      ? 'Awaiting persisted command output'
                      : 'No command output was persisted for this run.'
                    : 'No output matches the current filters.'}
                </strong>
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'dossier' && (
        <RunDossier
          detail={detail}
          previews={previews}
          previewErrors={previewErrors}
          onOpenArtifact={onOpenArtifact}
        />
      )}

      {tab === 'events' && <EventLedger events={detail.events} />}
    </section>
  );
}

function ConsoleTabButton({
  current,
  value,
  label,
  onChange,
}: {
  current: ConsoleTab;
  value: ConsoleTab;
  label: string;
  onChange: (value: ConsoleTab) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={current === value}
      onClick={() => onChange(value)}
    >
      {label}
    </button>
  );
}

function CommandRecord({
  record,
  streamFilter,
  preview,
  previewError,
  onOpenArtifact,
}: {
  record: ConsoleRecord;
  streamFilter: StreamFilter;
  preview?: ArtifactPreview;
  previewError?: string;
  onOpenArtifact: (artifact: Artifact, trigger: HTMLElement) => Promise<void>;
}) {
  const streams = record.streams.filter(
    (stream) => streamFilter === 'all' || stream.stream === streamFilter
  );
  const legacyText = streams.length === 0 && preview?.encoding === 'utf8' ? preview.data : null;
  return (
    <article className="signal-command-record" data-status={record.status}>
      <header>
        <span className="signal-command-chevron" aria-hidden="true">
          $
        </span>
        <code title={[record.executable, ...record.args].filter(Boolean).join(' ')}>
          {record.executable
            ? [record.executable, ...record.args].join(' ')
            : 'command unavailable'}
        </code>
        {record.status === 'unknown' ? (
          <span className="status status-unknown">unknown</span>
        ) : (
          <StatusPill status={record.status} />
        )}
      </header>
      <dl className="signal-command-meta">
        <div>
          <dt>Stage</dt>
          <dd>{record.stage.replace('_', ' ')}</dd>
        </div>
        <div>
          <dt>Sequence</dt>
          <dd className="mono">
            {record.startSequence ?? '—'}
            {record.endSequence ? ` → ${record.endSequence}` : ''}
          </dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{record.startedAt ? formatTime(record.startedAt) : 'Unavailable'}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>
            {record.durationMs === null
              ? record.status === 'running'
                ? 'Pending'
                : 'Unavailable'
              : formatDuration(record.durationMs)}
          </dd>
        </div>
        <div>
          <dt>Exit</dt>
          <dd>
            {record.exitCode === null
              ? record.status === 'running'
                ? 'Pending'
                : 'Unavailable'
              : record.exitCode}
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{record.source}</dd>
        </div>
      </dl>
      {record.cwd && (
        <div className="signal-command-cwd">
          <span>cwd</span>
          <code title={record.cwd}>{record.cwd}</code>
        </div>
      )}
      <div className="signal-command-output">
        {streams.length > 0 ? (
          streams.map((stream) => (
            <div className="signal-stream-chunk" key={`${record.id}-${stream.sequence}`}>
              <span className="signal-stream-gutter">
                <code>{stream.sequence}</code>
                <time dateTime={stream.occurredAt}>{formatTime(stream.occurredAt)}</time>
                <b>{stream.stream}</b>
              </span>
              <pre>{stream.text || ' '}</pre>
              {(stream.truncated || stream.omittedBytes > 0) && (
                <small>
                  Output truncated · {stream.omittedBytes} bytes omitted
                  {stream.redactionCount > 0 ? ` · ${stream.redactionCount} redactions` : ''}
                </small>
              )}
            </div>
          ))
        ) : legacyText ? (
          <div className="signal-stream-chunk legacy">
            <span className="signal-stream-gutter">
              <code>{record.endSequence ?? record.startSequence ?? '—'}</code>
              <time dateTime={record.completedAt ?? record.startedAt ?? undefined}>
                {record.completedAt || record.startedAt
                  ? formatTime(record.completedAt ?? record.startedAt!)
                  : '—'}
              </time>
              <b>combined</b>
            </span>
            <pre>{legacyText}</pre>
          </div>
        ) : (
          <p className="signal-command-awaiting">
            {previewError
              ? `Log artifact unavailable: ${previewError}`
              : record.status === 'running'
                ? 'Awaiting persisted command output'
                : record.artifact
                  ? 'Reading checksummed log artifact'
                  : 'No persisted output was linked to this command'}
          </p>
        )}
      </div>
      {record.artifact && (
        <footer>
          <button
            type="button"
            onClick={(event) => void onOpenArtifact(record.artifact!, event.currentTarget)}
          >
            <FileText size={13} aria-hidden="true" />
            {record.artifact.name}
          </button>
          <code title={record.artifact.sha256}>{record.artifact.sha256.slice(0, 12)}</code>
        </footer>
      )}
    </article>
  );
}

function RunDossier({
  detail,
  previews,
  previewErrors,
  onOpenArtifact,
}: {
  detail: RunDetailData;
  previews: Record<string, ArtifactPreview>;
  previewErrors: Record<string, string>;
  onOpenArtifact: (artifact: Artifact, trigger: HTMLElement) => Promise<void>;
}) {
  const patchPreview = detail.patch ? previews[detail.patch.artifactId] : undefined;
  const patchError = detail.patch ? previewErrors[detail.patch.artifactId] : undefined;
  const terminalArtifacts = detail.terminalEvidence
    ? [
        ...new Set([
          ...detail.terminalEvidence.artifactIds,
          ...detail.terminalEvidence.evidenceLinks.map((link) => link.artifactId),
        ]),
      ].flatMap((artifactId) => {
        const artifact = detail.artifacts.find((candidate) => candidate.id === artifactId);
        if (!artifact) return [];
        const relationship =
          detail.terminalEvidence?.evidenceLinks.find((link) => link.artifactId === artifactId)
            ?.relationship ?? 'supports';
        return [{ artifact, relationship }];
      })
    : [];
  return (
    <div className="signal-dossier-scroll">
      {detail.terminalEvidence && (
        <section data-testid="terminal-evidence">
          <small>Terminal evidence</small>
          <h3>{detail.terminalEvidence.outcome.replaceAll('_', ' ')}</h3>
          <p>
            {detail.terminalEvidence.evidenceAvailability === 'ready'
              ? detail.terminalEvidence.summary
              : (detail.terminalEvidence.evidenceUnavailableReason ??
                'Terminal evidence is unavailable.')}
          </p>
          {terminalArtifacts.map(({ artifact, relationship }) => (
            <div className="signal-dossier-command" key={artifact.id}>
              <button
                type="button"
                onClick={(event) => void onOpenArtifact(artifact, event.currentTarget)}
              >
                {relationship}: {artifact.name}
              </button>
              <span title={artifact.sha256}>{artifact.sha256.slice(0, 12)}</span>
            </div>
          ))}
          {detail.manifest && (
            <div className="signal-dossier-command">
              <code>Run manifest</code>
              <span title={detail.manifest.sha256}>{detail.manifest.sha256.slice(0, 12)}</span>
            </div>
          )}
        </section>
      )}
      <section>
        <small>Diagnosis</small>
        <h3>{detail.diagnosis?.summary ?? 'No diagnosis persisted'}</h3>
        <p>{detail.diagnosis?.rootCause ?? 'This run has no diagnosis record.'}</p>
        {detail.diagnosis && <SourceStamp provenance={detail.diagnosis.provenance} />}
      </section>
      <section>
        <small>Patch</small>
        <h3>{detail.patch?.summary ?? 'No patch persisted'}</h3>
        {detail.patch ? (
          <>
            <span className={`risk risk-${detail.patch.risk}`}>{detail.patch.risk} risk</span>
            {patchPreview?.encoding === 'utf8' && <pre>{patchPreview.data}</pre>}
            {patchError && <p>Patch preview unavailable: {patchError}</p>}
          </>
        ) : (
          <p>No bounded diff was required or persisted.</p>
        )}
      </section>
      <section>
        <small>Verification</small>
        <h3>
          {detail.verification
            ? detail.verification.passed
              ? 'Checks passed'
              : 'Checks failed'
            : 'No verification persisted'}
        </h3>
        {detail.verification?.commands.map((command, index) => (
          <div className="signal-dossier-command" key={`${command.artifactId}-${index}`}>
            <code>{[command.executable, ...command.args].join(' ')}</code>
            <span>
              exit {command.exitCode ?? 'unavailable'} · {formatDuration(command.durationMs)}
            </span>
          </div>
        ))}
      </section>
      <section>
        <small>Provider provenance</small>
        <h3>
          {detail.providerCalls.length} model call{detail.providerCalls.length === 1 ? '' : 's'}
        </h3>
        {detail.providerCalls.length > 0 ? (
          detail.providerCalls.map((call) => (
            <div className="signal-provider-row" key={call.id}>
              <span>
                <strong>
                  {call.provider} / {call.model}
                </strong>
                <small>
                  {call.purpose}
                  {call.specialistRole ? ` · ${call.specialistRole}` : ''}
                </small>
              </span>
              <StatusPill status={call.status} />
              <small>
                {call.inputTokens === null || call.outputTokens === null
                  ? 'tokens unavailable'
                  : `${call.inputTokens} in / ${call.outputTokens} out`}
              </small>
            </div>
          ))
        ) : (
          <p>No provider call was persisted for this run.</p>
        )}
      </section>
    </div>
  );
}

function EventLedger({ events }: { events: RunEvent[] }) {
  return (
    <div className="signal-event-ledger" aria-label="Run activity events">
      {events.toReversed().map((event) => (
        <article key={event.id}>
          <span className="signal-event-sequence mono">{event.sequence}</span>
          <span>
            <strong>{event.kind.replaceAll('.', ' ')}</strong>
            <small>{persistedEventSummary(event)}</small>
          </span>
          <span>
            <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
            <small>{event.provenance.provider ?? event.provenance.source}</small>
          </span>
        </article>
      ))}
    </div>
  );
}

function persistedEventSummary(event: RunEvent): string {
  const payload = event.payload as Record<string, unknown>;
  for (const key of ['message', 'summary', 'error']) {
    if (typeof payload[key] === 'string') return payload[key];
  }
  for (const value of Object.values(payload)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (typeof record.summary === 'string') return record.summary;
    if (typeof record.error === 'string') return record.error;
  }
  return `${event.artifactIds.length} artifact link${event.artifactIds.length === 1 ? '' : 's'}`;
}

function serializeRecord(record: ConsoleRecord, previews: Record<string, ArtifactPreview>): string {
  const command = record.executable
    ? `$ ${[record.executable, ...record.args].join(' ')}`
    : '$ command unavailable';
  const artifactPreview = record.artifact ? previews[record.artifact.id] : undefined;
  const output =
    record.streams.length > 0
      ? record.streams
          .map((stream) => `[${stream.sequence} ${stream.stream}] ${stream.text}`)
          .join('\n')
      : artifactPreview?.encoding === 'utf8'
        ? artifactPreview.data
        : '';
  return `${command}\nstatus=${record.status} exit=${record.exitCode ?? 'unavailable'} duration=${
    record.durationMs ?? 'unavailable'
  }\n${output}`.trimEnd();
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${Math.round(durationMs)} ms` : `${(durationMs / 1000).toFixed(1)} s`;
}
