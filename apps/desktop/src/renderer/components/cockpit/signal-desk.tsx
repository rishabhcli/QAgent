import { useEffect, useRef, useState } from 'react';
import type { Artifact, Project } from '@qagent/contracts';
import {
  Ban,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  Play,
  RadioTower,
  ShieldAlert,
  ShieldCheck,
  Split,
} from 'lucide-react';
import { desktopApi } from '../../api.js';
import { runOutcomeTitle, stageAction, stageLabel } from '../../run-observability.js';
import type { ArtifactPreview, RunDetailData } from '../../types.js';
import { StatusPill } from '../status-pill.js';
import { ArtifactViewer } from './artifact-viewer.js';
import { EvidenceMonitor } from './evidence-monitor.js';
import { deriveConsoleRecords } from './model.js';
import { ResizableWorkspace } from './resizable-workspace.js';
import { RunConsole } from './run-console.js';
import { SpecialistBay } from './specialist-bay.js';
import { StageStrip } from './stage-strip.js';

interface SignalDeskProps {
  detail: RunDetailData;
  project: Project | null;
  onCancel: (runId: string) => Promise<void>;
  onStartRun: (projectId: string) => Promise<void>;
}

export function SignalDesk({ detail, project, onCancel, onStartRun }: SignalDeskProps) {
  const [previews, setPreviews] = useState<Record<string, ArtifactPreview>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [openingArtifact, setOpeningArtifact] = useState<string | null>(null);
  const [action, setAction] = useState<'cancel' | 'start' | 'publication' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const artifactReturnFocusRef = useRef<HTMLElement | null>(null);
  const artifactsRef = useRef(detail.artifacts);
  artifactsRef.current = detail.artifacts;
  const previewKey = detail.artifacts
    .filter((artifact) => ['log', 'screenshot', 'report', 'patch'].includes(artifact.kind))
    .map((artifact) => artifact.id)
    .join('|');

  useEffect(() => {
    let current = true;
    const previewable = artifactsRef.current.filter((artifact) =>
      ['log', 'screenshot', 'report', 'patch'].includes(artifact.kind)
    );
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
  }, [detail.run.id, previewKey]);

  useEffect(() => {
    if (!selectedArtifactId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeArtifact();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedArtifactId]);

  const records = deriveConsoleRecords(detail.events, detail.artifacts);
  const active = detail.run.status === 'running' || detail.run.status === 'queued';
  const selectedArtifact =
    detail.artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
  const publicationUrl =
    detail.publication?.url ??
    detail.events.findLast((event) => event.kind === 'publication.created')?.payload.url ??
    null;
  const latestEvent = detail.events.at(-1);
  const isolationEvent = detail.events.findLast((event) => event.kind === 'run.isolation_ready');
  const worktreePath =
    isolationEvent?.kind === 'run.isolation_ready'
      ? isolationEvent.payload.isolation.worktreePath
      : detail.run.worktreePath;

  async function openArtifact(artifact: Artifact, trigger: HTMLElement) {
    artifactReturnFocusRef.current = trigger;
    setSelectedArtifactId(artifact.id);
    if (previews[artifact.id] || previewErrors[artifact.id]) return;
    setOpeningArtifact(artifact.id);
    try {
      const preview = await desktopApi.readArtifact(artifact.id);
      setPreviews((current) => ({ ...current, [artifact.id]: preview }));
    } catch (error) {
      setPreviewErrors((current) => ({
        ...current,
        [artifact.id]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setOpeningArtifact(null);
    }
  }

  function closeArtifact() {
    setSelectedArtifactId(null);
    window.requestAnimationFrame(() => artifactReturnFocusRef.current?.focus());
  }

  async function runAction(type: 'cancel' | 'start' | 'publication', task: () => Promise<void>) {
    setAction(type);
    setActionError(null);
    try {
      await task();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAction(null);
    }
  }

  return (
    <div
      className={`signal-desk${actionError ? ' has-action-error' : ''}`}
      data-testid="signal-desk"
      data-status={detail.run.status}
    >
      <header className="signal-identity-strip">
        <div className="signal-run-title">
          <span className="signal-run-frequency mono">RUN {detail.run.id.slice(0, 8)}</span>
          <div className="run-id-line">
            <RadioTower size={17} aria-hidden="true" />
            <h2>{runOutcomeTitle(detail.run)}</h2>
            <StatusPill status={detail.run.status} />
          </div>
          <p>
            {detail.run.error ??
              detail.run.summary ??
              detail.projection?.currentAction?.summary ??
              stageAction(detail.run.stage)}
          </p>
        </div>

        <dl className="signal-run-identity">
          <div>
            <dt>Repository</dt>
            <dd title={project?.path}>
              <strong>{project?.name ?? 'Unknown project'}</strong>
              <span className="mono">{project?.path ?? 'Path unavailable'}</span>
            </dd>
          </div>
          <div>
            <dt>Trust state</dt>
            <dd>
              <span
                className={project?.trusted ? 'signal-trust trusted' : 'signal-trust untrusted'}
              >
                {project?.trusted ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
                {project?.trusted ? 'Currently trusted' : 'Not trusted'}
              </span>
              <span>Current project record</span>
            </dd>
          </div>
          <div>
            <dt>Isolated worktree</dt>
            <dd className="run-branch-line">
              <strong>
                <GitBranch size={13} aria-hidden="true" />
                {detail.run.branch ?? 'Not allocated'}
              </strong>
              <span className="mono" title={worktreePath ?? undefined}>
                {worktreePath ?? 'Persisted path unavailable'}
              </span>
            </dd>
          </div>
          <div>
            <dt>Active stage</dt>
            <dd>
              <strong>
                <Split size={13} aria-hidden="true" />
                {stageLabel(detail.run.stage)}
              </strong>
              <span>{latestEvent ? `Sequence ${latestEvent.sequence}` : 'No event persisted'}</span>
            </dd>
          </div>
        </dl>

        <div className="signal-run-controls">
          {publicationUrl && (
            <button
              type="button"
              className="signal-control-button"
              disabled={action !== null}
              onClick={() =>
                void runAction('publication', () => desktopApi.openExternal(publicationUrl))
              }
            >
              {action === 'publication' ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <ExternalLink size={14} />
              )}
              Open PR
            </button>
          )}
          {active ? (
            <button
              type="button"
              className="signal-control-button danger"
              disabled={action !== null}
              onClick={() => void runAction('cancel', () => onCancel(detail.run.id))}
            >
              {action === 'cancel' ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Ban size={14} />
              )}
              {action === 'cancel' ? 'Cancelling' : 'Cancel'}
            </button>
          ) : (
            <button
              type="button"
              className="signal-control-button run"
              disabled={!project?.trusted || action !== null}
              title={
                project?.trusted
                  ? 'Start another isolated run'
                  : 'Trust this project before running'
              }
              onClick={() => project && void runAction('start', () => onStartRun(project.id))}
            >
              {action === 'start' ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Play size={14} />
              )}
              {action === 'start' ? 'Starting' : 'Run again'}
            </button>
          )}
        </div>
      </header>

      {actionError && (
        <div className="signal-action-error" role="alert">
          {actionError}
        </div>
      )}

      <StageStrip run={detail.run} events={detail.events} />

      <ResizableWorkspace
        consolePane={
          <RunConsole
            key={detail.run.id}
            detail={detail}
            records={records}
            previews={previews}
            previewErrors={previewErrors}
            onOpenArtifact={openArtifact}
          />
        }
        evidencePane={
          <EvidenceMonitor
            key={detail.run.id}
            events={detail.events}
            artifacts={detail.artifacts}
            previews={previews}
            previewErrors={previewErrors}
            onOpenArtifact={openArtifact}
          />
        }
      />

      <SpecialistBay events={detail.events} />

      {selectedArtifact && (
        <ArtifactViewer
          artifact={selectedArtifact}
          preview={previews[selectedArtifact.id]}
          error={previewErrors[selectedArtifact.id]}
          loading={openingArtifact === selectedArtifact.id}
          onClose={closeArtifact}
        />
      )}
    </div>
  );
}
