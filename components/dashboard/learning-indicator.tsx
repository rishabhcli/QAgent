'use client';

import { useState, useEffect } from 'react';
import { Brain, Sparkles, TrendingUp, Database, Zap, WifiOff } from 'lucide-react';

interface KnowledgeBaseStats {
  available: boolean;
  totalBugsLearned: number;
  successfulFixes: number;
  learningEnabled: boolean;
}

interface LearningIndicatorProps {
  variant?: 'compact' | 'full';
  className?: string;
}

export function LearningIndicator({ variant = 'compact', className = '' }: LearningIndicatorProps) {
  const [stats, setStats] = useState<KnowledgeBaseStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    async function fetchStats() {
      try {
        const res = await fetch('/api/knowledge-base');
        if (res.ok) {
          const data = await res.json();
          setStats(data);
        } else {
          setError(true);
        }
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    }

    fetchStats();
  }, []);

  if (loading) {
    return (
      <div className={`animate-pulse ${className}`}>
        <div className="h-6 w-32 bg-muted rounded-full" />
      </div>
    );
  }

  // If Redis is not available or error occurred, show disabled state
  if (error || !stats?.available) {
    if (variant === 'compact') {
      return (
        <div
          className={`flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted/50 border border-border/50 ${className}`}
        >
          <WifiOff className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            Knowledge base offline
          </span>
        </div>
      );
    }
    return null;
  }

  if (variant === 'compact') {
    // Show actual stats or "Ready to learn" if no bugs yet
    if (stats.totalBugsLearned === 0) {
      return (
        <div
          className={`flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1.5 ${className}`}
        >
          <Brain className="h-4 w-4 text-primary" />
          <span className="text-sm text-primary">
            Ready to learn
          </span>
        </div>
      );
    }

    return (
      <div
        className={`flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1.5 ${className}`}
      >
        <Brain className="h-4 w-4 animate-pulse text-primary" />
        <span className="text-sm text-primary">
          Learning from <span className="font-semibold text-foreground">{stats.totalBugsLearned}</span> bugs
        </span>
      </div>
    );
  }

  // Full variant with more details
  return (
    <div
      className={`rounded-xl border border-primary/20 bg-[linear-gradient(135deg,hsl(var(--primary)/0.12),transparent_65%)] p-4 ${className}`}
    >
      <div className="flex items-center gap-3 mb-4">
        <div className="rounded-lg bg-primary/15 p-2">
          <Brain className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h3 className="font-semibold text-sm">Self-Improving AI</h3>
          <p className="text-xs text-muted-foreground">Learning from past bugs to fix future ones</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex items-center gap-2 p-2 rounded-lg bg-background/50">
          <Database className="h-4 w-4 text-sky-600 dark:text-sky-400" />
          <div>
            <div className="text-lg font-bold">{stats.totalBugsLearned}</div>
            <div className="text-xs text-muted-foreground">Bugs Learned</div>
          </div>
        </div>
        <div className="flex items-center gap-2 p-2 rounded-lg bg-background/50">
          <Zap className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <div>
            <div className="text-lg font-bold">{stats.successfulFixes}</div>
            <div className="text-xs text-muted-foreground">Fixes Applied</div>
          </div>
        </div>
      </div>

      {stats.totalBugsLearned > 0 && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Sparkles className="h-3 w-3 text-primary" />
          <span>
            {Math.round((stats.successfulFixes / stats.totalBugsLearned) * 100)}% fix success rate
          </span>
          <TrendingUp className="ml-auto h-3 w-3 text-emerald-600 dark:text-emerald-400" />
        </div>
      )}
    </div>
  );
}

export default LearningIndicator;
