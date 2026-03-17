import { NextResponse } from 'next/server';
import { getMetricsComparison } from '@/lib/redis/metrics-store';
import { getKnowledgeBase } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const comparison = await getMetricsComparison('global', 'week');
    const kb = getKnowledgeBase();
    await kb.init();
    const kbStats = await kb.getStats();

    const current = comparison?.current;
    const previous = comparison?.previous;

    const currentFirstTry =
      current && current.totalRuns > 0
        ? (current.successfulPatches / current.totalRuns) * 100
        : 0;
    const previousFirstTry =
      previous && previous.totalRuns > 0
        ? (previous.successfulPatches / previous.totalRuns) * 100
        : 0;

    const knowledgeReuseRate =
      kbStats.totalFailures > 0
        ? (kbStats.successfulFixes / kbStats.totalFailures) * 100
        : 0;

    return NextResponse.json({
      passRate: current?.passRate ?? 0,
      previousPassRate: previous?.passRate ?? 0,
      avgTimeToFix: (current?.avgTimeToFix ?? 0) / 1000,
      previousAvgTimeToFix: (previous?.avgTimeToFix ?? 0) / 1000,
      firstTryRate: currentFirstTry,
      previousFirstTryRate: previousFirstTry,
      knowledgeReuseRate,
      previousKnowledgeReuseRate: 0,
      improvementPercent: comparison?.changes?.passRate ?? 0,
    });
  } catch (error) {
    console.error('Error fetching learning metrics:', error);
    return NextResponse.json({
      passRate: 0,
      previousPassRate: 0,
      avgTimeToFix: 0,
      previousAvgTimeToFix: 0,
      firstTryRate: 0,
      previousFirstTryRate: 0,
      knowledgeReuseRate: 0,
      previousKnowledgeReuseRate: 0,
      improvementPercent: 0,
    });
  }
}
