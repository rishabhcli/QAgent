import patchMascot from '../assets/patch-mascot.png';

export type AgentPresenceMode = 'idle' | 'working' | 'ready' | 'degraded' | 'blocked';

interface AgentPresenceProps {
  mode: AgentPresenceMode;
  title: string;
  detail?: string;
  meta?: string;
  progress?: number | null;
  compact?: boolean;
  announce?: boolean;
}

export function AgentPresence({
  mode,
  title,
  detail,
  meta,
  progress,
  compact = false,
  announce = true,
}: AgentPresenceProps) {
  const normalizedProgress = progress === null ? null : Math.min(100, Math.max(0, progress ?? 0));

  return (
    <div
      className={`agent-presence agent-presence-${mode}${compact ? ' agent-presence-compact' : ''}`}
      aria-live={announce ? 'polite' : undefined}
      aria-atomic={announce ? 'true' : undefined}
    >
      <div className="agent-portrait" aria-hidden="true">
        <span className="agent-beacon" />
        <img src={patchMascot} alt="" />
      </div>
      <div className="agent-signal-copy">
        <div className="agent-signal-label">
          <span className="agent-signal-dot" />
          Agent
          {mode === 'working' && (
            <span className="agent-thinking" aria-label="working">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
        <strong>{title}</strong>
        {detail && <p>{detail}</p>}
        {meta && <small>{meta}</small>}
        {progress !== undefined && progress !== null && (
          <div
            className="agent-progress"
            role="progressbar"
            aria-label={title}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={normalizedProgress ?? 0}
          >
            <span style={{ width: `${normalizedProgress ?? 0}%` }} />
          </div>
        )}
      </div>
      <div className="agent-signal-bars" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
