import { useEffect, useRef, useState } from 'react';
import type { CorrectiveAction, DoctorReport, Project, Provenance, Run } from '@qagent/contracts';
import {
  ArrowRight,
  CheckCircle2,
  FolderPlus,
  GitBranch,
  LoaderCircle,
  Play,
  RefreshCw,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { desktopApi } from '../api.js';
import { DoctorChecks } from '../components/doctor-checks.js';
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
  onConfigureProject,
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
  onConfigureProject: (project: Project) => void;
  refresh: () => Promise<void>;
}) {
  const project = projects.find((item) => item.id === selectedProjectId) ?? projects[0];
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const currentProjectId = useRef(project?.id);
  const projectRuns = project ? runs.filter((run) => run.projectId === project.id) : [];
  const activeProjectRun = projectRuns.find(
    (run) => run.status === 'running' || run.status === 'queued'
  );
  const latestRun = projectRuns[0];

  useEffect(() => {
    currentProjectId.current = project?.id;
    setDoctor(null);
    setCheckError(null);
    setChecking(false);
  }, [project?.id]);

  async function checkReadiness() {
    if (!project) return;
    const requestedProjectId = project.id;
    setChecking(true);
    setCheckError(null);
    try {
      const report = await desktopApi.doctor(requestedProjectId);
      if (currentProjectId.current === requestedProjectId) setDoctor(report);
    } catch (error) {
      if (currentProjectId.current === requestedProjectId) {
        setCheckError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (currentProjectId.current === requestedProjectId) setChecking(false);
    }
  }

  async function startProjectRun() {
    if (!project || starting) return;
    setStarting(true);
    try {
      await onStartRun(project.id);
    } finally {
      setStarting(false);
    }
  }

  async function applyDoctorAction(action: CorrectiveAction) {
    if (!project || action.type === 'command' || action.type === 'run') return;
    setChecking(true);
    setCheckError(null);
    try {
      if (action.type === 'external') {
        await desktopApi.openExternal(action.url);
        return;
      }
      if (
        action.action === 'configure_project' ||
        action.action === 'configure_provider' ||
        action.action === 'review_policy'
      ) {
        onConfigureProject(project);
        return;
      }
      if (action.action === 'install_browser') await desktopApi.installBrowser();
      if (action.action === 'trust_project') await desktopApi.trustProject(project.id, true);
      if (
        action.action === 'install_browser' ||
        action.action === 'trust_project' ||
        action.action === 'rerun_doctor'
      ) {
        await refresh();
        setDoctor(await desktopApi.doctor(project.id));
      }
    } catch (caught) {
      setCheckError(caught instanceof Error ? caught.message : String(caught));
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
      <section className="project-heading" data-agent-active={activeProjectRun ? 'true' : 'false'}>
        <div className="project-identity">
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
        <div className="project-command-center">
          <div className={activeProjectRun ? 'project-agent-state active' : 'project-agent-state'}>
            <span className="project-agent-beacon" aria-hidden="true" />
            <span>
              <small>{activeProjectRun ? 'Run active' : 'Latest state'}</small>
              <strong>
                {activeProjectRun
                  ? activeProjectRun.stage.replaceAll('_', ' ')
                  : (latestRun?.status.replaceAll('_', ' ') ?? 'Awaiting first run')}
              </strong>
            </span>
            <span className="project-agent-bars" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </div>
          <div className="heading-actions">
            <button
              className="icon-button"
              title="Refresh local data"
              onClick={() => void refresh()}
            >
              <RefreshCw size={17} />
            </button>
            <button className="button quiet" onClick={onAddProject}>
              <FolderPlus size={16} /> Add
            </button>
            <button className="button quiet" onClick={() => onConfigureProject(project)}>
              <Wrench size={16} /> Configure
            </button>
            <button
              className="button primary"
              disabled={
                starting || !project.trusted || !project.configPath || Boolean(activeProjectRun)
              }
              onClick={() => void startProjectRun()}
            >
              {starting ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Play size={16} fill="currentColor" />
              )}{' '}
              {starting ? 'Starting' : 'Run QA'}
            </button>
          </div>
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
            value={
              project.configPath
                ? project.configPath.startsWith(project.path)
                  ? '.qagent.yml'
                  : 'Managed copy'
                : 'Missing'
            }
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
          <>
            <div className="doctor-summary">
              <StatusPill status={doctor.status} />
              <span>
                {doctor.checks.filter((item) => item.status === 'pass').length} of{' '}
                {doctor.checks.length} local checks passed
              </span>
              <SourceStamp provenance={{ source: 'system', capturedAt: doctor.checkedAt }} />
            </div>
            <DoctorChecks report={doctor} busy={checking} onAction={applyDoctorAction} />
          </>
        )}
        {checkError && (
          <div className="inline-error" role="alert">
            Doctor failed: {checkError}
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
          <div className="run-table">
            <div className="run-table-head" aria-hidden="true">
              <span>Run</span>
              <span>Stage</span>
              <span>Started</span>
              <span>Status</span>
              <span />
            </div>
            {projectRuns.slice(0, 8).map((run) => (
              <button
                className="run-row"
                key={run.id}
                data-status={run.status}
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
