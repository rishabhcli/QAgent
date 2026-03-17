'use client';

import { useState } from 'react';
import {
  TestTube2,
  Search,
  Wrench,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  Loader2,
  Clock,
  XCircle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils/cn';
import { AgentNodeDetails } from './agent-node-details';
import type { AgentExecutionState, AgentType } from '@/lib/types';

interface AgentNodeProps {
  state: AgentExecutionState;
  isLast?: boolean;
  className?: string;
}

const agentConfig: Record<
  AgentType,
  { label: string; icon: typeof TestTube2; color: string; bgColor: string }
> = {
  tester: {
    label: 'Tester',
    icon: TestTube2,
    color: 'text-sky-600 dark:text-sky-400',
    bgColor: 'bg-sky-500/15',
  },
  triage: {
    label: 'Triage',
    icon: Search,
    color: 'text-amber-600 dark:text-amber-400',
    bgColor: 'bg-amber-500/15',
  },
  fixer: {
    label: 'Fixer',
    icon: Wrench,
    color: 'text-violet-600 dark:text-violet-400',
    bgColor: 'bg-violet-500/15',
  },
  verifier: {
    label: 'Verifier',
    icon: ShieldCheck,
    color: 'text-emerald-600 dark:text-emerald-400',
    bgColor: 'bg-emerald-500/15',
  },
};

function formatDuration(startTime?: Date, endTime?: Date): string {
  if (!startTime) return '';
  const start = new Date(startTime).getTime();
  const end = endTime ? new Date(endTime).getTime() : Date.now();
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function AgentNode({ state, isLast = false, className }: AgentNodeProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const config = agentConfig[state.agent];
  const Icon = config.icon;

  const isRunning = state.status === 'running';
  const isCompleted = state.status === 'completed';
  const isFailed = state.status === 'failed';
  const isIdle = state.status === 'idle';

  const duration = formatDuration(state.startTime, state.endTime);
  const hasDetails = state.inputs || state.outputs || state.error || state.currentAction;

  return (
    <div className={cn('flex items-center flex-1', className)}>
      <div className="flex flex-col items-center gap-2 min-w-[100px]">
        {/* Node Circle */}
        <motion.div
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          className="relative cursor-pointer"
          onClick={() => hasDetails && setIsExpanded(!isExpanded)}
        >
          <div
            className={cn(
              'w-16 h-16 rounded-2xl flex items-center justify-center transition-all duration-300 relative',
              isRunning && 'bg-primary/20 ring-2 ring-primary shadow-lg shadow-primary/25',
              isCompleted && 'bg-emerald-500/15 ring-2 ring-emerald-500/40',
              isFailed && 'bg-destructive/10 ring-2 ring-destructive/40',
              isIdle && 'bg-muted/50'
            )}
          >
            {isRunning ? (
              <Loader2 className={cn('h-7 w-7 animate-spin', config.color)} />
            ) : (
              <Icon
                className={cn(
                  'h-7 w-7 transition-colors',
                  isCompleted && 'text-emerald-600 dark:text-emerald-400',
                  isFailed && 'text-destructive',
                  isIdle && config.color
                )}
              />
            )}

            {/* Status Badge */}
            {isCompleted && (
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                className="absolute -top-1 -right-1 w-6 h-6 bg-emerald-500 rounded-full flex items-center justify-center shadow-lg"
              >
                <CheckCircle className="h-4 w-4 text-white" />
              </motion.div>
            )}
            {isFailed && (
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                className="absolute -top-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-destructive shadow-lg"
              >
                <XCircle className="h-4 w-4 text-white" />
              </motion.div>
            )}
          </div>

          {/* Expand Indicator */}
          {hasDetails && (
            <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-5 h-5 rounded-full bg-muted border border-border flex items-center justify-center">
              {isExpanded ? (
                <ChevronUp className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              )}
            </div>
          )}
        </motion.div>

        {/* Label & Duration */}
        <div className="text-center">
          <p
            className={cn(
              'text-sm font-medium',
              isRunning && 'text-primary',
              isCompleted && 'text-emerald-600 dark:text-emerald-400',
              isFailed && 'text-destructive'
            )}
          >
            {config.label}
          </p>
          {isRunning && (
            <p className="text-xs text-muted-foreground animate-pulse">
              {state.currentAction || 'Running...'}
            </p>
          )}
          {(isCompleted || isFailed) && duration && (
            <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
              <Clock className="h-3 w-3" />
              {duration}
            </p>
          )}
        </div>

        {/* Expanded Details */}
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="w-64 overflow-hidden"
            >
              <AgentNodeDetails state={state} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Connector Line */}
      {!isLast && (
        <div className="flex-1 mx-4">
          <div
            className={cn(
              'h-1 rounded-full transition-all duration-500',
              isCompleted
                ? 'bg-gradient-to-r from-emerald-500 to-emerald-500/50'
                : isFailed
                  ? 'bg-gradient-to-r from-destructive to-destructive/50'
                  : 'bg-muted/30'
            )}
          />
        </div>
      )}
    </div>
  );
}
