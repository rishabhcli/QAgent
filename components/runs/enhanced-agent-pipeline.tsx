'use client';

import { Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';
import { AgentNode } from './agent-node';
import type { AgentExecutionState, AgentType, AgentStatus } from '@/lib/types';

interface EnhancedAgentPipelineProps {
  currentAgent: AgentType | null;
  status: string;
  agentStates?: Partial<Record<AgentType, AgentExecutionState>>;
  className?: string;
}

const agents: AgentType[] = ['tester', 'triage', 'fixer', 'verifier'];

function deriveAgentStatus(
  agent: AgentType,
  currentAgent: AgentType | null,
  runStatus: string,
  index: number,
  currentIndex: number
): AgentStatus {
  if (runStatus === 'completed') return 'completed';
  if (runStatus === 'failed' && currentAgent === agent) return 'failed';
  if (currentAgent === agent) return 'running';
  if (currentIndex > index) return 'completed';
  return 'idle';
}

export function EnhancedAgentPipeline({
  currentAgent,
  status,
  agentStates = {},
  className,
}: EnhancedAgentPipelineProps) {
  const currentIndex = currentAgent ? agents.indexOf(currentAgent) : -1;

  // Build execution states for each agent
  const states: AgentExecutionState[] = agents.map((agent, index) => {
    const providedState = agentStates[agent];
    const derivedStatus = deriveAgentStatus(agent, currentAgent, status, index, currentIndex);

    return {
      agent,
      status: providedState?.status || derivedStatus,
      startTime: providedState?.startTime,
      endTime: providedState?.endTime,
      duration: providedState?.duration,
      currentAction: providedState?.currentAction,
      progress: providedState?.progress,
      inputs: providedState?.inputs,
      outputs: providedState?.outputs,
      error: providedState?.error,
    };
  });

  // Calculate overall progress
  const completedAgents = states.filter((s) => s.status === 'completed').length;
  const totalProgress = (completedAgents / agents.length) * 100;

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className="pb-3 bg-gradient-to-r from-muted/30 to-transparent">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              Agent Pipeline
            </CardTitle>
            <CardDescription>
              AI agents working together to test, diagnose, fix, and verify
            </CardDescription>
          </div>

          {/* Overall Progress */}
          {status === 'running' && (
            <div className="text-right">
              <p className="text-xs text-muted-foreground mb-1">Pipeline Progress</p>
              <div className="w-32 h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-500"
                  style={{ width: `${totalProgress}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="py-8">
        <div className="flex items-start justify-between">
          {states.map((state, index) => (
            <AgentNode key={state.agent} state={state} isLast={index === agents.length - 1} />
          ))}
        </div>

        {/* Mini Timeline */}
        {status === 'running' && (
          <div className="mt-6 pt-4 border-t border-border/50">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Started</span>
              <div className="flex-1 mx-4 h-0.5 bg-muted/30 relative">
                <div
                  className="absolute top-0 left-0 h-full bg-primary/50 rounded-full transition-all duration-500"
                  style={{ width: `${totalProgress}%` }}
                />
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-2 h-2 bg-primary rounded-full transition-all duration-500"
                  style={{ left: `${totalProgress}%` }}
                />
              </div>
              <span>{Math.round(totalProgress)}% Complete</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
