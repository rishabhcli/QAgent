import { useEffect, useState } from 'react';
import type {
  Artifact,
  Project,
  Provenance,
  ProviderCall,
  Run,
  RunEvent,
  Verification,
} from '@qagent/contracts';
import {
  Ban,
  CheckCircle2,
  CircleX,
  Cpu,
  ExternalLink,
  FileCode2,
  Image,
  PlayCircle,
  ScrollText,
} from 'lucide-react';
import { desktopApi } from '../api.js';
import { EmptyState } from '../components/empty-state.js';
import { SourceStamp } from '../components/source-stamp.js';
import { StatusPill } from '../components/status-pill.js';
import type { ArtifactPreview, RunDetailData } from '../types.js';

interface RunsViewProps {
  runs: Run[];
  projects: Project[];
  provenance: Provenance;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  onCancel: (runId: string) => Promise<void>;
}

export function RunsView({
  runs,
  projects,
  provenance,
  selectedRunId,
  onSelectRun,
  onCancel,
}: RunsViewProps) {
  const selected = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;
  const [detail, setDetail] = useState<RunDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectName = new Map(projects.map((project) => [project.id, project.name]));

  useEffect(() => {
    if (!selected) return;
    let current = true;
    const load = async () => {
      try {
        const value = await desktopApi.runDetail(selected.id);
        if (current) {
          setDetail(value);
          setError(null);
        }
      } catch (caught) {
        if (current) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void load();
    const timer =
      selected.status === 'running' || selected.status === 'queued'
        ? setInterval(() => void load(), 1200)
        : null;
    return () => {
      current = false;
      if (timer) clearInterval(timer);
    };
  }, [selected]);

  if (!selected) {
    return (
      <EmptyState
        icon={PlayCircle}
        title="No runs recorded"
        detail="Start from a configured project to create the first durable run."
      />
    );
  }

  return (
    <div className="runs-layout">
      <aside className="run-list-pane">
        <div className="run-list-heading">
          <div>
            <p className="eyebrow">History</p>
            <h2>Runs</h2>
          </div>
          <SourceStamp provenance={provenance} />
        </div>
        <div className="run-list">
          {runs.map((run) => (
            <button
              key={run.id}
              className={run.id === selected.id ? 'run-list-item selected' : 'run-list-item'}
              onClick={() => onSelectRun(run.id)}
            >
              <div>
                <strong>{projectName.get(run.projectId) ?? 'Project'}</strong>
                <span className="mono">{run.id.slice(0, 8)}</span>
              </div>
              <p>
                {run.stage.replace('_', ' ')} · {new Date(run.createdAt).toLocaleTimeString()}
              </p>
              <StatusPill status={run.status} />
            </button>
          ))}
        </div>
      </aside>
      <section className="run-detail-pane">
        {error ? (
          <div className="inline-error">{error}</div>
        ) : detail ? (
          <RunDetail detail={detail} onCancel={onCancel} />
        ) : (
          <div className="loading-block">Loading run evidence...</div>
        )}
      </section>
    </div>
  );
}

function RunDetail({
  detail,
  onCancel,
}: {
  detail: RunDetailData;
  onCancel: (runId: string) => Promise<void>;
}) {
  const [previews, setPreviews] = useState<Record<string, ArtifactPreview>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let current = true;
    const previewable = detail.artifacts
      .filter((artifact) => artifact.kind === 'patch' || artifact.kind === 'screenshot')
      .slice(0, 6);
    void Promise.all(
      previewable.map(async (artifact) => {
        try {
          return { id: artifact.id, preview: await desktopApi.readArtifact(artifact.id) };
        } catch (error) {
          return {
            id: artifact.id,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    ).then((entries) => {
      if (!current) return;
      setPreviews(
        Object.fromEntries(
          entries.flatMap((entry) => (entry.preview ? [[entry.id, entry.preview]] : []))
        )
      );
      setPreviewErrors(
        Object.fromEntries(
          entries.flatMap((entry) => (entry.error ? [[entry.id, entry.error]] : []))
        )
      );
    });
    return () => {
      current = false;
    };
  }, [detail.run.id, detail.artifacts]);

  const publication = detail.events.findLast((event) => event.kind === 'publication.created');
  const merge = detail.events.findLast(
    (event) => event.stage === 'merge' && event.kind === 'stage.completed'
  );
  const patchProvenance = detail.patch
    ? detail.artifacts.find((artifact) => artifact.id === detail.patch?.artifactId)?.provenance
    : undefined;

  return (
    <div className="run-detail">
      <header className="run-detail-header">
        <div>
          <div className="run-id-line">
            <span className="mono">RUN {detail.run.id.slice(0, 8)}</span>
            <StatusPill status={detail.run.status} />
          </div>
          <h2>{detail.run.summary ?? stageTitle(detail.run.stage)}</h2>
          <p>
            {new Date(detail.run.createdAt).toLocaleString()} ·{' '}
            {detail.run.branch ?? 'Branch not available yet'}
          </p>
        </div>
        <div className="heading-actions">
          {publication?.kind === 'publication.created' && (
            <button
              className="button quiet"
              onClick={() => void desktopApi.openExternal(publication.payload.url)}
            >
              Open PR <ExternalLink size={15} />
            </button>
          )}
          {(detail.run.status === 'running' || detail.run.status === 'queued') && (
            <button className="button danger" onClick={() => void onCancel(detail.run.id)}>
              <Ban size={15} /> Cancel
            </button>
          )}
        </div>
      </header>

      <StageTimeline events={detail.events} current={detail.run.stage} />

      <div className="run-columns">
        <div className="run-primary">
          <EvidenceSection
            artifacts={detail.artifacts}
            previews={previews}
            previewErrors={previewErrors}
          />

          {detail.diagnosis && (
            <section className="detail-section">
              <p className="eyebrow">Diagnosis</p>
              <h3>{detail.diagnosis.summary}</h3>
              <p>{detail.diagnosis.rootCause}</p>
              <div className="confidence">
                <span style={{ width: `${Math.round(detail.diagnosis.confidence * 100)}%` }} />
                <small>{Math.round(detail.diagnosis.confidence * 100)}% provider confidence</small>
              </div>
              <SourceStamp provenance={detail.diagnosis.provenance} />
            </section>
          )}

          {detail.patch && (
            <section className="detail-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Patch</p>
                  <h3>{detail.patch.summary}</h3>
                </div>
                <span className={`risk risk-${detail.patch.risk}`}>{detail.patch.risk} risk</span>
              </div>
              <div className="file-chips">
                {detail.patch.files.length > 0 ? (
                  detail.patch.files.map((file) => <code key={file}>{file}</code>)
                ) : (
                  <span className="unavailable-value">No validated files</span>
                )}
              </div>
              {previews[detail.patch.artifactId]?.encoding === 'utf8' && (
                <pre className="diff-preview" tabIndex={0}>
                  {previews[detail.patch.artifactId]?.data}
                </pre>
              )}
              {previewErrors[detail.patch.artifactId] && (
                <p className="unavailable-value">
                  Patch preview unavailable: {previewErrors[detail.patch.artifactId]}
                </p>
              )}
              {patchProvenance && <SourceStamp provenance={patchProvenance} />}
            </section>
          )}

          <VerificationSection verification={detail.verification} />
          <ProviderSection calls={detail.providerCalls} />

          {(publication || merge) && (
            <section className="detail-section">
              <p className="eyebrow">Publication</p>
              <h3>{merge ? eventMessage(merge) : 'Pull request opened'}</h3>
              <p>
                {publication?.kind === 'publication.created'
                  ? `GitHub PR #${publication.payload.number}`
                  : 'No pull request URL was recorded.'}
              </p>
              <SourceStamp
                provenance={{
                  source: 'github',
                  provider: 'GitHub',
                  capturedAt: (merge ?? publication)?.occurredAt ?? detail.run.updatedAt,
                }}
              />
            </section>
          )}
        </div>

        <aside className="activity-pane">
          <p className="eyebrow">Activity</p>
          <div className="event-list" tabIndex={0} aria-label="Run activity events">
            {detail.events.map((event) => (
              <EventRow event={event} key={event.id} />
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function StageTimeline({ events, current }: { events: RunEvent[]; current: Run['stage'] }) {
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
  const completed = new Set(
    events.filter((event) => event.kind === 'stage.completed').map((event) => event.stage)
  );
  return (
    <div className="stage-timeline" aria-label="Run stages">
      {stages.map((stage) => (
        <div
          key={stage}
          className={
            completed.has(stage) ? 'stage done' : stage === current ? 'stage current' : 'stage'
          }
          title={stage.replace('_', ' ')}
        >
          <span />
          <small>
            {stage === 'wait_checks' ? 'checks' : stage === 'postverify' ? 'recheck' : stage}
          </small>
        </div>
      ))}
    </div>
  );
}

function EvidenceSection({
  artifacts,
  previews,
  previewErrors,
}: {
  artifacts: Artifact[];
  previews: Record<string, ArtifactPreview>;
  previewErrors: Record<string, string>;
}) {
  const screenshots = artifacts.filter((artifact) => artifact.kind === 'screenshot');
  return (
    <section className="detail-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Evidence</p>
          <h3>{artifacts.length} checksummed artifacts</h3>
        </div>
      </div>
      {screenshots.length > 0 && (
        <div className="screenshot-grid">
          {screenshots.map((artifact) => (
            <figure key={artifact.id}>
              {previews[artifact.id]?.encoding === 'base64' ? (
                <img
                  src={`data:${artifact.mimeType};base64,${previews[artifact.id]?.data}`}
                  alt={artifact.name}
                />
              ) : (
                <div className="preview-placeholder" role="status">
                  <Image size={22} />
                  <small>
                    {previewErrors[artifact.id]
                      ? `Preview unavailable: ${previewErrors[artifact.id]}`
                      : 'Loading preview'}
                  </small>
                </div>
              )}
              <figcaption>
                <span>
                  {artifact.name}
                  <small>
                    {artifact.provenance.provider ?? artifact.provenance.source} ·{' '}
                    {new Date(artifact.createdAt).toLocaleTimeString()}
                  </small>
                </span>
                <code>{artifact.sha256.slice(0, 12)}</code>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      <div className="artifact-list">
        {artifacts
          .filter((artifact) => artifact.kind !== 'screenshot')
          .map((artifact) => (
            <div key={artifact.id}>
              <span>
                {artifact.kind === 'log' ? <ScrollText size={15} /> : <FileCode2 size={15} />}
                <span>
                  {artifact.name}
                  <small>
                    {artifact.provenance.provider ?? artifact.provenance.source} ·{' '}
                    {new Date(artifact.createdAt).toLocaleTimeString()}
                  </small>
                </span>
              </span>
              <code>{artifact.sha256.slice(0, 12)}</code>
            </div>
          ))}
      </div>
    </section>
  );
}

function VerificationSection({ verification }: { verification: Verification | null }) {
  return (
    <section className="detail-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Verification</p>
          <h3>
            {verification
              ? verification.passed
                ? 'Checks passed'
                : 'Checks failed'
              : 'Not available'}
          </h3>
        </div>
        {verification &&
          (verification.passed ? (
            <CheckCircle2 className="verification-pass" size={21} />
          ) : (
            <CircleX className="verification-fail" size={21} />
          ))}
      </div>
      {verification ? (
        <>
          <div className="verification-list">
            {verification.commands.map((command, index) => (
              <div key={`${command.artifactId}-${index}`}>
                <code>
                  {command.executable} {command.args.join(' ')}
                </code>
                <span
                  className={command.exitCode === 0 ? 'verification-pass' : 'verification-fail'}
                >
                  {command.exitCode === null ? 'exit unavailable' : `exit ${command.exitCode}`} ·{' '}
                  {formatDuration(command.durationMs)}
                </span>
              </div>
            ))}
          </div>
          <SourceStamp
            provenance={{ source: 'local', provider: 'QAgent', capturedAt: verification.createdAt }}
          />
        </>
      ) : (
        <p className="unavailable-value">No verification record has been persisted for this run.</p>
      )}
    </section>
  );
}

function ProviderSection({ calls }: { calls: ProviderCall[] }) {
  return (
    <section className="detail-section">
      <p className="eyebrow">Provider provenance</p>
      <h3>{calls.length > 0 ? `${calls.length} model calls` : 'No model calls used'}</h3>
      {calls.length > 0 ? (
        <div className="provider-call-list">
          {calls.map((call) => (
            <div key={call.id}>
              <Cpu size={16} />
              <span>
                <strong>
                  {call.provider} / {call.model}
                </strong>
                <small>
                  {call.purpose} · {new Date(call.createdAt).toLocaleString()}
                </small>
              </span>
              <span className="provider-metrics">
                <StatusPill status={call.status} />
                <small>
                  {call.inputTokens === null || call.outputTokens === null
                    ? 'tokens unavailable'
                    : `${call.inputTokens} in / ${call.outputTokens} out`}
                </small>
                <small>
                  {call.costUsd === null ? 'cost unavailable' : `$${call.costUsd.toFixed(6)}`}
                </small>
              </span>
              {call.error && <p>{call.error}</p>}
            </div>
          ))}
        </div>
      ) : (
        <p className="unavailable-value">
          Grounded checks completed without calling a configured model provider.
        </p>
      )}
    </section>
  );
}

function EventRow({ event }: { event: RunEvent }) {
  return (
    <div className="event-row">
      <span className={`event-dot event-${event.kind.split('.')[0]}`} />
      <div>
        <strong>{eventMessage(event)}</strong>
        <p>
          {event.stage.replace('_', ' ')} · {event.provenance.provider ?? event.provenance.source}
        </p>
      </div>
      <time>
        {new Date(event.occurredAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}
      </time>
    </div>
  );
}

function eventMessage(event: RunEvent): string {
  return 'message' in event.payload ? event.payload.message : event.kind.replace('.', ' ');
}

function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${Math.round(durationMs)} ms` : `${(durationMs / 1000).toFixed(1)} s`;
}

function stageTitle(stage: Run['stage']): string {
  return stage === 'complete' ? 'Run complete' : `${stage.replace('_', ' ')} in progress`;
}
