import type { Project, Provenance, Run } from '@qagent/contracts';
import { History, RadioTower, ShieldAlert, ShieldCheck } from 'lucide-react';
import { SourceStamp } from '../source-stamp.js';
import { StatusPill } from '../status-pill.js';

interface InstrumentDockProps {
  runs: Run[];
  projects: Project[];
  provenance: Provenance;
  selectedRun: Run;
  onSelectRun: (runId: string) => void;
}

export function InstrumentDock({
  runs,
  projects,
  provenance,
  selectedRun,
  onSelectRun,
}: InstrumentDockProps) {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const project = projects.find((candidate) => candidate.id === selectedRun.projectId) ?? null;

  return (
    <aside className="signal-instrument-dock" data-testid="instrument-dock">
      <header className="signal-dock-title">
        <span className="signal-dock-mark" aria-hidden="true">
          <RadioTower size={17} />
        </span>
        <span>
          <small>QAgent</small>
          <strong>Signal Desk</strong>
        </span>
      </header>

      <section className="signal-dock-repository" aria-label="Selected repository">
        <span className="signal-dock-kicker">Repository</span>
        <strong title={project?.path}>{project?.name ?? 'Unknown project'}</strong>
        <span className={project?.trusted ? 'signal-trust trusted' : 'signal-trust untrusted'}>
          {project?.trusted ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
          {project?.trusted ? 'Current trust: trusted' : 'Current trust: not trusted'}
        </span>
      </section>

      <div className="signal-dock-history-heading">
        <span>
          <History size={13} aria-hidden="true" />
          Run ledger
        </span>
        <small>{runs.length}</small>
      </div>

      <div className="signal-run-list run-list" aria-label="Run ledger">
        {runs.map((run) => (
          <button
            key={run.id}
            type="button"
            className={run.id === selectedRun.id ? 'signal-run-item selected' : 'signal-run-item'}
            data-status={run.status}
            onClick={() => onSelectRun(run.id)}
            aria-current={run.id === selectedRun.id ? 'true' : undefined}
            title={`${projectNames.get(run.projectId) ?? 'Project'} · ${run.status}`}
          >
            <span className="signal-run-tally" aria-hidden="true" />
            <span className="signal-run-copy">
              <strong>{projectNames.get(run.projectId) ?? 'Project'}</strong>
              <small className="mono">
                {run.id.slice(0, 8)} · {new Date(run.createdAt).toLocaleTimeString()}
              </small>
            </span>
            <StatusPill status={run.status} />
          </button>
        ))}
      </div>

      <footer className="signal-dock-source">
        <SourceStamp provenance={provenance} />
      </footer>
    </aside>
  );
}
