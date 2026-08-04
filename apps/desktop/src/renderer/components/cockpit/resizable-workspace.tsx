import { useRef, useState, type ReactNode } from 'react';

const DEFAULT_CONSOLE_PERCENT = 58;
const MIN_CONSOLE_PERCENT = 44;
const MAX_CONSOLE_PERCENT = 70;

export function ResizableWorkspace({
  consolePane,
  evidencePane,
}: {
  consolePane: ReactNode;
  evidencePane: ReactNode;
}) {
  const [consolePercent, setConsolePercent] = useState(DEFAULT_CONSOLE_PERCENT);
  const workspaceRef = useRef<HTMLDivElement>(null);

  function setFromClientX(clientX: number) {
    const bounds = workspaceRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return;
    const next = ((clientX - bounds.left) / bounds.width) * 100;
    setConsolePercent(Math.min(MAX_CONSOLE_PERCENT, Math.max(MIN_CONSOLE_PERCENT, next)));
  }

  function beginResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setFromClientX(event.clientX);
  }

  function resizeWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 5 : 2;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setConsolePercent((value) => Math.max(MIN_CONSOLE_PERCENT, value - step));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setConsolePercent((value) => Math.min(MAX_CONSOLE_PERCENT, value + step));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setConsolePercent(MIN_CONSOLE_PERCENT);
    } else if (event.key === 'End') {
      event.preventDefault();
      setConsolePercent(MAX_CONSOLE_PERCENT);
    }
  }

  return (
    <div
      ref={workspaceRef}
      className="signal-resizable-workspace"
      style={{ '--signal-console-percent': `${consolePercent}%` } as React.CSSProperties}
    >
      <div className="signal-console-region">{consolePane}</div>
      <div
        className="signal-workspace-splitter"
        data-testid="workspace-splitter"
        role="separator"
        aria-label="Resize execution output and browser evidence"
        aria-orientation="vertical"
        aria-valuemin={MIN_CONSOLE_PERCENT}
        aria-valuemax={MAX_CONSOLE_PERCENT}
        aria-valuenow={Math.round(consolePercent)}
        tabIndex={0}
        onPointerDown={beginResize}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) setFromClientX(event.clientX);
        }}
        onDoubleClick={() => setConsolePercent(DEFAULT_CONSOLE_PERCENT)}
        onKeyDown={resizeWithKeyboard}
        title="Drag or use arrow keys to resize; double-click to reset"
      >
        <span aria-hidden="true" />
      </div>
      <div className="signal-evidence-region">{evidencePane}</div>
    </div>
  );
}
