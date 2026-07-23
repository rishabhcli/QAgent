import type { Provenance } from '@qagent/contracts';
import { Database } from 'lucide-react';

export function SourceStamp({ provenance }: { provenance: Provenance }) {
  return (
    <span
      className="source-stamp"
      title={`Captured ${new Date(provenance.capturedAt).toLocaleString()}`}
    >
      <Database size={12} aria-hidden="true" />
      {provenance.provider ?? provenance.source} · {relativeTime(provenance.capturedAt)}
    </span>
  );
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString();
}
