'use client';

import * as React from 'react';
import {
  Clock,
  CheckCircle,
  XCircle,
  FileText,
  Code,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { AgentExecutionState, AgentType } from '@/lib/types';

interface AgentNodeDetailsProps {
  state: AgentExecutionState;
  className?: string;
}

function formatDuration(startTime?: Date, endTime?: Date): string {
  if (!startTime) return '-';
  const start = new Date(startTime).getTime();
  const end = endTime ? new Date(endTime).getTime() : Date.now();
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function getAgentDescription(agent: AgentType): string {
  switch (agent) {
    case 'tester':
      return 'Executes E2E tests and captures failures';
    case 'triage':
      return 'Analyzes failures and identifies root cause';
    case 'fixer':
      return 'Generates code patches to fix issues';
    case 'verifier':
      return 'Deploys fixes and verifies they work';
    default:
      return '';
  }
}

export function AgentNodeDetails({ state, className }: AgentNodeDetailsProps): React.ReactElement {
  const isRunning = state.status === 'running';
  const isCompleted = state.status === 'completed';
  const isFailed = state.status === 'failed';

  const renderCurrentAction = (): React.ReactNode => {
    if (!state.currentAction) return null;
    return (
      <div className="text-sm">
        <span className="text-muted-foreground">Current: </span>
        <span className="text-foreground">{state.currentAction}</span>
      </div>
    );
  };

  const renderProgress = (): React.ReactNode => {
    if (!isRunning || state.progress === undefined) return null;
    return (
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Progress</span>
          <span>{Math.round(state.progress)}%</span>
        </div>
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-300"
            style={{ width: `${state.progress}%` }}
          />
        </div>
      </div>
    );
  };

  const renderInputs = (): React.ReactNode => {
    if (!state.inputs) return null;
    const inputText = typeof state.inputs === 'string'
      ? String(state.inputs)
      : JSON.stringify(state.inputs, null, 2);
    return (
      <div className="pt-2 border-t border-border/50">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
          <FileText className="h-3 w-3" />
          <span>Inputs</span>
        </div>
        <pre className="text-xs bg-muted/50 p-2 rounded-lg overflow-x-auto max-h-24 overflow-y-auto">
          {inputText}
        </pre>
      </div>
    );
  };

  const renderOutputs = (): React.ReactNode => {
    if (!state.outputs) return null;
    const outputText = typeof state.outputs === 'string'
      ? String(state.outputs)
      : JSON.stringify(state.outputs, null, 2);
    return (
      <div className="pt-2 border-t border-border/50">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
          <Code className="h-3 w-3" />
          <span>Outputs</span>
        </div>
        <pre className="text-xs bg-muted/50 p-2 rounded-lg overflow-x-auto max-h-24 overflow-y-auto">
          {outputText}
        </pre>
      </div>
    );
  };

  const renderError = (): React.ReactNode => {
    if (!state.error) return null;
    return (
      <div className="border-t border-destructive/20 pt-2">
        <div className="mb-2 flex items-center gap-2 text-xs text-destructive">
          <AlertTriangle className="h-3 w-3" />
          <span>Error</span>
        </div>
        <p className="text-xs text-destructive/80">{state.error}</p>
      </div>
    );
  };

  return (
    <div
      className={cn(
        'p-4 rounded-xl border bg-card/50 space-y-4',
        isRunning && 'border-primary/30 bg-primary/5',
        isCompleted && 'border-emerald-500/30 bg-emerald-500/5',
        isFailed && 'border-destructive/30 bg-destructive/5',
        className
      )}
    >
      <div>
        <p className="text-sm text-muted-foreground">
          {getAgentDescription(state.agent)}
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isRunning && (
            <>
              <Loader2 className="h-4 w-4 text-primary animate-spin" />
              <span className="text-sm text-primary font-medium">Running</span>
            </>
          )}
          {isCompleted && (
            <>
              <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                Completed
              </span>
            </>
          )}
          {isFailed && (
            <>
              <XCircle className="h-4 w-4 text-destructive" />
              <span className="text-sm font-medium text-destructive">Failed</span>
            </>
          )}
          {state.status === 'idle' && (
            <>
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Waiting</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          {formatDuration(state.startTime, state.endTime)}
        </div>
      </div>

      {renderCurrentAction()}
      {renderProgress()}
      {renderInputs()}
      {renderOutputs()}
      {renderError()}
    </div>
  );
}
