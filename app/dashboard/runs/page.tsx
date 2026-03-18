'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Play, CheckCircle, XCircle, Clock, Filter, RefreshCw, Loader2 } from 'lucide-react';
import { Header } from '@/components/dashboard/header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NewRunDialog } from '@/components/dashboard/new-run-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toaster';

interface Run {
  id: string;
  repoId: string;
  repoName: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  currentAgent: string | null;
  iteration: number;
  maxIterations: number;
  testsTotal: number;
  testsPassed: number;
  patchesApplied: number;
  startedAt: string;
  completedAt?: string;
}

const statusConfig = {
  completed: { label: 'Completed', variant: 'success' as const, icon: CheckCircle },
  running: { label: 'Running', variant: 'default' as const, icon: Play },
  failed: { label: 'Failed', variant: 'destructive' as const, icon: XCircle },
  pending: { label: 'Pending', variant: 'secondary' as const, icon: Clock },
  cancelled: { label: 'Cancelled', variant: 'secondary' as const, icon: XCircle },
};

export default function RunsPage() {
  const router = useRouter();
  const { error: showError } = useToast();
  const [filter, setFilter] = useState<string>('all');
  const [runs, setRuns] = useState<Run[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchRuns = useCallback(async () => {
    try {
      const response = await fetch('/api/runs', { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        setRuns(data.runs || []);
      } else {
        showError('Failed to load runs', 'QAgent could not fetch the run history.');
      }
    } catch {
      showError('Failed to load runs', 'Check your connection and try again.');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [showError]);

  useEffect(() => {
    fetchRuns();

    // Poll for updates every 5 seconds if there are running runs
    const interval = setInterval(() => {
      if (runs.some((run) => run.status === 'running' || run.status === 'pending')) {
        fetchRuns();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [fetchRuns, runs]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    fetchRuns();
  };

  const handleRunCreated = (runId: string) => {
    // Refresh the list and navigate to the new run
    fetchRuns();
    router.push(`/dashboard/runs/${runId}`);
  };

  const filteredRuns = filter === 'all' ? runs : runs.filter((run) => run.status === filter);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatDuration = (startedAt: string, completedAt?: string) => {
    const start = new Date(startedAt).getTime();
    const end = completedAt ? new Date(completedAt).getTime() : Date.now();
    const seconds = Math.floor((end - start) / 1000);
    
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  return (
    <div className="min-h-screen bg-background">
      <Header title="Runs" />

      <div className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
        {/* Actions Bar */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">Operational runs</p>
            <p className="text-sm text-muted-foreground">
              Track active remediation loops, review completed runs, and inspect failures quickly.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Filter className="mr-2 h-4 w-4" />
                  {filter === 'all' ? 'All Status' : statusConfig[filter as keyof typeof statusConfig]?.label}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={() => setFilter('all')}>All Status</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFilter('running')}>Running</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFilter('completed')}>Completed</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFilter('failed')}>Failed</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
          <NewRunDialog onRunCreated={handleRunCreated} />
        </div>

        {/* Runs List */}
        <Card className="border-border/80 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">All Runs</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-2">
                {filteredRuns.length === 0 ? (
                  <EmptyState
                    variant={filter === 'all' ? 'default' : 'search'}
                    title={filter === 'all' ? 'No runs yet' : 'No runs match this filter'}
                    description={
                      filter === 'all'
                        ? 'Launch your first run to start testing, patching, and verification.'
                        : 'Try a different status filter or refresh the run history.'
                    }
                    action={
                      filter === 'all'
                        ? { label: 'Start your first run', onClick: () => document.querySelector<HTMLButtonElement>('[data-new-run-trigger]')?.click() }
                        : undefined
                    }
                    compact
                  />
                ) : (
                  filteredRuns.map((run) => {
                    const config = statusConfig[run.status];
                    const StatusIcon = config.icon;
                    const passRate = run.testsTotal > 0 
                      ? Math.round((run.testsPassed / run.testsTotal) * 100) 
                      : 0;
                    
                    return (
                      <Link
                        key={run.id}
                        href={`/dashboard/runs/${run.id}`}
                          className="flex items-center justify-between rounded-2xl border border-border/70 bg-card/80 p-4 transition-all hover:border-primary/20 hover:bg-accent/40"
                        >
                        <div className="flex items-center gap-4">
                          <div
                            className={`p-2.5 rounded-lg ${
                              run.status === 'completed'
                                ? 'bg-success/10 text-success'
                                : run.status === 'failed'
                                  ? 'bg-destructive/10 text-destructive'
                                  : run.status === 'running'
                                    ? 'bg-primary/10 text-primary animate-pulse'
                                    : 'bg-muted text-muted-foreground'
                            }`}
                          >
                            <StatusIcon className="h-5 w-5" />
                          </div>
                          <div>
                            <p className="font-medium">
                              {run.repoName}
                              {run.status === 'running' && run.currentAgent && (
                                <span className="ml-2 text-sm text-muted-foreground">
                                  ({run.currentAgent} agent)
                                </span>
                              )}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              Started {formatDate(run.startedAt)}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-6">
                          <div className="hidden md:block text-right">
                            <p className="text-sm font-medium">
                              {run.testsPassed}/{run.testsTotal} tests
                            </p>
                            <p className="text-xs text-muted-foreground">{passRate}% pass rate</p>
                          </div>
                          <div className="hidden lg:block text-right">
                            <p className="text-sm font-medium">{run.patchesApplied} patches</p>
                            <p className="text-xs text-muted-foreground">
                              {run.iteration}/{run.maxIterations} iterations
                            </p>
                          </div>
                          <div className="hidden sm:block text-right min-w-[60px]">
                            <p className="text-sm text-muted-foreground">
                              {formatDuration(run.startedAt, run.completedAt)}
                            </p>
                          </div>
                          <Badge variant={config.variant}>{config.label}</Badge>
                        </div>
                      </Link>
                    );
                  })
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
