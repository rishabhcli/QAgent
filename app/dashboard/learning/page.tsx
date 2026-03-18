'use client';

import { useCallback, useEffect, useState } from 'react';
import { Brain, Loader2, RefreshCw, Sparkles, TrendingUp } from 'lucide-react';
import { Header } from '@/components/dashboard/header';
import { LearningCurveChart } from '@/components/dashboard/learning-curve-chart';
import { ImprovementMetricCard } from '@/components/dashboard/improvement-metric-card';
import { KnowledgeBaseStats } from '@/components/dashboard/knowledge-base-stats';
import { RecentLearnings } from '@/components/dashboard/recent-learnings';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toaster';

interface Metrics {
  passRate?: number;
  previousPassRate?: number;
  avgTimeToFix?: number;
  previousAvgTimeToFix?: number;
  firstTryRate?: number;
  previousFirstTryRate?: number;
  knowledgeReuseRate?: number;
  previousKnowledgeReuseRate?: number;
  improvementPercent?: number;
}

interface TrendData {
  labels: string[];
  passRates: number[];
  timeToFix?: number[];
}

interface KBStats {
  totalPatterns: number;
  totalFixes: number;
  successfulFixes: number;
  byType: Record<string, number>;
}

export default function LearningPage() {
  const { error: showError, success } = useToast();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [trend, setTrend] = useState<TrendData | null>(null);
  const [kbStats, setKbStats] = useState<KBStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchData = useCallback(async (showRefreshToast = false) => {
    try {
      const [metricsRes, trendRes, kbRes] = await Promise.all([
        fetch('/api/learning/metrics'),
        fetch('/api/learning/trend'),
        fetch('/api/learning/knowledge-base'),
      ]);

      if (!metricsRes.ok || !trendRes.ok || !kbRes.ok) {
        throw new Error('Failed to load learning data');
      }

      const [m, t, k] = await Promise.all([metricsRes.json(), trendRes.json(), kbRes.json()]);
      setMetrics(m);
      setTrend(t);
      setKbStats(k);

      if (showRefreshToast) {
        success('Learning metrics refreshed');
      }
    } catch {
      showError('Failed to load learning data', 'QAgent could not fetch self-improvement metrics.');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [showError, success]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <Header title="Learning" />
        <div className="flex h-96 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header title="Learning" />

      <main className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
        <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">Self-improvement signals</p>
            <p className="text-sm text-muted-foreground">
              Track how QAgent reuses prior knowledge, improves pass rate, and shortens time to a verified fix.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="rounded-2xl border border-primary/20 bg-primary/10 px-4 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
                Weekly Lift
              </p>
              <p className="mt-1 flex items-center gap-2 text-lg font-semibold text-foreground">
                <TrendingUp className="h-4 w-4 text-primary" />
                +{metrics?.improvementPercent ?? 0}%
              </p>
            </div>
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
          </div>
        </section>

        {trend?.labels?.length ? (
          <>
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <ImprovementMetricCard
                title="Pass Rate"
                current={metrics?.passRate ?? 0}
                previous={metrics?.previousPassRate ?? 0}
                unit="%"
              />
              <ImprovementMetricCard
                title="Avg Time to Fix"
                current={metrics?.avgTimeToFix ?? 0}
                previous={metrics?.previousAvgTimeToFix ?? 0}
                unit="s"
                lowerIsBetter
              />
              <ImprovementMetricCard
                title="First-Try Success"
                current={metrics?.firstTryRate ?? 0}
                previous={metrics?.previousFirstTryRate ?? 0}
                unit="%"
              />
              <ImprovementMetricCard
                title="Knowledge Reuse"
                current={metrics?.knowledgeReuseRate ?? 0}
                previous={metrics?.previousKnowledgeReuseRate ?? 0}
                unit="%"
              />
            </section>

            <Card className="border-border/80 shadow-sm">
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Brain className="h-5 w-5 text-primary" />
                    Learning Curve
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Rolling performance for the last 30 days across validation and reuse metrics.
                  </p>
                </div>
                <div className="rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
                  30 day view
                </div>
              </CardHeader>
              <CardContent>
                <LearningCurveChart data={trend} />
              </CardContent>
            </Card>

            <section className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
              <KnowledgeBaseStats stats={kbStats} />
              <RecentLearnings />
            </section>
          </>
        ) : (
          <EmptyState
            icon={Sparkles}
            title="No learning data yet"
            description="Learning metrics appear once QAgent has completed enough runs to measure reuse and improvement trends."
            compact={false}
          />
        )}
      </main>
    </div>
  );
}
