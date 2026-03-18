'use client';

import { useState, useEffect, type ReactNode } from 'react';
import {
  ExternalLink,
  Activity,
  BarChart3,
  Database,
  MessageSquare,
  Cpu,
  CheckCircle2,
  XCircle,
  RefreshCw,
} from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { Button } from '@/components/ui/button';

interface WeaveStatus {
  enabled: boolean;
  projectUrl: string | null;
  features: {
    tracing: boolean;
    evaluations: boolean;
    datasets: boolean;
    feedback: boolean;
    models: boolean;
    selfImprove: boolean;
  };
  metrics: {
    totalTraces: number;
    successRate: number;
    avgDuration: number;
  };
}

interface EvaluationResultData {
  weightedScore: number;
  summary: {
    passRate: number;
    avgIterations: number;
    avgDurationMs: number;
  };
}

/**
 * Comprehensive Weave Status Display
 *
 * Shows all Weave features being used in QAgent:
 * - Tracing (op wrapper)
 * - Evaluations (custom scorers)
 * - Datasets (run history)
 * - Feedback (user ratings)
 * - Models (agent versioning)
 * - Self-Improvement (trace analysis)
 */
export function WeaveStatus() {
  const [status, setStatus] = useState<WeaveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [evaluationResult, setEvaluationResult] = useState<EvaluationResultData | null>(null);
  const [runningEval, setRunningEval] = useState(false);

  useEffect(() => {
    async function fetchStatus() {
      try {
        const response = await fetch('/api/weave/metrics');
        if (!response.ok) throw new Error('Failed to fetch');
        const data = await response.json();

        setStatus({
          enabled: data.enabled,
          projectUrl: data.links?.project || data.metrics?.links?.project || null,
          features: {
            tracing: true,
            evaluations: true,
            datasets: true,
            feedback: true,
            models: true,
            selfImprove: true,
          },
          metrics: {
            totalTraces: data.metrics?.overall?.totalRuns || 0,
            successRate: data.metrics?.overall?.successfulRuns
              ? data.metrics.overall.successfulRuns /
                (data.metrics.overall.totalRuns || 1)
              : 0,
            avgDuration: data.metrics?.overall?.avgDurationMs || 0,
          },
        });
      } catch (err) {
        console.error('Failed to fetch Weave status:', err);
        setStatus({
          enabled: false,
          projectUrl: null,
          features: {
            tracing: false,
            evaluations: false,
            datasets: false,
            feedback: false,
            models: false,
            selfImprove: false,
          },
          metrics: { totalTraces: 0, successRate: 0, avgDuration: 0 },
        });
      } finally {
        setLoading(false);
      }
    }

    fetchStatus();
  }, []);

  async function runEvaluation() {
    setRunningEval(true);
    try {
      const response = await fetch('/api/weave/evaluate');
      if (!response.ok) throw new Error('Failed to run evaluation');
      const data = await response.json();
      setEvaluationResult(data.results);
    } catch (err) {
      console.error('Evaluation failed:', err);
    } finally {
      setRunningEval(false);
    }
  }

  if (loading) {
    return (
      <GlassCard className="p-6">
        <div className="flex items-center gap-3">
          <RefreshCw className="h-5 w-5 animate-spin text-violet-400" />
          <span className="text-muted-foreground">Loading Weave status...</span>
        </div>
      </GlassCard>
    );
  }

  return (
    <GlassCard className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-gradient-to-br from-yellow-500/20 to-orange-500/20">
            <Activity className="h-5 w-5 text-yellow-400" />
          </div>
          <div>
            <h3 className="font-semibold">W&B Weave Integration</h3>
            <p className="text-xs text-muted-foreground">
              W&B Weave observability integration
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {status?.enabled ? (
            <span className="flex items-center gap-1 text-xs text-green-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Connected
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-red-400">
              <XCircle className="h-3.5 w-3.5" />
              Not Connected
            </span>
          )}
        </div>
      </div>

      {/* Features Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <FeatureCard
          icon={<Activity className="h-4 w-4" />}
          name="Tracing"
          description="All agent operations traced with op()"
          enabled={status?.features.tracing || false}
        />
        <FeatureCard
          icon={<BarChart3 className="h-4 w-4" />}
          name="Evaluations"
          description="7 custom scorers for quality metrics"
          enabled={status?.features.evaluations || false}
        />
        <FeatureCard
          icon={<Database className="h-4 w-4" />}
          name="Datasets"
          description="Run history stored for analysis"
          enabled={status?.features.datasets || false}
        />
        <FeatureCard
          icon={<MessageSquare className="h-4 w-4" />}
          name="Feedback"
          description="User feedback tracked in traces"
          enabled={status?.features.feedback || false}
        />
        <FeatureCard
          icon={<Cpu className="h-4 w-4" />}
          name="Models"
          description="Agent versioning for A/B testing"
          enabled={status?.features.models || false}
        />
        <FeatureCard
          icon={<RefreshCw className="h-4 w-4" />}
          name="Self-Improve"
          description="Automatic prompt optimization"
          enabled={status?.features.selfImprove || false}
        />
      </div>

      {/* Empty metrics state */}
      {status && status.metrics.totalTraces === 0 && status.metrics.successRate === 0 && status.metrics.avgDuration === 0 && (
        <div className="rounded-lg border border-border/50 bg-card/30 p-4 text-center">
          <p className="text-sm text-muted-foreground">No trace data yet. Run your first pipeline to see metrics here.</p>
        </div>
      )}

      {/* Quick Actions */}
      <div className="flex flex-wrap gap-2">
        {status?.projectUrl && (
          <a
            href={status.projectUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button variant="outline" size="sm" className="gap-2">
              <ExternalLink className="h-3.5 w-3.5" />
              View in Weave
            </Button>
          </a>
        )}
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={runEvaluation}
          disabled={runningEval || !status?.enabled}
        >
          {runningEval ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <BarChart3 className="h-3.5 w-3.5" />
          )}
          Run Evaluation
        </Button>
      </div>

      {/* Evaluation Results */}
      {evaluationResult && (
        <div className="p-4 rounded-lg bg-card/50 border border-border/50">
          <h4 className="text-sm font-medium mb-3">Latest Evaluation</h4>
          <div className="grid grid-cols-4 gap-4 text-center">
            <div>
              <div className="text-lg font-bold text-violet-400">
                {((evaluationResult.weightedScore ?? 0) * 100).toFixed(0)}%
              </div>
              <div className="text-[10px] text-muted-foreground">
                Weighted Score
              </div>
            </div>
            <div>
              <div className="text-lg font-bold text-green-400">
                {((evaluationResult.summary?.passRate ?? 0) * 100).toFixed(0)}%
              </div>
              <div className="text-[10px] text-muted-foreground">Pass Rate</div>
            </div>
            <div>
              <div className="text-lg font-bold text-cyan-400">
                {(evaluationResult.summary?.avgIterations ?? 0).toFixed(1)}
              </div>
              <div className="text-[10px] text-muted-foreground">
                Avg Iterations
              </div>
            </div>
            <div>
              <div className="text-lg font-bold text-amber-400">
                {((evaluationResult.summary?.avgDurationMs ?? 0) / 1000).toFixed(1)}s
              </div>
              <div className="text-[10px] text-muted-foreground">
                Avg Duration
              </div>
            </div>
          </div>
        </div>
      )}
    </GlassCard>
  );
}

function FeatureCard({
  icon,
  name,
  description,
  enabled,
}: {
  icon: ReactNode;
  name: string;
  description: string;
  enabled: boolean;
}) {
  return (
    <div
      className={`p-3 rounded-lg border transition-colors ${
        enabled
          ? 'bg-card/50 border-green-500/30 hover:border-green-500/50'
          : 'bg-card/20 border-border/30 opacity-50'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={enabled ? 'text-green-400' : 'text-muted-foreground'}>
          {icon}
        </span>
        <span className="text-sm font-medium">{name}</span>
        {enabled && (
          <CheckCircle2 className="h-3 w-3 text-green-400 ml-auto" />
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">{description}</p>
    </div>
  );
}
