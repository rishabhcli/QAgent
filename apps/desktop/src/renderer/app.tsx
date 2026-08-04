import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, RunActionRequest, RunActionResult, RunLaunch } from '@qagent/contracts';
import { AlertTriangle } from 'lucide-react';
import { desktopApi } from './api.js';
import { AgentPresence } from './components/agent-presence.js';
import { Sidebar } from './components/sidebar.js';
import { WorkflowDock } from './components/workflow-dock.js';
import { Onboarding } from './views/onboarding.js';
import { ProjectsView } from './views/projects.js';
import { RunsView } from './views/runs.js';
import { SettingsView } from './views/settings.js';
import { TestsView } from './views/tests.js';
import type { AppView, BootstrapSnapshot } from './types.js';

export function App() {
  const [snapshot, setSnapshot] = useState<BootstrapSnapshot | null>(null);
  const [view, setView] = useState<AppView>('projects');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [lastLaunch, setLastLaunch] = useState<RunLaunch | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingProject, setOnboardingProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshQueued = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) {
      refreshQueued.current = true;
      await refreshInFlight.current;
      return;
    }
    const task = (async () => {
      do {
        refreshQueued.current = false;
        try {
          const next = await desktopApi.bootstrap();
          setSnapshot(next);
          if ((next.projects.data?.length ?? 0) === 0) setShowOnboarding(true);
          setSelectedProjectId((current) => current ?? next.projects.data?.[0]?.id ?? null);
          setError(null);
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } while (refreshQueued.current);
    })();
    refreshInFlight.current = task;
    try {
      await task;
    } finally {
      if (refreshInFlight.current === task) refreshInFlight.current = null;
    }
    if (refreshQueued.current) {
      refreshQueued.current = false;
      await refresh();
    }
  }, []);

  useEffect(() => {
    const initialRefresh = setTimeout(() => void refresh(), 0);
    let eventRefresh: number | null = null;
    const unsubscribe = window.qagent.onEvent((event) => {
      if (
        event.type !== 'run.event' &&
        event.type !== 'run.updated' &&
        event.type !== 'run.completed' &&
        event.type !== 'worker.ready'
      ) {
        return;
      }
      if (eventRefresh !== null) window.clearTimeout(eventRefresh);
      eventRefresh = window.setTimeout(() => {
        eventRefresh = null;
        void refresh();
      }, 90);
    });
    return () => {
      clearTimeout(initialRefresh);
      if (eventRefresh !== null) window.clearTimeout(eventRefresh);
      unsubscribe();
    };
  }, [refresh]);

  const hasActiveRun = useMemo(
    () => snapshot?.runs.data?.some((run) => run.status === 'running' || run.status === 'queued'),
    [snapshot?.runs.data]
  );
  const activeRun = useMemo(
    () =>
      snapshot?.runs.data?.find((run) => run.status === 'running' || run.status === 'queued') ??
      null,
    [snapshot?.runs.data]
  );
  const attentionRun = useMemo(
    () =>
      snapshot?.runs.data?.find(
        (run) => run.status === 'waiting_for_intervention' || run.status === 'interrupted'
      ) ?? null,
    [snapshot?.runs.data]
  );
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [hasActiveRun, refresh]);

  async function startRun(projectId: string) {
    setError(null);
    try {
      const launch = await desktopApi.startRun(projectId);
      setLastLaunch(launch);
      setSelectedRunId(launch.run.id);
      setView('runs');
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function cancelRun(runId: string) {
    await performRunAction({
      action: 'cancel',
      runId,
      requestedBy: 'desktop',
      reason: 'Cancellation requested from desktop',
    });
  }

  async function performRunAction(request: RunActionRequest): Promise<RunActionResult> {
    setError(null);
    try {
      const result = await desktopApi.runAction(request);
      if (!result.accepted) throw new Error(result.reason ?? `${request.action} was rejected`);
      setSelectedRunId(result.runId);
      await refresh();
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  }

  async function onboardingComplete(project: Project, shouldStart: boolean) {
    setShowOnboarding(false);
    setOnboardingProject(null);
    setSelectedProjectId(project.id);
    await refresh();
    if (shouldStart) await startRun(project.id);
  }

  function selectRun(runId: string) {
    setSelectedRunId(runId);
    setView('runs');
  }

  if (!snapshot && !error)
    return (
      <div className="boot-screen">
        <AgentPresence
          mode="working"
          title="Opening local workspace"
          detail="Reading durable state"
          compact
        />
      </div>
    );
  if (error && !snapshot)
    return (
      <div className="boot-screen error-screen">
        <AlertTriangle size={28} />
        <h1>QAgent could not open its local workspace.</h1>
        <p>{error}</p>
        <button className="button primary" onClick={() => void refresh()}>
          Try again
        </button>
      </div>
    );
  if (!snapshot) return null;
  if (showOnboarding || (snapshot.projects.data?.length ?? 0) === 0)
    return (
      <Onboarding
        initialProject={onboardingProject}
        onComplete={onboardingComplete}
        onCancel={
          (snapshot.projects.data?.length ?? 0) > 0
            ? () => {
                setShowOnboarding(false);
                setOnboardingProject(null);
              }
            : undefined
        }
      />
    );

  const projects = snapshot.projects.data ?? [];
  const runs = snapshot.runs.data ?? [];
  const tests = snapshot.tests.data ?? [];
  const integrations = snapshot.integrations.data ?? [];
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;
  const cockpitRun = selectedRun ?? runs[0] ?? null;
  const runsViewNeedsWorkflowDock =
    cockpitRun?.status === 'waiting_for_intervention' ||
    cockpitRun?.status === 'interrupted' ||
    cockpitRun?.availableActions.some((action) => action !== 'cancel');
  const viewTitles: Record<AppView, string> = {
    projects: 'Projects',
    runs: 'Signal Desk',
    tests: 'Tests',
    settings: 'Settings',
  };

  return (
    <div className="app-shell" data-agent-active={hasActiveRun ? 'true' : 'false'} data-view={view}>
      <Sidebar view={view} onChange={setView} activeStage={activeRun?.stage ?? null} />
      <div className="workspace">
        <header className="window-bar">
          <span>{viewTitles[view]}</span>
          <div className="window-state">
            <span className={hasActiveRun ? 'live-dot active' : 'live-dot'} />
            {activeRun
              ? `Run / ${activeRun.stage.replace('_', ' ')}`
              : attentionRun?.status === 'waiting_for_intervention'
                ? 'Run / action required'
                : attentionRun?.status === 'interrupted'
                  ? 'Run / recovery available'
                  : 'Local data ready'}
          </div>
        </header>
        <main className="workspace-content" data-view={view}>
          <div className="view-transition" key={view}>
            {view === 'projects' && (
              <ProjectsView
                projects={projects}
                runs={runs}
                provenance={snapshot.projects.provenance}
                selectedProjectId={selectedProjectId}
                onSelectProject={setSelectedProjectId}
                onSelectRun={selectRun}
                onStartRun={startRun}
                onAddProject={() => {
                  setOnboardingProject(null);
                  setShowOnboarding(true);
                }}
                onConfigureProject={(project) => {
                  setOnboardingProject(project);
                  setShowOnboarding(true);
                }}
                refresh={refresh}
              />
            )}
            {view === 'runs' && (
              <RunsView
                runs={runs}
                projects={projects}
                provenance={snapshot.runs.provenance}
                selectedRunId={selectedRun?.id ?? selectedRunId}
                onSelectRun={setSelectedRunId}
                onCancel={cancelRun}
                onStartRun={startRun}
              />
            )}
            {view === 'tests' && (
              <TestsView
                tests={tests}
                projects={projects}
                provenance={snapshot.tests.provenance}
                onOpenProjects={() => setView('projects')}
              />
            )}
            {view === 'settings' && (
              <SettingsView
                integrations={integrations}
                provenance={snapshot.integrations.provenance}
                hasActiveRun={Boolean(hasActiveRun)}
                project={projects.find((project) => project.id === selectedProjectId) ?? null}
                onConfigureProject={(project) => {
                  setOnboardingProject(project);
                  setShowOnboarding(true);
                }}
                onRefresh={refresh}
              />
            )}
          </div>
        </main>
        {(view !== 'runs' || runsViewNeedsWorkflowDock) && (
          <WorkflowDock
            runs={runs}
            selectedRunId={selectedRunId}
            lastLaunch={lastLaunch}
            onOpenRun={selectRun}
            onRunAction={performRunAction}
            onOpenSettings={() => setView('settings')}
            onOpenProjects={() => setView('projects')}
          />
        )}
        {error && (
          <div className="toast-error" role="alert">
            <AlertTriangle size={16} />
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
