import type { CorrectiveAction, DoctorReport } from '@qagent/contracts';
import { ArrowRight, ExternalLink, Terminal } from 'lucide-react';
import { formatCommand } from '../command-format.js';
import { StatusPill } from './status-pill.js';

export function DoctorChecks({
  report,
  busy,
  onAction,
}: {
  report: DoctorReport;
  busy?: boolean;
  onAction: (action: CorrectiveAction) => Promise<void> | void;
}) {
  return (
    <div className="doctor-list">
      {report.checks.map((item) => (
        <div key={item.id} className="doctor-row">
          <StatusPill
            status={
              item.status === 'warn' ? 'degraded' : item.status === 'fail' ? 'blocked' : 'ready'
            }
          />
          <div>
            <strong>{item.label}</strong>
            <p title={item.detail}>{item.detail}</p>
            <small title={item.source}>{item.source}</small>
            {item.correctiveAction?.type === 'command' && (
              <code className="doctor-command">
                <Terminal size={13} aria-hidden="true" />
                {formatCommand(item.correctiveAction.command)}
              </code>
            )}
            {item.correctiveAction && item.correctiveAction.type !== 'command' && (
              <button
                type="button"
                className="button quiet compact-button"
                onClick={() => void onAction(item.correctiveAction as CorrectiveAction)}
                disabled={busy}
              >
                {item.correctiveAction.type === 'external' ? (
                  <ExternalLink size={14} aria-hidden="true" />
                ) : (
                  <ArrowRight size={14} aria-hidden="true" />
                )}
                {item.correctiveAction.label}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
