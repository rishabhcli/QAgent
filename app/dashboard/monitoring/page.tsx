'use client';

import { useState, useEffect, useCallback } from 'react';
import { Radio, RefreshCw } from 'lucide-react';
import { Header } from '@/components/dashboard/header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { RepoConfigCard } from '@/components/monitoring/repo-config-card';
import { MetricsChart } from '@/components/monitoring/metrics-chart';
import { WebhookSetup } from '@/components/monitoring/webhook-setup';
import { AddRepoDialog } from '@/components/monitoring/add-repo-dialog';
import { ActivityFeed } from '@/components/monitoring/activity-feed';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toaster';
import type {
  MonitoringConfig,
  MonitoringSchedule,
  ImprovementMetrics,
  QueuedRun,
  GitHubRepo,
} from '@/lib/types';

export default function MonitoringPage() {
  const { error: showError, success } = useToast();
  const [configs, setConfigs] = useState<MonitoringConfig[]>([]);
  const [metrics, setMetrics] = useState<ImprovementMetrics[]>([]);
  const [recentRuns, setRecentRuns] = useState<QueuedRun[]>([]);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const fetchData = useCallback(async (showRefreshToast = false) => {
    try {
      const [configsRes, metricsRes, queueRes, reposRes] = await Promise.all([
        fetch('/api/monitoring/configs').catch(() => null),
        fetch('/api/monitoring/metrics').catch(() => null),
        fetch('/api/monitoring/queue').catch(() => null),
        fetch('/api/auth/session').catch(() => null),
      ]);

      if (configsRes?.ok) {
        const data = await configsRes.json();
        const nextConfigs = data.configs || [];
        setConfigs(nextConfigs);
        setSelectedRepo((current) => current || nextConfigs[0]?.repoId || null);
      }

      if (metricsRes?.ok) {
        const data = await metricsRes.json();
        setMetrics(data.metrics || []);
      }

      if (queueRes?.ok) {
        const data = await queueRes.json();
        setRecentRuns(data.items || []);
      }

      if (reposRes?.ok) {
        const data = await reposRes.json();
        setRepos(data.repos || []);
      }

      setError(null);
      if (showRefreshToast) {
        success('Monitoring data refreshed');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load monitoring data';
      setError(message);
      showError('Failed to load monitoring data', 'PatchPilot could not refresh repository monitoring.');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [showError, success]);

  useEffect(() => {
    if (mounted) {
      void fetchData();
    }
  }, [fetchData, mounted]);

  const handleToggle = async (repoId: string, enabled: boolean) => {
    const res = await fetch(`/api/monitoring/configs/${repoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });

    if (res.ok) {
      const updated = await res.json();
      setConfigs((prev) => prev.map((config) => (config.repoId === repoId ? updated.config : config)));
      success(enabled ? 'Monitoring enabled' : 'Monitoring paused');
      return;
    }

    showError('Failed to update monitoring state');
  };

  const handleScheduleChange = async (repoId: string, schedule: MonitoringSchedule) => {
    const res = await fetch(`/api/monitoring/configs/${repoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule }),
    });

    if (res.ok) {
      const updated = await res.json();
      setConfigs((prev) => prev.map((config) => (config.repoId === repoId ? updated.config : config)));
      success('Monitoring schedule updated');
      return;
    }

    showError('Failed to update monitoring schedule');
  };

  const handleDelete = async (repoId: string) => {
    const res = await fetch(`/api/monitoring/configs/${repoId}`, {
      method: 'DELETE',
    });

    if (res.ok) {
      setConfigs((prev) => prev.filter((config) => config.repoId !== repoId));
      if (selectedRepo === repoId) {
        setSelectedRepo(null);
      }
      success('Monitoring removed');
      return;
    }

    showError('Failed to remove repository monitoring');
  };

  const handleAddRepo = async (
    repoId: string,
    repoFullName: string,
    schedule: MonitoringSchedule
  ) => {
    const res = await fetch('/api/monitoring/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoId, repoFullName, schedule }),
    });

    if (res.ok) {
      const data = await res.json();
      setConfigs((prev) => [...prev, data.config]);
      setSelectedRepo(repoId);
      success('Repository added to monitoring');
      return;
    }

    showError('Failed to add repository monitoring');
  };

  const webhookUrl = mounted ? `${window.location.origin}/api/webhooks/github` : '';
  const selectedConfig = selectedRepo ? configs.find((config) => config.repoId === selectedRepo) : null;

  if (!mounted || isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <Header title="Monitoring" />
        <div className="space-y-6 p-6 lg:p-8">
          <div className="flex items-center justify-between">
            <Skeleton className="h-10 w-72" />
            <Skeleton className="h-10 w-32" />
          </div>
          <div className="grid gap-4">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header title="Monitoring" />

      <main className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
        <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">Continuous monitoring</p>
            <p className="text-sm text-muted-foreground">
              Keep selected repositories under watch, trigger runs on schedule, and wire GitHub webhooks once per repo.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setIsRefreshing(true);
                void fetchData(true);
              }}
              disabled={isRefreshing}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <AddRepoDialog
              repos={repos}
              existingRepoIds={configs.map((config) => config.repoId)}
              onAdd={handleAddRepo}
            />
          </div>
        </section>

        {error && (
          <Card className="border-destructive/20 bg-destructive/5">
            <CardContent className="flex items-center justify-between gap-4 p-4">
              <div>
                <p className="font-medium text-destructive">Monitoring data is unavailable</p>
                <p className="text-sm text-muted-foreground">{error}</p>
              </div>
              <Button variant="outline" onClick={() => void fetchData()}>
                Retry
              </Button>
            </CardContent>
          </Card>
        )}

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-foreground">Monitored repositories</h2>
            <div className="rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
              {configs.length} configured
            </div>
          </div>

          {configs.length === 0 ? (
            <EmptyState
              icon={Radio}
              title="No repositories configured"
              description="Add a repository to start scheduled monitoring, webhook-triggered runs, and automated improvement tracking."
            />
          ) : (
            <div className="grid gap-4">
              {configs.map((config) => (
                <div key={config.repoId} onClick={() => setSelectedRepo(config.repoId)} className="cursor-pointer">
                  <RepoConfigCard
                    config={config}
                    onToggle={(enabled) => handleToggle(config.repoId, enabled)}
                    onScheduleChange={(schedule) => handleScheduleChange(config.repoId, schedule)}
                    onDelete={() => handleDelete(config.repoId)}
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        <MetricsChart metrics={metrics} title="Improvement Trends (Last 30 Days)" />

        <section className="grid gap-6 xl:grid-cols-2">
          {selectedConfig ? (
            <WebhookSetup
              repoFullName={selectedConfig.repoFullName}
              webhookUrl={webhookUrl}
              webhookSecret={selectedConfig.webhookSecret}
            />
          ) : (
            <EmptyState
              icon={Radio}
              title="Select a repository"
              description="Choose a monitored repository to see webhook instructions and configuration details."
              compact
            />
          )}

          <ActivityFeed recentRuns={recentRuns} />
        </section>
      </main>
    </div>
  );
}
