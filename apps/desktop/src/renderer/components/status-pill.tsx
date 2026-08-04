import { AlertCircle, CheckCircle2, CircleDot, Clock3, PauseCircle, XCircle } from 'lucide-react';
import type { RunStatus } from '@qagent/contracts';

interface Props {
  status:
    | RunStatus
    | 'ready'
    | 'degraded'
    | 'blocked'
    | 'configured'
    | 'unconfigured'
    | 'healthy'
    | 'end-to-end-verified'
    | 'checking'
    | 'started'
    | 'disabled'
    | 'error';
}

export function StatusPill({ status }: Props) {
  const normalized = status.replaceAll(/[_-]/g, ' ');
  const Icon =
    status === 'succeeded' ||
    status === 'ready' ||
    status === 'healthy' ||
    status === 'end-to-end-verified'
      ? CheckCircle2
      : status === 'failed' || status === 'error' || status === 'blocked'
        ? XCircle
        : status === 'running' || status === 'started'
          ? CircleDot
          : status === 'queued' || status === 'checking'
            ? Clock3
            : status === 'policy_blocked' || status === 'degraded'
              ? AlertCircle
              : PauseCircle;
  return (
    <span className={`status status-${status}`}>
      <Icon size={13} aria-hidden="true" />
      {normalized}
    </span>
  );
}
