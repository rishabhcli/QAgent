'use client';

import { useState, useEffect, useCallback, use, useMemo } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Ban,
  CheckCircle,
  Clock,
  Loader2,
  Play,
  RefreshCw,
  TestTube2,
  Wrench,
  XCircle,
} from 'lucide-react';
import { Header } from '@/components/dashboard/header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils/cn';
import { EnhancedAgentPipeline } from '@/components/runs/enhanced-agent-pipeline';
import { ActivityLog } from '@/components/runs/activity-log';
import { DiagnosticsPanel } from '@/components/diagnostics';
import { LiveBrowserViewer } from '@/components/runs/live-browser-viewer';
import { AgentTerminal } from '@/components/runs/agent-terminal';
import { useRunStatus } from '@/lib/hooks/use-run-status';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toaster';
import type {
  ActivityLogEntry,
  AgentExecutionState,
  AgentType,
  DiagnosticsData,
  Patch,
  RunEvent,
  RunStatus,
  TestResult,
  TestSpec,
} from '@/lib/types';

interface Run {
  id: string;
  repoId: string;
  repoName: string;
  status: RunStatus;
  currentAgent: AgentType | null;
  iteration: number;
  maxIterations: number;
  testSpecs: TestSpec[];
  patches: Patch[];
  testResults: TestResult[];
  startedAt: string;
  completedAt?: string;
  sessionId?: string;
}

const statusConfig = {
  completed: {
    label: 'Completed',
    variant: 'success' as const,
    icon: CheckCircle,
  },
  running: { label: 'Running', variant: 'default' as const, icon: Play },
  failed: { label: 'Failed', variant: 'destructive' as const, icon: XCircle },
  pending: { label: 'Pending', variant: 'secondary' as const, icon: Clock },
  cancelled: { label: 'Cancelled', variant: 'secondary' as const, icon: Ban },
};

function formatDuration(startedAt: string, completedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));

  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function buildActivityEntries(
  run: Run | null,
  events: RunEvent[],
  currentAgent: AgentType | null
): ActivityLogEntry[] {
  const entries = events.flatMap((event): ActivityLogEntry[] => {
    const defaultAgent = currentAgent || run?.currentAgent || 'tester';

    switch (event.type) {
      case 'activity':
        return [event.data as ActivityLogEntry];
      case 'agent': {
        const data = event.data as { agent?: AgentType; status?: 'started' | 'completed' };
        if (!data.agent || !data.status) {
          return [];
        }

        return [
          {
            id: `${event.runId}-${event.timestamp}-${data.agent}-${data.status}`,
            timestamp: new Date(event.timestamp),
            agent: data.agent,
            action: data.status,
            message: `${data.agent} ${data.status}`,
          },
        ];
      }
      case 'patch': {
        const data = event.data as {
          patch?: Patch;
          status?: string;
          mergeError?: string;
        };
        if (!data.patch) {
          return [];
        }

        const message =
          data.status === 'pr_merged'
            ? `Merged PR for ${data.patch.file}`
            : data.status === 'pr_created'
              ? `Created PR for ${data.patch.file}`
              : `Generated ${data.patch.file}`;

        return [
          {
            id: `${event.runId}-${data.patch.id}`,
            timestamp: new Date(event.timestamp),
            agent: 'fixer',
            action: 'patch',
            message,
            details: data.patch.file
              ? {
                  url: data.patch.file,
                  error: data.mergeError ? { message: data.mergeError } : undefined,
                }
              : undefined,
          },
        ];
      }
      case 'status': {
        const data = event.data as { message?: string };
        if (!data.message) {
          return [];
        }

        return [
          {
            id: `${event.runId}-${event.timestamp}-status`,
            timestamp: new Date(event.timestamp),
            agent: defaultAgent,
            action: 'started',
            message: data.message,
          },
        ];
      }
      case 'error': {
        const data = event.data as { error?: string; message?: string };
        const message = data.error || data.message;
        if (!message) {
          return [];
        }

        return [
          {
            id: `${event.runId}-${event.timestamp}-error`,
            timestamp: new Date(event.timestamp),
            agent: defaultAgent,
            action: 'failed',
            message,
            details: { error: { message } },
          },
        ];
      }
      case 'complete': {
        const data = event.data as { success?: boolean };
        return [
          {
            id: `${event.runId}-${event.timestamp}-complete`,
            timestamp: new Date(event.timestamp),
            agent: defaultAgent,
            action: 'completed',
            message: data.success ? 'Run completed successfully' : 'Run completed with failures',
          },
        ];
      }
      default:
        return [];
    }
  });

  return entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function parsePatchDiff(diff: string): { beforeCode: string; afterCode: string } {
  const beforeLines: string[] = [];
  const afterLines: string[] = [];

  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      continue;
    }

    if (line.startsWith('-')) {
      beforeLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith('+')) {
      afterLines.push(line.slice(1));
      continue;
    }

    beforeLines.push(line);
    afterLines.push(line);
  }

  return {
    beforeCode: beforeLines.join('\n').trim(),
    afterCode: afterLines.join('\n').trim(),
  };
}

function buildDiagnostics(run: Run | null, events: RunEvent[]): DiagnosticsData {
  if (!run) {
    return {};
  }

  const latestDiagnostics = events
    .filter((event) => event.type === 'diagnostics')
    .reduce<DiagnosticsData>(
      (accumulator, event) => ({
        ...accumulator,
        ...(event.data as Partial<DiagnosticsData>),
      }),
      {}
    );

  const firstFailure = run.testResults.find((result) => !result.passed && result.failureReport);
  const firstPatch = run.patches[0];
  const { beforeCode, afterCode } = firstPatch ? parsePatchDiff(firstPatch.diff) : { beforeCode: '', afterCode: '' };

  return {
    testFailure: firstFailure?.failureReport
      ? {
          errorMessage: firstFailure.failureReport.error.message,
          failedStep: firstFailure.failureReport.step,
          consoleLogs: firstFailure.failureReport.context.consoleLogs,
          url: firstFailure.failureReport.context.url,
          domSnapshot: firstFailure.failureReport.context.domSnapshot,
          screenshotUrl: firstFailure.failureReport.context.screenshot
            ? `data:image/png;base64,${firstFailure.failureReport.context.screenshot}`
            : undefined,
        }
      : latestDiagnostics.testFailure,
    triage: latestDiagnostics.triage,
    patch: firstPatch
      ? {
          filePath: firstPatch.file,
          beforeCode,
          afterCode,
          linesAdded: firstPatch.metadata.linesAdded,
          linesRemoved: firstPatch.metadata.linesRemoved,
          llmReasoning: undefined,
        }
      : latestDiagnostics.patch,
    verification: latestDiagnostics.verification,
  };
}

function deriveAgentStates(events: RunEvent[]): Partial<Record<AgentType, AgentExecutionState>> {
  const states: Partial<Record<AgentType, AgentExecutionState>> = {};

  for (const event of events) {
    if (event.type !== 'agent') {
      continue;
    }

    const data = event.data as { agent?: AgentType; status?: 'started' | 'completed' };
    if (!data.agent || !data.status) {
      continue;
    }

    const timestamp = new Date(event.timestamp);
    const existing = states[data.agent] || {
      agent: data.agent,
      status: 'idle',
    };

    if (data.status === 'started') {
      states[data.agent] = {
        ...existing,
        status: 'running',
        startTime: timestamp,
      };
      continue;
    }

    const startTime = existing.startTime;
    states[data.agent] = {
      ...existing,
      status: 'completed',
      endTime: timestamp,
      duration: startTime ? timestamp.getTime() - new Date(startTime).getTime() : undefined,
    };
  }

  return states;
}

export default function RunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }> | { runId: string };
}) {
  const resolvedParams = params instanceof Promise ? use(params) : params;
  const { runId } = resolvedParams;
  const { error: showError, success } = useToast();
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const liveRun = useRunStatus(runId);

  const fetchRun = useCallback(async () => {
    try {
      const res = await fetch(`/api/runs/${runId}`, { credentials: 'include' });
      if (!res.ok) {
        setError(res.status === 404 ? 'Run not found' : 'Failed to fetch run');
        return;
      }

      const data = await res.json();
      setRun(data.run as Run);
      setError(null);
    } catch {
      setError('Failed to fetch run data');
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [runId]);

  useEffect(() => {
    fetchRun();
  }, [fetchRun]);

  useEffect(() => {
    if (run?.status === 'running' || run?.status === 'pending') {
      const interval = setInterval(fetchRun, 2000);
      return () => clearInterval(interval);
    }
  }, [run?.status, fetchRun]);

  const mergedRun = useMemo(() => {
    if (!run) {
      return null;
    }

    return {
      ...run,
      status: liveRun.status !== 'pending' || run.status === 'pending' ? liveRun.status : run.status,
      currentAgent: liveRun.currentAgent ?? run.currentAgent,
      iteration: Math.max(run.iteration, liveRun.iteration),
    };
  }, [liveRun.currentAgent, liveRun.iteration, liveRun.status, run]);

  const activityLog = useMemo(
    () => buildActivityEntries(mergedRun, liveRun.events, liveRun.currentAgent),
    [liveRun.currentAgent, liveRun.events, mergedRun]
  );
  const diagnostics = useMemo(
    () => buildDiagnostics(mergedRun, liveRun.events),
    [liveRun.events, mergedRun]
  );
  const agentStates = useMemo(() => deriveAgentStates(liveRun.events), [liveRun.events]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    fetchRun();
  };

  const handleCancel = async () => {
    const res = await fetch(`/api/runs/${runId}`, { method: 'DELETE', credentials: 'include' });
    if (res.ok) {
      success('Run cancelled');
      fetchRun();
    } else {
      showError('Failed to cancel run');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="flex h-96 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  if (error || !mergedRun) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="p-6">
          <div className="mb-6 flex items-center gap-4">
            <Link href="/dashboard/runs">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <h1 className="text-2xl font-bold">Run Details</h1>
          </div>
          <Card className="max-w-md">
            <CardContent className="pt-6">
              <div className="text-center">
                <XCircle className="mx-auto mb-4 h-12 w-12 text-destructive" />
                <h2 className="mb-2 text-lg font-semibold">{error || 'Run not found'}</h2>
                <p className="mb-4 text-muted-foreground">
                  The run you&apos;re looking for doesn&apos;t exist or has been deleted.
                </p>
                <Link href="/dashboard/runs">
                  <Button>Back to Runs</Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const config = statusConfig[mergedRun.status];
  const StatusIcon = config.icon;
  const passedTests = mergedRun.testResults.filter((result) => result.passed).length;
  const totalTests = mergedRun.testSpecs.length;
  const duration = formatDuration(mergedRun.startedAt, mergedRun.completedAt);

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <div className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="flex items-center gap-4">
            <Link href="/dashboard/runs">
              <Button variant="ghost" size="icon" className="hover:bg-muted">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold tracking-tight">{mergedRun.repoName}</h1>
                <Badge variant={config.variant} className="gap-1">
                  <StatusIcon className="h-3 w-3" />
                  {config.label}
                </Badge>
                {liveRun.isConnected && (
                  <Badge variant="outline" className="text-xs">
                    Live
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Run #{mergedRun.id.slice(0, 8)} · Iteration {mergedRun.iteration}/{mergedRun.maxIterations}
                {' '}· {mergedRun.testSpecs.length} test(s)
              </p>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                Track every stage of the remediation loop, from validation and diagnostics through patch creation, PR delivery, and verification.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
              <RefreshCw className={cn('mr-2 h-4 w-4', isRefreshing && 'animate-spin')} />
              Refresh
            </Button>
            {(mergedRun.status === 'running' || mergedRun.status === 'pending') && (
              <Button variant="destructive" size="sm" onClick={handleCancel}>
                Cancel Run
              </Button>
            )}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Card className="border-border/80 bg-card/90 shadow-sm">
            <CardContent className="pt-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Tests</p>
                  <p className="text-2xl font-bold">
                    {passedTests}/{totalTests}
                  </p>
                </div>
                <div className="rounded-2xl bg-primary/10 p-3 text-primary">
                  <TestTube2 className="h-5 w-5" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/80 bg-card/90 shadow-sm">
            <CardContent className="pt-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Patches</p>
                  <p className="text-2xl font-bold">{mergedRun.patches.length}</p>
                </div>
                <div className="rounded-2xl bg-primary/10 p-3 text-primary">
                  <Wrench className="h-5 w-5" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/80 bg-card/90 shadow-sm">
            <CardContent className="pt-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Iteration</p>
                  <p className="text-2xl font-bold">
                    {mergedRun.iteration}/{mergedRun.maxIterations}
                  </p>
                </div>
                <div className="rounded-2xl bg-primary/10 p-3 text-primary">
                  <RefreshCw className="h-5 w-5" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/80 bg-card/90 shadow-sm">
            <CardContent className="pt-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Duration</p>
                  <p className="text-2xl font-bold">{duration}</p>
                </div>
                <div className="rounded-2xl bg-primary/10 p-3 text-primary">
                  <Clock className="h-5 w-5" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <EnhancedAgentPipeline
          currentAgent={mergedRun.currentAgent}
          status={mergedRun.status}
          agentStates={agentStates}
        />

        <div className="grid gap-4 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <LiveBrowserViewer
              runId={mergedRun.id}
              isRunning={mergedRun.status === 'running'}
              className="h-full min-h-[400px]"
            />
          </div>
          <div className="lg:col-span-2">
            <AgentTerminal
              entries={activityLog}
              isLive={mergedRun.status === 'running'}
              className="h-full min-h-[400px]"
            />
          </div>
        </div>

        <Tabs defaultValue="activity" className="space-y-4">
          <TabsList className="h-auto flex-wrap justify-start bg-muted/60 p-1.5">
            <TabsTrigger value="activity" className="gap-2">
              Activity Log
              {activityLog.length > 0 && (
                <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-xs">
                  {activityLog.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="diagnostics" className="gap-2">
              Diagnostics
            </TabsTrigger>
            <TabsTrigger value="tests" className="gap-2">
              <TestTube2 className="h-4 w-4" />
              Tests ({mergedRun.testSpecs.length})
            </TabsTrigger>
            <TabsTrigger value="patches" className="gap-2">
              <Wrench className="h-4 w-4" />
              Patches ({mergedRun.patches.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="activity">
            <ActivityLog entries={activityLog} isLive={mergedRun.status === 'running'} />
          </TabsContent>

          <TabsContent value="diagnostics">
            <DiagnosticsPanel diagnostics={diagnostics} />
          </TabsContent>

          <TabsContent value="tests" className="space-y-4">
            <Card>
              <CardContent className="pt-6">
                {mergedRun.testSpecs.length === 0 ? (
                  <EmptyState
                    variant="no-data"
                    title="No tests defined"
                    description="Add or generate test specifications to give PatchPilot stable validation coverage."
                    compact
                  />
                ) : (
                  <div className="space-y-3">
                    {mergedRun.testSpecs.map((spec, index) => {
                      const result = mergedRun.testResults[index];
                      const hasResult = result !== undefined;
                      const passed = result?.passed;

                      return (
                        <div
                          key={spec.id}
                          className={cn(
                            'flex items-center justify-between rounded-xl border p-4 transition-all',
                            hasResult && passed && 'border-emerald-500/20 bg-emerald-500/5',
                            hasResult && !passed && 'border-destructive/20 bg-destructive/5',
                            !hasResult && 'border-border/50 bg-muted/30'
                          )}
                        >
                          <div className="flex items-center gap-4">
                            <div
                              className={cn(
                                'flex h-10 w-10 items-center justify-center rounded-xl',
                                hasResult && passed && 'bg-emerald-500/20',
                                hasResult && !passed && 'bg-destructive/10',
                                !hasResult && 'bg-muted'
                              )}
                            >
                              {!hasResult ? (
                                <Clock className="h-5 w-5 text-muted-foreground" />
                              ) : passed ? (
                                <CheckCircle className="h-5 w-5 text-emerald-500 dark:text-emerald-400" />
                              ) : (
                                <XCircle className="h-5 w-5 text-destructive" />
                              )}
                            </div>
                            <div>
                              <span className="font-medium">{spec.name}</span>
                              <p className="text-sm text-muted-foreground">
                                {spec.steps.length} step(s) · {spec.url}
                              </p>
                            </div>
                          </div>
                          {result && (
                            <span className="text-sm text-muted-foreground">
                              {(result.duration / 1000).toFixed(1)}s
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="patches" className="space-y-4">
            <Card>
              <CardContent className="pt-6">
                {mergedRun.patches.length === 0 ? (
                  <EmptyState
                    variant="no-data"
                    title="No patches generated yet"
                    description="Patch details appear here when PatchPilot generates a diff or opens a pull request."
                    compact
                  />
                ) : (
                  <div className="space-y-4">
                    {mergedRun.patches.map((patch) => (
                      <div
                        key={patch.id}
                        className="rounded-xl border border-border/50 bg-muted/30 p-4 transition-all hover:border-primary/30"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0 flex-1">
                            <p className="font-mono text-sm font-medium text-primary">{patch.file}</p>
                            <p className="mt-1 text-sm text-muted-foreground">{patch.description}</p>
                            <div className="mt-3 flex items-center gap-4">
                              <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-400">
                                +{patch.metadata.linesAdded} added
                              </span>
                              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                                -{patch.metadata.linesRemoved} removed
                              </span>
                              <span className="text-xs text-muted-foreground">
                                Model: {patch.metadata.llmModel}
                              </span>
                            </div>
                          </div>
                          <Badge variant="success">
                            {patch.prUrl
                              ? patch.merged
                                ? 'Merged'
                                : patch.mergeError
                                  ? 'PR Open'
                                  : 'PR Created'
                              : 'Applied'}
                          </Badge>
                        </div>
                        {patch.diff && (
                          <pre className="mt-3 overflow-x-auto rounded-lg border bg-background p-3 text-xs font-mono">
                            {patch.diff}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
