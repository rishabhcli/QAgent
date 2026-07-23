import { useEffect, useState } from 'react';
import type { DoctorReport, Project, Provenance, Run } from '@qagent/contracts';
import {
  ArrowRight,
  CheckCircle2,
  FolderPlus,
  GitBranch,
  Play,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { desktopApi } from '../api.js';
import { EmptyState } from '../components/empty-state.js';
import { SourceStamp } from '../components/source-stamp.js';
import { StatusPill } from '../components/status-pill.js';

export function ProjectsView({
  projects,
  runs,
  provenance,
  selectedProjectId,
  onSelectProject,
  onSelectRun,
  onStartRun,
  onAddProject,
  refresh,
}: {
  projects: Project[];
  runs: Run[];
  provenance: Provenance;
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onSelectRun: (runId: string) => void;
  onStartRun: (projectId: string) => Promise<void>;
  onAddProject: () => void;
  refresh: () => Promise<void>;
}) {
  const project = projects.find((item) => item.id === selectedProjectId) ?? projects[0];
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [checking, setChecking] = useState(false);
  const projectRuns = project ? runs.filter((run) => run.projectId === project.id) : [];

  useEffect(() => setDoctor(null), [project?.id]);

  async function checkReadiness() {
    if (!project) return;
    setChecking(true);
    try {
      setDoctor(await desktopApi.doctor(project.id));
    } finally {
      setChecking(false);
    }
  }

  if (!project) {
    return (
      <EmptyState
        icon={FolderPlus}
        title="No projects yet"
        detail="Choose a repository to establish its local QA configuration."
        action={
          <button className="button primary" onClick={onAddProject}>
            <FolderPlus size={16} /> Add project
          </button>
        }
      />
    );
  }

  return (
    <div className="view-stack">
      <section className="project-heading">
        <div>
          <div className="project-selector-row">
            <select
              value={project.id}
              onChange={(event) => onSelectProject(event.target.value)}
              aria-label="Selected project"
            >
              {projects.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <StatusPill status={project.trusted ? 'ready' : 'blocked'} />
          </div>
          <h2>{project.name}</h2>
          <p className="path-line">{project.path}</p>
        </div>
        <div className="heading-actions">
          <button className="icon-button" title="Refresh local data" onClick={() => void refresh()}>
            <RefreshCw size={17} />
          </button>
          <button className="button quiet" onClick={onAddProject}>
            <FolderPlus size={16} /> Add
          </button>
          <button
            className="button primary"
            disabled={!project.trusted || !project.configPath}
            onClick={() => void onStartRun(project.id)}
          >
            <Play size={16} fill="currentColor" /> Run QA
          </button>
        </div>
      </section>

      <section className="readiness-band">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Project readiness</p>
            <h3>Local execution boundary</h3>
          </div>
          <button
            className="button quiet compact-button"
            onClick={checkReadiness}
            disabled={checking}
          >
            <RefreshCw size={14} className={checking ? 'spin' : ''} /> Check
          </button>
        </div>
        <div className="readiness-grid">
          <ReadinessItem
            icon={ShieldCheck}
            label="Workspace trust"
            value={project.trusted ? 'Trusted' : 'Blocked'}
            ready={project.trusted}
          />
          <ReadinessItem
            icon={GitBranch}
            label="Project config"
            value={project.configPath ? '.qagent.yml' : 'Missing'}
            ready={Boolean(project.configPath)}
          />
          <ReadinessItem
            icon={CheckCircle2}
            label="Last run"
            value={projectRuns[0]?.status.replace('_', ' ') ?? 'Not run'}
            ready={projectRuns[0]?.status === 'succeeded'}
          />
        </div>
        {doctor && (
          <div className="doctor-summary">
            <StatusPill status={doctor.status} />
            <span>
              {doctor.checks.filter((item) => item.status === 'pass').length} of{' '}
              {doctor.checks.length} local checks passed
            </span>
            <SourceStamp provenance={{ source: 'system', capturedAt: doctor.checkedAt }} />
          </div>
        )}
      </section>

      <section className="runs-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Recent activity</p>
            <h3>Durable runs</h3>
          </div>
          <SourceStamp provenance={provenance} />
        </div>
        {projectRuns.length === 0 ? (
          <EmptyState
            icon={Play}
            title="No runs for this project"
            detail="The first run will persist each check, artifact, diagnosis, and verification locally."
          />
        ) : (
          <div className="run-table" role="table">
            <div className="run-table-head" role="row">
              <span>Run</span>
              <span>Stage</span>
              <span>Started</span>
              <span>Status</span>
              <span />
            </div>
            {projectRuns.slice(0, 8).map((run) => (
              <button
                className="run-row"
                role="row"
                key={run.id}
                onClick={() => onSelectRun(run.id)}
              >
                <span className="mono">{run.id.slice(0, 8)}</span>
                <span>{run.stage.replace('_', ' ')}</span>
                <span>{new Date(run.createdAt).toLocaleString()}</span>
                <StatusPill status={run.status} />
                <ArrowRight size={15} />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ReadinessItem({
  icon: Icon,
  label,
  value,
  ready,
}: {
  icon: typeof ShieldCheck;
  label: string;
  value: string;
  ready: boolean;
}) {
  return (
    <div className="readiness-item">
      <span className={ready ? 'readiness-icon ready' : 'readiness-icon'}>
        <Icon size={17} />
      </span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}
