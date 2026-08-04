import { useEffect, useRef } from 'react';
import type { Artifact } from '@qagent/contracts';
import { LoaderCircle, X } from 'lucide-react';
import type { ArtifactPreview } from '../../types.js';
import { SourceStamp } from '../source-stamp.js';

export function ArtifactViewer({
  artifact,
  preview,
  error,
  loading,
  onClose,
}: {
  artifact: Artifact;
  preview?: ArtifactPreview;
  error?: string;
  loading: boolean;
  onClose: () => void;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    const root = backdrop?.parentElement;
    if (!backdrop || !dialog || !root) return;
    const siblings = Array.from(root.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop
    );
    const priorInert = siblings.map((element) => ({ element, inert: element.inert }));
    const previousOverflow = root.style.overflow;
    siblings.forEach((element) => {
      element.inert = true;
    });
    root.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      root.style.overflow = previousOverflow;
      priorInert.forEach(({ element, inert }) => {
        element.inert = inert;
      });
    };
  }, []);

  return (
    <div ref={backdropRef} className="artifact-viewer-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="artifact-viewer signal-artifact-viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="artifact-viewer-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">Checksummed artifact</p>
            <h3 id="artifact-viewer-title">{artifact.name}</h3>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close artifact"
            title="Close artifact"
            autoFocus
          >
            <X size={17} />
          </button>
        </header>
        <div className="artifact-viewer-meta">
          <SourceStamp provenance={artifact.provenance} />
          <code>{artifact.sha256}</code>
        </div>
        <div className="artifact-viewer-body">
          {loading ? (
            <div className="artifact-viewer-loading" role="status">
              <LoaderCircle className="spin" size={22} /> Reading local artifact
            </div>
          ) : error ? (
            <div className="inline-error" role="alert">
              Preview unavailable: {error}
            </div>
          ) : preview?.encoding === 'base64' ? (
            <img src={`data:${preview.mimeType};base64,${preview.data}`} alt={artifact.name} />
          ) : preview?.encoding === 'utf8' ? (
            <pre tabIndex={0}>{preview.data}</pre>
          ) : (
            <p className="unavailable-value">No preview was returned for this artifact.</p>
          )}
        </div>
      </section>
    </div>
  );
}
