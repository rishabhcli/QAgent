import { useEffect, useState } from 'react';
import type { Project, Provenance, Run } from '@qagent/contracts';
import { LoaderCircle, PlayCircle, RadioTower } from 'lucide-react';
import { desktopApi } from '../api.js';
import { InstrumentDock } from '../components/cockpit/instrument-dock.js';
import { SignalDesk } from '../components/cockpit/signal-desk.js';
import { EmptyState } from '../components/empty-state.js';
import type { RunDetailData } from '../types.js';
import '../cockpit.css';

interface RunsViewProps {
  runs: Run[];
  projects: Project[];
  provenance: Provenance;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  onCancel: (runId: string) => Promise<void>;
  onStartRun: (projectId: string) => Promise<void>;
}

export function RunsView({
  runs,
  projects,
  provenance,
  selectedRunId,
  onSelectRun,
  onCancel,
  onStartRun,
}: RunsViewProps) {
  const selected = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;
  const [detail, setDetail] = useState<RunDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedId = selected?.id;
  const selectedStatus = selected?.status;
  const visibleDetail = detail?.run.id === selectedId ? detail : null;

  useEffect(() => {
    if (!selectedId) return;
    let current = true;
    let loading = false;
    let queued = false;
    const load = async () => {
      if (loading) {
        queued = true;
        return;
      }
      loading = true;
      do {
        queued = false;
        try {
          const value = await desktopApi.runDetail(selectedId);
          if (current) {
            setDetail(value);
            setError(null);
          }
        } catch (caught) {
          if (current) setError(caught instanceof Error ? caught.message : String(caught));
        }
      } while (current && queued);
      loading = false;
    };
    void load();
    const timer =
      selectedStatus === 'running' || selectedStatus === 'queued'
        ? setInterval(() => void load(), 1200)
        : null;
    return () => {
      current = false;
      if (timer) clearInterval(timer);
    };
  }, [selectedId, selectedStatus]);

  if (!selected) {
    return (
      <EmptyState
        icon={PlayCircle}
        title="No runs recorded"
        detail="Start from a configured project to create the first durable run."
      />
    );
  }

  const project = projects.find((candidate) => candidate.id === selected.projectId) ?? null;

  return (
    <div className="signal-desk-layout">
      <InstrumentDock
        runs={runs}
        projects={projects}
        provenance={provenance}
        selectedRun={selected}
        onSelectRun={onSelectRun}
      />
      <div className="signal-desk-main">
        {error ? (
          <div className="signal-desk-load-state error" role="alert">
            <RadioTower size={24} aria-hidden="true" />
            <strong>Run evidence unavailable</strong>
            <span>{error}</span>
          </div>
        ) : visibleDetail ? (
          <SignalDesk
            detail={visibleDetail}
            project={project}
            onCancel={onCancel}
            onStartRun={onStartRun}
          />
        ) : (
          <div className="signal-desk-load-state" role="status">
            <LoaderCircle className="spin" size={24} aria-hidden="true" />
            <strong>Reading durable run state</strong>
            <span>Waiting for the local event ledger and artifacts</span>
          </div>
        )}
      </div>
    </div>
  );
}
