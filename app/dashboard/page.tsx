'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Play,
  CheckCircle,
  XCircle,
  Clock,
  GitBranch,
  Rocket,
  Sparkles,
  ArrowRight,
  Activity,
  RefreshCw,
  TrendingUp,
  Zap,
  Brain,
  Radio,
  Wrench,
  Settings,
  ChevronRight,
  Plus,
} from 'lucide-react';
import { Header } from '@/components/dashboard/header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { NewRunDialog } from '@/components/dashboard/new-run-dialog';
import { LearningIndicator } from '@/components/dashboard/learning-indicator';
import { useToast } from '@/components/ui/toaster';
import { EmptyState } from '@/components/ui/empty-state';
import { DashboardSkeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { motion } from 'framer-motion';
import { useSession } from '@/lib/hooks/use-session';
import { SetupChecklist } from '@/components/onboarding/onboarding-wizard';

interface RunStats {
  totalRuns: number;
  passRate: number;
  patchesApplied: number;
  avgIterations: number;
}

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

interface Patch {
  id: string;
  file: string;
  description: string;
  status: 'applied' | 'pending';
  runId: string;
  createdAt: string;
  prUrl?: string;
  merged?: boolean;
  mergeError?: string;
}

interface LearningMetrics {
  passRate: number;
  avgTimeToFix: number;
  firstTryRate: number;
  knowledgeReuseRate: number;
  improvementPercent: number;
}

interface MonitoringStatus {
  monitoredRepos: number;
  lastRun: string | null;
  isHealthy: boolean;
}

const statusConfig = {
  completed: { label: 'Completed', icon: CheckCircle, className: 'status-success' },
  running: { label: 'Running', icon: Play, className: 'status-running' },
  failed: { label: 'Failed', icon: XCircle, className: 'status-error' },
  pending: { label: 'Pending', icon: Clock, className: 'status-info' },
  cancelled: { label: 'Cancelled', icon: XCircle, className: 'status-warning' },
};

export default function DashboardPage() {
  const router = useRouter();
  const { success, error: showError } = useToast();
  const { primaryRepo, isAuthenticated, selectedRepos } = useSession();
  const [runs, setRuns] = useState<Run[]>([]);
  const [patches, setPatches] = useState<Patch[]>([]);
  const [learningMetrics, setLearningMetrics] = useState<LearningMetrics | null>(null);
  const [monitoringStatus, setMonitoringStatus] = useState<MonitoringStatus | null>(null);
  const [stats, setStats] = useState<RunStats>({
    totalRuns: 0,
    passRate: 0,
    patchesApplied: 0,
    avgIterations: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Setup checklist state
  const [setupDismissed, setSetupDismissed] = useState(() => {
    try {
      return localStorage.getItem('qagent_setup_dismissed') === 'true';
    } catch {
      return false;
    }
  });
  const [hasTests, setHasTests] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [runsRes, patchesRes, learningRes, monitoringRes] = await Promise.all([
        fetch('/api/runs', { credentials: 'include' }),
        fetch('/api/patches').catch(() => null),
        fetch('/api/learning/metrics').catch(() => null),
        fetch('/api/monitoring/configs').catch(() => null),
      ]);

      if (runsRes.ok) {
        const data = await runsRes.json();
        setRuns(data.runs || []);
        setStats(data.stats || {
          totalRuns: 0,
          passRate: 0,
          patchesApplied: 0,
          avgIterations: 0,
        });
      }

      if (patchesRes?.ok) {
        const data = await patchesRes.json();
        setPatches(data.patches?.slice(0, 5) || []);
      }

      if (learningRes?.ok) {
        const data = await learningRes.json();
        setLearningMetrics(data);
      }

      if (monitoringRes?.ok) {
        const data = await monitoringRes.json();
        setMonitoringStatus({
          monitoredRepos: data.configs?.length || 0,
          lastRun: data.lastRun || null,
          isHealthy: data.configs?.some((c: { enabled: boolean }) => c.enabled) || false,
        });
      }
    } catch {
      showError('Failed to load dashboard data');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [showError]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await fetchData();
    success('Dashboard refreshed');
  };

  // Track if there's an active run using a ref to avoid re-render loops
  const hasActiveRunRef = useRef(false);
  
  useEffect(() => {
    hasActiveRunRef.current = runs.some((run) => run.status === 'running' || run.status === 'pending');
  }, [runs]);

  useEffect(() => {
    fetchData();

    const interval = setInterval(() => {
      if (hasActiveRunRef.current) {
        fetchData();
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [fetchData]);

  // Lightweight check for whether any test specs exist (for the setup checklist)
  useEffect(() => {
    fetch('/api/tests', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setHasTests(Array.isArray(data) && data.length > 0))
      .catch(() => {});
  }, []);

  const allSetupComplete =
    isAuthenticated && selectedRepos.length > 0 && hasTests && runs.length > 0;

  const handleRunCreated = (runId: string) => {
    success('Run created', 'Redirecting to run details...', {
      action: { label: 'View Run', onClick: () => router.push(`/dashboard/runs/${runId}`) }
    });
    router.push(`/dashboard/runs/${runId}`);
  };

  const recentRuns = runs.slice(0, 5);
  const hasActiveRun = runs.some((run) => run.status === 'running');

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return date.toLocaleDateString();
  };

  if (isLoading) {
    return (
      <div className="min-h-screen">
        <Header title="Dashboard" />
        <DashboardSkeleton />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header title="Dashboard" />

      <main className="mx-auto max-w-7xl space-y-8 p-6 lg:p-8">
        {/* Setup Checklist */}
        {!setupDismissed && !allSetupComplete && (
          <SetupChecklist
            isAuthenticated={isAuthenticated}
            hasSelectedRepo={selectedRepos.length > 0}
            hasTests={hasTests}
            hasRuns={runs.length > 0}
            onDismiss={() => {
              setSetupDismissed(true);
              try {
                localStorage.setItem('qagent_setup_dismissed', 'true');
              } catch {
                // localStorage not available
              }
            }}
          />
        )}

        {/* Welcome Section */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="overflow-hidden rounded-[1.75rem] border border-border/80 bg-card p-6 shadow-[0_32px_100px_-48px_rgba(15,23,42,0.55)] lg:p-8"
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[linear-gradient(135deg,hsl(var(--primary)/0.18),transparent_60%)]" />
          <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-3 mb-3">
                <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                  <Sparkles className="h-3 w-3" />
                  Self-Healing QA Agent
                </div>
                <LearningIndicator variant="compact" />
              </div>
              <h1 className="mb-2 text-2xl font-bold tracking-tight lg:text-3xl">
                Operate the full test-fix-verify loop from one place
              </h1>
              <p className="max-w-2xl text-muted-foreground">
                Monitor repository health, launch repair runs, and review patches and pull requests without leaving the QAgent workspace.
              </p>
              <div className="mt-4 flex flex-wrap gap-2 text-sm text-muted-foreground">
                <span className="rounded-full border border-border/80 bg-muted/40 px-3 py-1">
                  Primary repo: {primaryRepo?.fullName || 'Not selected'}
                </span>
                <span className="rounded-full border border-border/80 bg-muted/40 px-3 py-1">
                  {hasActiveRun ? 'Live activity in progress' : 'No active runs right now'}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <NewRunDialog onRunCreated={handleRunCreated} />
              <Button variant="outline" onClick={handleRefresh} disabled={isRefreshing}>
                <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {hasActiveRun && (
            <div className="mt-6 flex items-center gap-3 border-t pt-6 text-sm">
              <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
              <span className="text-muted-foreground">A test run is currently in progress</span>
              <Link href="/dashboard/runs" className="text-primary hover:underline ml-auto">
                View runs →
              </Link>
            </div>
          )}
        </motion.section>

        {/* Stats Grid */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="grid grid-cols-2 lg:grid-cols-4 gap-4"
        >
          <StatCard
            title="Total Runs"
            value={stats.totalRuns === 0 ? '\u2014' : stats.totalRuns}
            description="Test runs executed"
            icon={Rocket}
            href="/dashboard/runs"
          />
          <StatCard
            title="Pass Rate"
            value={runs.length === 0 ? '\u2014' : `${Math.round(stats.passRate)}%`}
            description="Tests passing after fixes"
            icon={TrendingUp}
            href="/dashboard/runs"
          />
          <StatCard
            title="Patches Applied"
            value={stats.patchesApplied === 0 ? '\u2014' : stats.patchesApplied}
            description="Auto-generated fixes"
            icon={GitBranch}
            href="/dashboard/patches"
          />
          <StatCard
            title="Knowledge Base"
            value={learningMetrics?.knowledgeReuseRate ? `${Math.round(learningMetrics.knowledgeReuseRate)}%` : '\u2014'}
            description="Pattern reuse rate"
            icon={Brain}
            href="/dashboard/learning"
          />
        </motion.section>

        {/* Main Dashboard Grid */}
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Left Column - Recent Runs */}
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.2 }}
            className="lg:col-span-2 space-y-6"
          >
            {/* Recent Runs */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Play className="h-5 w-5 text-primary" />
                    <CardTitle className="text-lg">Recent Runs</CardTitle>
                  </div>
                  <Link href="/dashboard/runs">
                    <Button variant="ghost" size="sm">
                      View All
                      <ArrowRight className="ml-1 h-4 w-4" />
                    </Button>
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                {recentRuns.length === 0 ? (
                  <EmptyState
                    variant="default"
                    title="No runs yet"
                    description="Start your first run to see QAgent in action"
                    action={{ label: 'Start First Run', onClick: () => document.querySelector<HTMLButtonElement>('[data-new-run-trigger]')?.click() }}
                    compact
                  />
                ) : (
                  <div className="space-y-3">
                    {recentRuns.map((run) => {
                      const config = statusConfig[run.status];
                      const StatusIcon = config.icon;
                      const passRate = run.testsTotal > 0 
                        ? Math.round((run.testsPassed / run.testsTotal) * 100) 
                        : 0;

                      return (
                        <Link
                          key={run.id}
                          href={`/dashboard/runs/${run.id}`}
                          className="flex items-center justify-between p-4 rounded-lg border bg-card/50 hover:bg-accent/50 transition-colors group"
                        >
                          <div className="flex items-center gap-4">
                            <div className={`p-2 rounded-lg ${config.className}`}>
                              <StatusIcon className="h-4 w-4" />
                            </div>
                            <div>
                              <p className="font-medium group-hover:text-primary transition-colors">
                                {run.repoName}
                                {run.status === 'running' && run.currentAgent && (
                                  <span className="ml-2 text-sm text-muted-foreground font-normal">
                                    ({run.currentAgent})
                                  </span>
                                )}
                              </p>
                              <p className="text-sm text-muted-foreground">
                                {formatTimeAgo(run.startedAt)}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-4">
                            <div className="text-right hidden sm:block">
                              <p className="text-sm font-medium">{passRate}% pass</p>
                              <p className="text-xs text-muted-foreground">
                                {run.patchesApplied} patch{run.patchesApplied !== 1 ? 'es' : ''}
                              </p>
                            </div>
                            <Badge variant={run.status === 'completed' ? 'default' : run.status === 'failed' ? 'destructive' : 'secondary'}>
                              {config.label}
                            </Badge>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Recent Patches */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Wrench className="h-5 w-5 text-primary" />
                    <CardTitle className="text-lg">Recent Patches</CardTitle>
                  </div>
                  <Link href="/dashboard/patches">
                    <Button variant="ghost" size="sm">
                      View All
                      <ArrowRight className="ml-1 h-4 w-4" />
                    </Button>
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                {patches.length === 0 ? (
                  <EmptyState
                    variant="no-data"
                    title="No patches yet"
                    description="Patch activity appears here after a run generates or merges a fix."
                    compact
                  />
                ) : (
                  <div className="space-y-3">
                    {patches.slice(0, 3).map((patch) => (
                      <div
                        key={patch.id}
                        className="flex items-center justify-between rounded-xl border border-border/70 bg-secondary/20 p-3"
                      >
                        <div className="flex items-center gap-3">
                          <GitBranch className="h-4 w-4 text-primary" />
                          <div>
                            <p className="font-mono text-sm">{patch.file}</p>
                            <p className="text-xs text-muted-foreground">{patch.description}</p>
                          </div>
                        </div>
                        <Badge variant={patch.merged || patch.status === 'applied' ? 'default' : patch.mergeError ? 'warning' : 'secondary'}>
                          {patch.merged ? 'Merged' : patch.prUrl ? patch.mergeError ? 'PR Open' : 'PR Created' : patch.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.section>

          {/* Right Column - Widgets */}
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.3 }}
            className="space-y-6"
          >
            {/* Quick Actions */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Zap className="h-5 w-5 text-primary" />
                  <CardTitle className="text-lg">Quick Actions</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <QuickActionButton 
                  href="/dashboard/runs" 
                  icon={Play} 
                  label="Start New Run" 
                  description="Run tests on your app"
                />
                <QuickActionButton 
                  href="/dashboard/monitoring" 
                  icon={Radio} 
                  label="Setup Monitoring" 
                  description="Configure continuous testing"
                />
                <QuickActionButton 
                  href="/dashboard/learning" 
                  icon={Brain} 
                  label="View Learning" 
                  description="See improvement metrics"
                />
                <QuickActionButton 
                  href="/dashboard/settings" 
                  icon={Settings} 
                  label="Settings" 
                  description="Configure integrations"
                />
              </CardContent>
            </Card>

            {/* Learning Progress */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Brain className="h-5 w-5 text-primary" />
                    <CardTitle className="text-lg">Learning</CardTitle>
                  </div>
                  <Link href="/dashboard/learning">
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </Link>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {!learningMetrics || (learningMetrics.improvementPercent === 0 && learningMetrics.firstTryRate === 0 && learningMetrics.knowledgeReuseRate === 0) ? (
                  <div className="text-center py-2">
                    <p className="text-sm text-muted-foreground">Complete your first run to see learning metrics.</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2"
                      onClick={() => document.querySelector<HTMLButtonElement>('[data-new-run-trigger]')?.click()}
                    >
                      <Plus className="mr-1 h-3 w-3" />
                      Start a run
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="text-center">
                      <div className="text-3xl font-bold text-emerald-500">
                        +{learningMetrics.improvementPercent}%
                      </div>
                      <p className="text-sm text-muted-foreground">Improvement this week</p>
                    </div>
                    <div className="space-y-2">
                      <MetricRow
                        label="First-Try Success"
                        value={`${Math.round(learningMetrics.firstTryRate)}%`}
                      />
                      <MetricRow
                        label="Avg Time to Fix"
                        value={`${Math.round(learningMetrics.avgTimeToFix)}s`}
                      />
                      <MetricRow
                        label="Knowledge Reuse"
                        value={`${Math.round(learningMetrics.knowledgeReuseRate)}%`}
                      />
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Monitoring Status */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Radio className="h-5 w-5 text-primary" />
                    <CardTitle className="text-lg">Monitoring</CardTitle>
                  </div>
                  <Link href="/dashboard/monitoring">
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </Link>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {!monitoringStatus || monitoringStatus.monitoredRepos === 0 ? (
                  <div className="text-center py-2">
                    <p className="text-sm text-muted-foreground">No repositories monitored yet.</p>
                    <Link href="/dashboard/monitoring">
                      <Button variant="ghost" size="sm" className="mt-2">
                        <Radio className="mr-1 h-3 w-3" />
                        Set up monitoring
                      </Button>
                    </Link>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Status</span>
                      <Badge variant={monitoringStatus.isHealthy ? 'default' : 'secondary'}>
                        {monitoringStatus.isHealthy ? 'Active' : 'Inactive'}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Monitored Repos</span>
                      <span className="font-medium">{monitoringStatus.monitoredRepos}</span>
                    </div>
                    {monitoringStatus.lastRun && (
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Last Run</span>
                        <span className="text-sm">{formatTimeAgo(monitoringStatus.lastRun)}</span>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </motion.section>
        </div>
      </main>
    </div>
  );
}

// Stat Card Component
function StatCard({
  title,
  value,
  description,
  icon: Icon,
  href,
  trend,
}: {
  title: string;
  value: string | number;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  trend?: { value: number; isPositive: boolean };
}) {
  return (
    <Link href={href}>
      <div className="h-full cursor-pointer rounded-2xl border border-border/80 bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-primary/20 hover:shadow-lg">
        <div className="flex items-start justify-between">
          <div className="rounded-xl bg-primary/10 p-2">
            <Icon className="h-4 w-4 text-primary" />
          </div>
          {trend && (
            <div className={`flex items-center text-xs font-medium ${trend.isPositive ? 'text-emerald-500' : 'text-red-500'}`}>
              {trend.isPositive ? '↑' : '↓'} {trend.value}%
            </div>
          )}
        </div>
        <div className="mt-3">
          <p className="tabular-nums text-2xl font-bold">{value}</p>
          <p className="text-sm text-muted-foreground">{title}</p>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
    </Link>
  );
}

// Quick Action Button Component
function QuickActionButton({
  href,
  icon: Icon,
  label,
  description,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-2xl border border-border/80 p-3 transition-colors hover:bg-accent"
    >
      <div className="rounded-xl bg-primary/10 p-2">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </Link>
  );
}

// Metric Row Component
function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
