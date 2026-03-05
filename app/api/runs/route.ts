import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  createRun,
  getAllRuns,
  getRunStats,
  updateRunStatus,
  updateRunAgent,
  updateRunSession,
  addRunPatch,
} from '@/lib/dashboard/run-store';

export const dynamic = 'force-dynamic';
import {
  emitRunStarted,
  emitAgentStarted,
  emitAgentCompleted,
  emitPatchGenerated,
  emitRunCompleted,
  emitRunError,
  emitSessionStarted,
  sseEmitter,
} from '@/lib/dashboard/sse-emitter';
import { Orchestrator } from '@/agents/orchestrator';
import { CrawlerAgent } from '@/agents/crawler';
import { CodeAnalyzerAgent } from '@/agents/analyzer';
import { FixerAgent } from '@/agents/fixer';
import { createPatchPR } from '@/lib/github/patches';
import {
  cloneAndInstall,
  setupLocalRepo,
  cleanupRepo,
} from '@/lib/git';
import type { AgentType, Patch, DiagnosisReport, ClonedRepo } from '@/lib/types';

// GET /api/runs - List all runs with optional pagination and filtering
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));
  const statusFilter = searchParams.get('status') as import('@/lib/types').RunStatus | null;
  const repoIdFilter = searchParams.get('repoId');
  const searchQuery = searchParams.get('search');

  let runs = getAllRuns();

  if (statusFilter) {
    runs = runs.filter((r) => r.status === statusFilter);
  }
  if (repoIdFilter) {
    runs = runs.filter((r) => r.repoId === repoIdFilter);
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    runs = runs.filter(
      (r) =>
        r.repoName.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q)
    );
  }

  const total = runs.length;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const paginatedRuns = runs.slice(offset, offset + limit);
  const stats = getRunStats();

  return NextResponse.json({
    runs: paginatedRuns.map((run) => ({
      id: run.id,
      repoId: run.repoId,
      repoName: run.repoName,
      status: run.status,
      currentAgent: run.currentAgent,
      iteration: run.iteration,
      maxIterations: run.maxIterations,
      testsTotal: run.testSpecs.length,
      testsPassed: run.testResults.filter((r) => r.passed).length,
      patchesApplied: run.patches.length,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
    stats,
  });
}

// POST /api/runs - Start a new run
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const {
      repoId,
      repoName,
      testSpecs,
      maxIterations = 5,
      targetUrl, // OPTIONAL - for additional browser testing
      cloudMode = false,
    } = body;

    // In cloud mode, require a repository (targetUrl is optional)
    if (cloudMode && !repoName) {
      return NextResponse.json(
        { error: 'Repository is required' },
        { status: 400 }
      );
    }

    // Get GitHub access token from session for cloud mode
    let githubToken: string | undefined;
    if (cloudMode) {
      const session = await getSession();
      if (session?.accessToken) {
        githubToken = session.accessToken;
        // eslint-disable-next-line no-console
        console.log(`[API/runs] Got GitHub token for user: ${session.user?.login || 'unknown'}`);
      } else {
        // eslint-disable-next-line no-console
        console.log('[API/runs] No GitHub token found in session');
      }
    }

    const run = createRun({
      repoId: repoId || 'local',
      repoName: repoName || 'Demo App',
      testSpecs: testSpecs || [],
      maxIterations,
    });

    // Emit SSE event - run starting
    emitRunStarted(run.id);
    updateRunStatus(run.id, 'running');

    // Start the CODE-FOCUSED orchestrator
    // eslint-disable-next-line no-console
    console.log(`[API/runs] cloudMode=${cloudMode}, repoName=${repoName}, hasToken=${!!githubToken}`);

    if (cloudMode && repoName && githubToken) {
      // CODE-FIRST: Clone repo, analyze code, fix issues, create PRs
      // Optional: If targetUrl provided, also run browser tests
      // eslint-disable-next-line no-console
      console.log(`[API/runs] Starting CODE-FIRST orchestrator for ${repoName}`);
      runCodeFirstOrchestrator(run.id, repoName, maxIterations, githubToken, targetUrl);
    } else {
      // Fallback to local mode
      // eslint-disable-next-line no-console
      console.log(`[API/runs] Falling back to LOCAL orchestrator (cloudMode=${cloudMode}, repoName=${repoName}, hasToken=${!!githubToken})`);
      const localTargetUrl = targetUrl || process.env.TARGET_URL || 'http://localhost:3000';
      runLocalOrchestrator(run.id, testSpecs || [], maxIterations, localTargetUrl);
    }

    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Error creating run:', error);
    return NextResponse.json(
      { error: 'Failed to create run' },
      { status: 500 }
    );
  }
}

/**
 * CODE-FIRST Orchestrator
 *
 * This is the main workflow - focused on CODE, not UI:
 * 1. Clone the GitHub repository
 * 2. Install dependencies
 * 3. ANALYZE THE CODE - TypeScript errors, ESLint, build failures
 * 4. FIX THE CODE - generate patches for issues found
 * 5. Create PRs with the fixes
 * 6. (Optional) If targetUrl provided, also run browser tests
 */
async function runCodeFirstOrchestrator(
  runId: string,
  repoFullName: string,
  maxIterations: number,
  githubToken: string,
  targetUrl?: string // OPTIONAL - for additional browser testing
) {
  let clonedRepo: ClonedRepo | null = null;
  const browserTestUrl = targetUrl;

  // eslint-disable-next-line no-console
  console.log(`\n🚀 Starting CODE-FIRST QAgent run ${runId}`);
  // eslint-disable-next-line no-console
  console.log(`   Repo: ${repoFullName}`);
  // eslint-disable-next-line no-console
  console.log(`   Mode: CODE ANALYSIS`);
  if (browserTestUrl) {
    // eslint-disable-next-line no-console
    console.log(`   Optional URL: ${browserTestUrl}`);
  } else {
    // eslint-disable-next-line no-console
    console.log('   Optional URL: (none) - browser tests will be skipped');
  }

  try {
    // 1. CLONE THE REPO
    sseEmitter.emit({
      type: 'status',
      timestamp: new Date(),
      runId,
      data: { status: 'running', message: 'Cloning repository...' },
    });

    // Clone and install only - no dev server needed for code analysis
    try {
      clonedRepo = await cloneAndInstall(repoFullName, githubToken);
    } catch (cloneError) {
      // eslint-disable-next-line no-console
      console.error(`❌ Failed to clone repository:`, cloneError);
      throw new Error(`Failed to clone ${repoFullName}: ${cloneError instanceof Error ? cloneError.message : 'Unknown error'}`);
    }

    // eslint-disable-next-line no-console
    console.log(`   Cloned to: ${clonedRepo.repoPath}`);

    // 2. ANALYZE THE CODE
    sseEmitter.emit({
      type: 'status',
      timestamp: new Date(),
      runId,
      data: { status: 'running', message: 'Analyzing code...' },
    });

    emitAgentStarted(runId, 'tester');
    updateRunAgent(runId, 'tester');

    const analyzer = new CodeAnalyzerAgent(clonedRepo.repoPath);
    const analysisResult = await analyzer.analyze();

    // eslint-disable-next-line no-console
    console.log(`\n📊 Code Analysis Results:`);
    // eslint-disable-next-line no-console
    console.log(`   Errors: ${analysisResult.summary.errors}`);
    // eslint-disable-next-line no-console
    console.log(`   Warnings: ${analysisResult.summary.warnings}`);
    // eslint-disable-next-line no-console
    console.log(`   Files: ${analysisResult.summary.filesAnalyzed}`);

    emitAgentCompleted(runId, 'tester');

    // 3. FIX THE CODE
    const allPatches: Patch[] = [];

    if (analysisResult.issues.length > 0) {
      sseEmitter.emit({
        type: 'status',
        timestamp: new Date(),
        runId,
        data: { status: 'running', message: `Fixing ${analysisResult.issues.length} code issues...` },
      });

      emitAgentStarted(runId, 'triage');
      updateRunAgent(runId, 'triage');

      // Focus on errors first
      const errors = analysisResult.issues.filter(i => i.severity === 'error');
      const issuesToFix = errors.slice(0, maxIterations); // Limit to maxIterations

      // eslint-disable-next-line no-console
      console.log(`\n🔧 Fixing ${issuesToFix.length} code issues...`);

      emitAgentCompleted(runId, 'triage');
      emitAgentStarted(runId, 'fixer');
      updateRunAgent(runId, 'fixer');

      const fixer = new FixerAgent(clonedRepo.repoPath);

      for (const issue of issuesToFix) {
        try {
          // eslint-disable-next-line no-console
          console.log(`\n   Fixing: ${issue.file}:${issue.line} - ${issue.message.slice(0, 50)}...`);

          const diagnosis = analyzer.issueToDiagnosis(issue);
          const patchResult = await fixer.generatePatch(diagnosis);

          if (patchResult.success && patchResult.patch) {
            allPatches.push(patchResult.patch);
            addRunPatch(runId, patchResult.patch);
            emitPatchGenerated(runId, patchResult.patch);

            // eslint-disable-next-line no-console
            console.log(`   ✅ Generated fix: ${patchResult.patch.description}`);
          }
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(`   ❌ Failed to fix issue:`, error);
        }
      }

      emitAgentCompleted(runId, 'fixer');
    }

    // 4. CREATE PRs FOR FIXES
    if (allPatches.length > 0) {
      sseEmitter.emit({
        type: 'status',
        timestamp: new Date(),
        runId,
        data: { status: 'running', message: 'Creating pull requests...' },
      });

      emitAgentStarted(runId, 'verifier');
      updateRunAgent(runId, 'verifier');

      // eslint-disable-next-line no-console
      console.log(`\n📝 Creating PRs for ${allPatches.length} fixes...`);

      for (const patch of allPatches) {
        try {
          const result = await createPatchPR(
            githubToken,
            repoFullName,
            patch,
            {
              rootCause: `Code issue: ${patch.description}`,
              confidence: 0.9,
              suggestedFix: patch.description,
            }
          );

          // eslint-disable-next-line no-console
          console.log(`   ✓ PR created: ${result.prUrl}`);

          sseEmitter.emit({
            type: 'patch',
            timestamp: new Date(),
            runId,
            data: {
              patch,
              prUrl: result.prUrl,
              prNumber: result.prNumber,
              status: 'pr_created',
            },
          });
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(`   ❌ Failed to create PR:`, error);
        }
      }

      emitAgentCompleted(runId, 'verifier');
    }

    // 5. OPTIONAL: Run browser tests if URL provided
    if (browserTestUrl) {
      sseEmitter.emit({
        type: 'status',
        timestamp: new Date(),
        runId,
        data: { status: 'running', message: 'Running browser tests...' },
      });

      // eslint-disable-next-line no-console
      console.log(`\n🌐 Running optional browser tests on ${browserTestUrl}...`);

      try {
        const crawler = new CrawlerAgent();
        await crawler.init();
        const crawlerSessionId = crawler.getSessionId();
        if (crawlerSessionId) {
          updateRunSession(runId, crawlerSessionId);
          emitSessionStarted(runId, crawlerSessionId);
        }
        const flows = await crawler.discoverFlows(browserTestUrl, { maxPages: 3, maxDepth: 2 });
        const crawledSessionId = crawler.getSessionId();
        if (crawledSessionId) {
          updateRunSession(runId, crawledSessionId);
          emitSessionStarted(runId, crawledSessionId);
        }
        const testSpecs = crawler.flowsToTestSpecs(flows);
        await crawler.close();

        // eslint-disable-next-line no-console
        console.log(`   Discovered ${testSpecs.length} user flows`);

        // Run the orchestrator for browser tests
        if (testSpecs.length > 0) {
          const orchestrator = new Orchestrator({
            projectRoot: clonedRepo.repoPath,
            targetUrl: browserTestUrl,
            autoCommit: false,
            onSessionStarted: (sessionId) => {
              updateRunSession(runId, sessionId);
              emitSessionStarted(runId, sessionId);
            },
          });

          orchestrator.onPatchGenerated = async (patch: Patch, diagnosis: DiagnosisReport) => {
            try {
              const result = await createPatchPR(githubToken, repoFullName, patch, {
                rootCause: diagnosis.rootCause,
                confidence: diagnosis.confidence,
                suggestedFix: diagnosis.suggestedFix,
              });

              // eslint-disable-next-line no-console
              console.log(`   ✓ Browser test fix PR: ${result.prUrl}`);

              sseEmitter.emit({
                type: 'patch',
                timestamp: new Date(),
                runId,
                data: { patch, prUrl: result.prUrl, prNumber: result.prNumber, status: 'pr_created' },
              });
            } catch (error) {
              // eslint-disable-next-line no-console
              console.error('Failed to create browser test fix PR:', error);
            }
          };

          await orchestrator.run({
            maxIterations: 3,
            testSpecs,
            targetUrl: browserTestUrl,
          });
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Browser tests failed (continuing anyway):', error);
        // Don't fail the run, browser tests are optional
      }
    }

    // 6. COMPLETE
    const success = analysisResult.summary.errors === 0 || allPatches.length > 0;

    // eslint-disable-next-line no-console
    console.log(`\n✅ QAgent run complete`);
    // eslint-disable-next-line no-console
    console.log(`   Issues found: ${analysisResult.issues.length}`);
    // eslint-disable-next-line no-console
    console.log(`   Fixes created: ${allPatches.length}`);

    updateRunStatus(runId, success ? 'completed' : 'failed');
    emitRunCompleted(runId, success);

  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error in CODE-FIRST run ${runId}:`, error);
    updateRunStatus(runId, 'failed');
    emitRunError(runId, error instanceof Error ? error.message : 'Unknown error');
  } finally {
    // Always cleanup
    if (clonedRepo) {
      try {
        await cleanupRepo(clonedRepo);
      } catch (cleanupError) {
        // eslint-disable-next-line no-console
        console.error('Failed to cleanup:', cleanupError);
      }
    }
  }
}

/**
 * Run the orchestrator locally (original mode)
 */
async function runLocalOrchestrator(
  runId: string, 
  testSpecs: Array<{ id: string; name: string; url: string; steps: Array<{ action: string; expected?: string }> }>,
  maxIterations: number,
  targetUrl?: string
) {
  const appTargetUrl = targetUrl || process.env.TARGET_URL || 'http://localhost:3002';
  
  try {
    // eslint-disable-next-line no-console
    console.log(`\n🚀 Starting QAgent local run ${runId}\n   Target: ${appTargetUrl}\n   Tests: ${testSpecs.length}\n   Max iterations: ${maxIterations}\n`);
    
    const emitAgentProgress = (agent: AgentType, status: 'started' | 'completed') => {
      if (status === 'started') {
        updateRunAgent(runId, agent);
        emitAgentStarted(runId, agent);
      } else {
        emitAgentCompleted(runId, agent);
      }
    };

    // Start with tester
    emitAgentProgress('tester', 'started');
    
    // Create and run orchestrator
    const orchestrator = new Orchestrator({
      onSessionStarted: (sessionId) => {
        updateRunSession(runId, sessionId);
        emitSessionStarted(runId, sessionId);
      },
    });
    
    const result = await orchestrator.run({
      maxIterations,
      testSpecs,
      targetUrl: appTargetUrl,
    });

    // Update run with results
    if (result.success) {
      updateRunStatus(runId, 'completed');
      emitRunCompleted(runId, true);
    } else {
      updateRunStatus(runId, 'failed');
      emitRunCompleted(runId, false);
    }

    // Add patches to run store
    if (result.patches && result.patches.length > 0) {
      for (const patch of result.patches) {
        addRunPatch(runId, patch);
        emitPatchGenerated(runId, patch);
      }
    }

  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error in orchestrator run ${runId}:`, error);
    updateRunStatus(runId, 'failed');
    emitRunError(runId, error instanceof Error ? error.message : 'Unknown error');
  }
}
