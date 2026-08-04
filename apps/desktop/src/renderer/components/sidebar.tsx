import { Activity, Beaker, FolderKanban, PlayCircle, Settings2, ShieldCheck } from 'lucide-react';
import type { AppView } from '../types.js';

const items = [
  { id: 'projects' as const, label: 'Projects', icon: FolderKanban },
  { id: 'runs' as const, label: 'Runs', icon: PlayCircle },
  { id: 'tests' as const, label: 'Tests', icon: Beaker },
  { id: 'settings' as const, label: 'Settings', icon: Settings2 },
];

interface SidebarProps {
  view: AppView;
  onChange: (view: AppView) => void;
  activeStage: string | null;
}

function stageLabel(stage: string): string {
  return stage.replaceAll('_', ' ');
}

export function Sidebar({ view, onChange, activeStage }: SidebarProps) {
  return (
    <aside className="sidebar" data-agent-active={activeStage ? 'true' : 'false'}>
      <div className="brand" aria-label="QAgent">
        <span className="brand-mark">
          <span>Q</span>
          <i aria-hidden="true" />
        </span>
        <span className="brand-lockup">
          <span className="brand-name">QAgent</span>
          <small>Local repair agent</small>
        </span>
      </div>
      <nav aria-label="Primary">
        {items.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={view === id ? 'nav-item active' : 'nav-item'}
            onClick={() => onChange(id)}
            title={label}
            aria-current={view === id ? 'page' : undefined}
          >
            <i className="nav-rail" aria-hidden="true" />
            <Icon size={18} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className={activeStage ? 'local-badge active' : 'local-badge'} aria-live="polite">
        <span className="local-badge-icon">
          {activeStage ? (
            <Activity size={16} aria-hidden="true" />
          ) : (
            <ShieldCheck size={16} aria-hidden="true" />
          )}
        </span>
        <span className="local-badge-copy">
          <strong>{activeStage ? 'Run active' : 'Workspace ready'}</strong>
          <small>{activeStage ? stageLabel(activeStage) : 'Local and private'}</small>
        </span>
        <span className="sidebar-meter" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
      </div>
    </aside>
  );
}
