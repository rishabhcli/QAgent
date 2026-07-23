import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Project } from '@qagent/contracts';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { desktopApi } from './api.js';
import { Sidebar } from './components/sidebar.js';
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
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await desktopApi.bootstrap();
      setSnapshot(next);
      setSelectedProjectId((current) => current ?? next.projects.data?.[0]?.id ?? null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    const initialRefresh = setTimeout(() => void refresh(), 0);
    const unsubscribe = window.qagent.onEvent((event) => {
      if (event.type === 'run.event' || event.type === 'run.completed') void refresh();
    });
    return () => {
      clearTimeout(initialRefresh);
      unsubscribe();
    };
  }, [refresh]);

  const hasActiveRun = useMemo(
    () => snapshot?.runs.data?.some((run) => run.status === 'running' || run.status === 'queued'),
    [snapshot?.runs.data]
  );
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [hasActiveRun, refresh]);

  async function startRun(projectId: string) {
    const run = await desktopApi.startRun(projectId);
    setSelectedRunId(run.id);
    setView('runs');
    await refresh();
  }

  async function cancelRun(runId: string) {
    await desktopApi.cancelRun(runId);
    await refresh();
  }

  async function onboardingComplete(project: Project, shouldStart: boolean) {
    setShowOnboarding(false);
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
        <span className="brand-mark">Q</span>
        <LoaderCircle className="spin" size={22} />
        <p>Opening local workspace…</p>
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
    return <Onboarding onComplete={onboardingComplete} />;

  const projects = snapshot.projects.data ?? [];
  const runs = snapshot.runs.data ?? [];
  const tests = snapshot.tests.data ?? [];
  const integrations = snapshot.integrations.data ?? [];
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;
  const viewTitles: Record<AppView, string> = {
    projects: 'Projects',
    runs: 'Runs',
    tests: 'Tests',
    settings: 'Settings',
  };

  return (
    <div className="app-shell">
      <Sidebar view={view} onChange={setView} />
      <div className="workspace">
        <header className="window-bar">
          <span>{viewTitles[view]}</span>
          <div className="window-state">
            <span className={hasActiveRun ? 'live-dot active' : 'live-dot'} />
            {hasActiveRun ? 'Agent running' : 'Local data ready'}
          </div>
        </header>
        <main className="workspace-content">
          {view === 'projects' && (
            <ProjectsView
              projects={projects}
              runs={runs}
              provenance={snapshot.projects.provenance}
              selectedProjectId={selectedProjectId}
              onSelectProject={setSelectedProjectId}
              onSelectRun={selectRun}
              onStartRun={startRun}
              onAddProject={() => setShowOnboarding(true)}
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
            />
          )}
          {view === 'tests' && (
            <TestsView tests={tests} projects={projects} provenance={snapshot.tests.provenance} />
          )}
          {view === 'settings' && (
            <SettingsView
              integrations={integrations}
              provenance={snapshot.integrations.provenance}
              onRefresh={refresh}
            />
          )}
        </main>
        {error && (
          <div className="toast-error">
            <AlertTriangle size={16} />
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
