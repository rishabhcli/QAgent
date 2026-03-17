/**
 * Weave Evaluation API
 *
 * Runs evaluations on historical run data and returns scores.
 * Enables tracking agent performance over time.
 */

import { NextResponse } from 'next/server';
import { isWeaveEnabled, getWeaveProjectUrl } from '@/lib/weave';
import { getAllRunsAsync } from '@/lib/dashboard/run-store';
import {
  runEvaluation,
  createDatasetFromRuns,
  generateEvaluationReport,
} from '@/lib/weave/evaluations';

export const dynamic = 'force-dynamic';

async function getHistoricalRuns() {
  const runs = await getAllRunsAsync();

  return runs.flatMap((run) =>
    run.testSpecs.map((testSpec, index) => {
      const testResult = run.testResults[index];

      return {
        testSpec: {
          ...testSpec,
          id: `${run.id}:${testSpec.id}`,
        },
        failureReport: testResult?.failureReport,
        success: testResult?.passed ?? run.status === 'completed',
        iterations: run.iteration || 1,
        durationMs: testResult?.duration ?? 0,
        usedSimilarFix: false,
        patch: run.patches[index],
        diagnosis: run.patches[index]
          ? {
              confidence: 0,
            }
          : undefined,
      };
    })
  );
}

/**
 * GET /api/weave/evaluate
 *
 * Returns the latest evaluation results
 */
export async function GET() {
  try {
    // Check if Weave is enabled
    if (!isWeaveEnabled()) {
      return NextResponse.json({
        enabled: false,
        message: 'Weave is not enabled. Set WANDB_API_KEY to enable evaluations.',
        results: null,
      });
    }

    const historicalRuns = await getHistoricalRuns();
    if (historicalRuns.length === 0) {
      return NextResponse.json({
        enabled: true,
        results: null,
        message: 'No historical run data available yet.',
        projectUrl: getWeaveProjectUrl(),
        timestamp: new Date().toISOString(),
      });
    }

    const dataset = createDatasetFromRuns(historicalRuns);

    const mockModel = async (input: unknown): Promise<Record<string, unknown>> => {
      const typedInput = input as { testSpec?: { id?: string } };
      const run = historicalRuns.find(
        (r) => r.testSpec.id === typedInput.testSpec?.id
      );
      return {
        success: run?.success ?? false,
        iterations: run?.iterations ?? 1,
        durationMs: run?.durationMs ?? 0,
        usedSimilarFix: run?.usedSimilarFix ?? false,
        patch: run?.patch,
        diagnosis: run?.diagnosis,
      };
    };

    // Run evaluation
    const results = await runEvaluation(dataset, mockModel, 'api_evaluation');

    // Generate report
    const report = generateEvaluationReport(results);

    return NextResponse.json({
      enabled: true,
      results: {
        scores: results.scores,
        weightedScore: results.weightedScore,
        summary: results.summary,
        report,
      },
      projectUrl: getWeaveProjectUrl(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Weave evaluate API error:', error);
    return NextResponse.json(
      { error: 'Failed to run evaluation' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/weave/evaluate
 *
 * Run a custom evaluation with provided data
 *
 * Body:
 * - runs: Array of historical runs to evaluate
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { runs } = body;

    if (!runs || !Array.isArray(runs)) {
      return NextResponse.json(
        { error: 'runs array is required' },
        { status: 400 }
      );
    }

    // Check if Weave is enabled
    if (!isWeaveEnabled()) {
      return NextResponse.json({
        enabled: false,
        message: 'Weave is not enabled. Set WANDB_API_KEY to enable evaluations.',
        results: null,
      });
    }

    // Create dataset from provided runs
    const dataset = createDatasetFromRuns(runs);

    // Create model that returns the actual run results
    const model = async (input: unknown): Promise<Record<string, unknown>> => {
      const typedInput = input as { testSpec?: { id?: string } };
      const run = runs.find(
        (r: { testSpec?: { id?: string } }) =>
          r.testSpec?.id === typedInput.testSpec?.id
      );
      return {
        success: run?.success ?? false,
        iterations: run?.iterations ?? 1,
        durationMs: run?.durationMs ?? 0,
        usedSimilarFix: run?.usedSimilarFix ?? false,
        patch: run?.patch,
        diagnosis: run?.diagnosis,
      };
    };

    // Run evaluation
    const results = await runEvaluation(dataset, model, 'custom_evaluation');

    // Generate report
    const report = generateEvaluationReport(results);

    return NextResponse.json({
      enabled: true,
      results: {
        scores: results.scores,
        weightedScore: results.weightedScore,
        summary: results.summary,
        report,
      },
      projectUrl: getWeaveProjectUrl(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Weave evaluate API error:', error);
    return NextResponse.json(
      { error: 'Failed to run evaluation' },
      { status: 500 }
    );
  }
}
