import { useEffect, useMemo, useState } from 'react';
import type { Artifact, RunEvent } from '@qagent/contracts';
import {
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Expand,
  Focus,
  ImageOff,
  RefreshCw,
  ScanLine,
} from 'lucide-react';
import type { ArtifactPreview } from '../../types.js';
import { deriveBrowserCheckpoints } from './model.js';

interface EvidenceMonitorProps {
  events: RunEvent[];
  artifacts: Artifact[];
  previews: Record<string, ArtifactPreview>;
  previewErrors: Record<string, string>;
  onOpenArtifact: (artifact: Artifact, trigger: HTMLElement) => Promise<void>;
}

interface EvidenceCheckpoint {
  id: string;
  sequence: number;
  capturedAt: string | null;
  flow: string;
  url: string | null;
  title: string | null;
  provider: string | null;
  screenshot: Artifact | null;
  report: Artifact | null;
}

export function EvidenceMonitor({
  events,
  artifacts,
  previews,
  previewErrors,
  onOpenArtifact,
}: EvidenceMonitorProps) {
  const checkpoints = useMemo(
    () => collectCheckpoints(events, artifacts, previews),
    [events, artifacts, previews]
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scanlines, setScanlines] = useState(true);
  const [vignette, setVignette] = useState(true);
  const [refreshEffect, setRefreshEffect] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [readyImageId, setReadyImageId] = useState<string | null>(null);
  const [failedImageId, setFailedImageId] = useState<string | null>(null);
  const selected =
    checkpoints.find((checkpoint) => checkpoint.id === selectedId) ?? checkpoints.at(-1) ?? null;
  const selectedIndex = selected
    ? checkpoints.findIndex((checkpoint) => checkpoint.id === selected.id)
    : -1;

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      setReducedMotion(query.matches);
      if (query.matches) {
        setScanlines(false);
        setVignette(false);
        setRefreshEffect(false);
      }
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const preview = selected?.screenshot ? previews[selected.screenshot.id] : undefined;
  const previewError = selected?.screenshot ? previewErrors[selected.screenshot.id] : undefined;
  const imageReady = selected?.id === readyImageId;
  const imageFailed = selected?.id === failedImageId;
  const unsupportedPreview = Boolean(preview && preview.encoding !== 'base64');
  const imageSource =
    selected?.screenshot && preview?.encoding === 'base64'
      ? `data:${selected.screenshot.mimeType};base64,${preview.data}`
      : null;
  const availability = imageReady
    ? 'Ready'
    : previewError || imageFailed || unsupportedPreview || (selected && !selected.screenshot)
      ? 'Unavailable'
      : selected
        ? 'Loading'
        : 'Unavailable';

  return (
    <section className="signal-evidence-monitor" data-testid="evidence-monitor">
      <header className="signal-panel-heading">
        <span>
          <small>Checksummed browser checkpoint</small>
          <strong>Evidence monitor</strong>
        </span>
        <div className="signal-monitor-effects" aria-label="CRT monitor effects">
          <button
            type="button"
            aria-label="Toggle scanlines"
            aria-pressed={scanlines && !reducedMotion}
            title={reducedMotion ? 'Scanlines disabled by reduced motion' : 'Toggle scanlines'}
            disabled={reducedMotion}
            onClick={() => setScanlines((value) => !value)}
          >
            <ScanLine size={14} />
          </button>
          <button
            type="button"
            aria-label="Toggle vignette"
            aria-pressed={vignette && !reducedMotion}
            title={reducedMotion ? 'Vignette disabled by reduced motion' : 'Toggle vignette'}
            disabled={reducedMotion}
            onClick={() => setVignette((value) => !value)}
          >
            <Focus size={14} />
          </button>
          <button
            type="button"
            aria-label="Toggle refresh effect"
            aria-pressed={refreshEffect && !reducedMotion}
            title={
              reducedMotion ? 'Refresh effect disabled by reduced motion' : 'Toggle refresh effect'
            }
            disabled={reducedMotion}
            onClick={() => setRefreshEffect((value) => !value)}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      <div
        className="signal-crt"
        data-scanlines={scanlines && !reducedMotion ? 'on' : 'off'}
        data-vignette={vignette && !reducedMotion ? 'on' : 'off'}
        data-refresh={refreshEffect && !reducedMotion ? 'on' : 'off'}
        data-availability={availability.toLowerCase()}
      >
        <div className="signal-crt-tally">
          <span>
            <CircleDot size={12} aria-hidden="true" />
            {availability}
          </span>
          <code>{selected ? `CHECKPOINT ${selected.sequence}` : 'NO CHECKPOINT'}</code>
        </div>

        <div className="signal-crt-screen screenshot-grid">
          {selected && selected.screenshot && imageSource && !imageFailed ? (
            <>
              {!imageReady && (
                <div className="signal-monitor-message">Reading screenshot artifact</div>
              )}
              <button
                type="button"
                className="signal-monitor-image screenshot-open"
                aria-label={`Inspect ${selected.screenshot.name}`}
                onClick={(event) => void onOpenArtifact(selected.screenshot!, event.currentTarget)}
              >
                <img
                  src={imageSource}
                  alt={`${selected.flow} browser checkpoint`}
                  onLoad={(event) => {
                    if (event.currentTarget.naturalWidth > 0) setReadyImageId(selected.id);
                    else setFailedImageId(selected.id);
                  }}
                  onError={() => setFailedImageId(selected.id)}
                />
              </button>
              {imageReady && (
                <span className="signal-monitor-expand" aria-hidden="true">
                  <Expand size={14} />
                </span>
              )}
            </>
          ) : (
            <div className="signal-monitor-message" role="status">
              <ImageOff size={22} aria-hidden="true" />
              <strong>
                {!selected
                  ? 'No browser screenshot checkpoint was persisted.'
                  : previewError
                    ? 'Screenshot artifact is unavailable.'
                    : imageFailed
                      ? 'Screenshot artifact could not be decoded.'
                      : unsupportedPreview
                        ? 'Screenshot preview has an unsupported encoding.'
                        : !selected.screenshot
                          ? 'Checkpoint metadata has no linked screenshot artifact.'
                          : 'Reading screenshot artifact'}
              </strong>
              {previewError && <small>{previewError}</small>}
            </div>
          )}
        </div>

        <div className="signal-checkpoint-pager">
          <button
            type="button"
            aria-label="Previous browser checkpoint"
            title="Previous checkpoint"
            disabled={selectedIndex <= 0}
            onClick={() => setSelectedId(checkpoints[selectedIndex - 1]?.id ?? null)}
          >
            <ChevronLeft size={15} />
          </button>
          <span>{selected ? `${selectedIndex + 1} / ${checkpoints.length}` : '0 / 0'}</span>
          <button
            type="button"
            aria-label="Next browser checkpoint"
            title="Next checkpoint"
            disabled={selectedIndex < 0 || selectedIndex >= checkpoints.length - 1}
            onClick={() => setSelectedId(checkpoints[selectedIndex + 1]?.id ?? null)}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>

      <dl className="signal-evidence-meta">
        <div>
          <dt>Title</dt>
          <dd title={selected?.title ?? undefined}>{selected?.title ?? 'Unavailable'}</dd>
        </div>
        <div>
          <dt>URL</dt>
          <dd className="mono" title={selected?.url ?? undefined}>
            {selected?.url ?? 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt>Captured</dt>
          <dd>
            {selected?.capturedAt ? new Date(selected.capturedAt).toLocaleString() : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{selected?.provider ?? 'Unavailable'}</dd>
        </div>
        <div>
          <dt>Checksum</dt>
          <dd className="mono" title={selected?.screenshot?.sha256}>
            {selected?.screenshot?.sha256.slice(0, 16) ?? 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt>Availability</dt>
          <dd>{availability}</dd>
        </div>
      </dl>
    </section>
  );
}

function collectCheckpoints(
  events: RunEvent[],
  artifacts: Artifact[],
  previews: Record<string, ArtifactPreview>
): EvidenceCheckpoint[] {
  return deriveBrowserCheckpoints(events, artifacts).map((checkpoint) => {
    const reportData =
      checkpoint.legacy && checkpoint.report
        ? parseLegacyReport(previews[checkpoint.report.id])
        : null;
    return {
      id: checkpoint.id,
      sequence: checkpoint.sequence,
      capturedAt: checkpoint.capturedAt,
      flow: checkpoint.flow,
      url: checkpoint.url ?? reportData?.url ?? null,
      title: checkpoint.title ?? reportData?.title ?? null,
      provider: checkpoint.provider,
      screenshot: checkpoint.screenshot,
      report: checkpoint.report,
    };
  });
}

function parseLegacyReport(
  preview: ArtifactPreview | undefined
): { url: string; title: string } | null {
  if (preview?.encoding !== 'utf8') return null;
  try {
    const value = JSON.parse(preview.data) as unknown;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    return typeof record.url === 'string' && typeof record.title === 'string'
      ? { url: record.url, title: record.title }
      : null;
  } catch {
    return null;
  }
}
