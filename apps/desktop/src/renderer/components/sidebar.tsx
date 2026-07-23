import { Beaker, FolderKanban, PlayCircle, Settings2, ShieldCheck } from 'lucide-react';
import type { AppView } from '../types.js';

const items = [
  { id: 'projects' as const, label: 'Projects', icon: FolderKanban },
  { id: 'runs' as const, label: 'Runs', icon: PlayCircle },
  { id: 'tests' as const, label: 'Tests', icon: Beaker },
  { id: 'settings' as const, label: 'Settings', icon: Settings2 },
];

export function Sidebar({ view, onChange }: { view: AppView; onChange: (view: AppView) => void }) {
  return (
    <aside className="sidebar">
      <div className="brand" aria-label="QAgent">
        <span className="brand-mark">Q</span>
        <span className="brand-name">QAgent</span>
      </div>
      <nav aria-label="Primary">
        {items.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={view === id ? 'nav-item active' : 'nav-item'}
            onClick={() => onChange(id)}
            title={label}
          >
            <Icon size={18} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="local-badge">
        <ShieldCheck size={16} aria-hidden="true" />
        <span>Local workspace</span>
      </div>
    </aside>
  );
}
