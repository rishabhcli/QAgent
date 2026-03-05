/**
 * Orchestrator
 *
 * Coordinates the QAgent loop:
 * Tester → Triage → Fixer → Verifier → (repeat if needed)
 *
 * Implements the core self-healing QA agent workflow.
 * Instrumented with W&B Weave for observability.
 */

import type {
  OrchestratorConfig,
  OrchestratorResult,
  TestSpec,
  Patch,
  DiagnosisReport,
  FailedAttempt,
  Orchestrator as IOrchestrator,
} from '@/lib/types';
import { TesterAgent } from '@/agents/tester';
import { TriageAgent } from '@/agents/triage';
import { FixerAgent } from '@/agents/fixer';
import { VerifierAgent } from '@/agents/verifier';
import { initWeave, op, isWeaveEnabled, getWeaveProjectUrl, weave } from '@/lib/weave';
import { logRunMetrics, type RunMetrics } from '@/lib/weave/metrics';
import { storeRunInDataset, type RunDatasetRow } from '@/lib/weave/datasets';
import { isTraceTriageEnabled, isRedTeamEnabled } from '@/lib/config';

// Callback for when patches are generated (used in cloud mode to create PRs)
export type PatchGeneratedCallback = (patch: Patch, diagnosis: DiagnosisReport) => Promise<void>;

// Callback for when patches are applied locally
export type PatchAppliedCallback = (patch: Patch, success: boolean) => void;

interface IterationResult {
  testId: string;
  iteration: number;
  testerPassed: boolean;
  triageDiagnosis?: string;
  fixerPatch?: Patch;
  verifierPassed?: boolean;
  error?: string;
}

export interface OrchestratorOptions {
  projectRoot?: string;
  targetUrl?: string;
  autoCommit?: boolean;
  onSessionStarted?: (sessionId: string) => void;
  signal?: AbortSignal;
}

export class Orchestrator implements IOrchestrator {
  private projectRoot: string;
  private targetUrl: string;
  private testerAgent: TesterAgent;
  private triageAgent: TriageAgent;
  private fixerAgent: FixerAgent;
  private verifierAgent: VerifierAgent;
  private lastSessionId: string | null = null;
  private signal?: AbortSignal;

  // Optional callback for cloud mode - creates PRs when patches are generated
  public onPatchGenerated?: PatchGeneratedCallback;

  // Optional callback for local mode - notifies when patches are applied
  public onPatchApplied?: PatchAppliedCallback;

  // Optional callback when a Browserbase session is available
  public onSessionStarted?: (sessionId: string) => void;

  constructor(options: OrchestratorOptions = {}) {
    const projectRoot = options.projectRoot || process.cwd();
    const targetUrl = options.targetUrl || process.env.TARGET_URL || 'http://localhost:3000';
    const autoCommit = options.autoCommit ?? false; // Default to false for clone-first mode

    this.projectRoot = projectRoot;
    this.targetUrl = targetUrl;

    this.testerAgent = new TesterAgent();
    this.triageAgent = new TriageAgent(projectRoot);
    this.fixerAgent = new FixerAgent(projectRoot);
    this.verifierAgent = new VerifierAgent(projectRoot, {
      targetUrl,
      autoCommit,
    });
    // Share tester agent with verifier to avoid concurrent session limits
    this.verifierAgent.setTesterAgent(this.testerAgent);

    this.onSessionStarted = options.onSessionStarted;
    this.signal = options.signal;
  }

  private checkAborted(): void {
    if (this.signal?.aborted) {
      throw new Error('Run cancelled');
    }
  }

  /**
   * Get the project root path
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  /**
   * Get the target URL
   */
  getTargetUrl(): string {
    return this.targetUrl;
  }

  /**
   * Run the complete QAgent loop
   * Traced by W&B Weave for observability
   */
  run = isWeaveEnabled()
    ? op(this._run.bind(this), { name: 'Orchestrator.run' })
    : this._run.bind(this);

  private async _run(config: OrchestratorConfig): Promise<OrchestratorResult> {
    const startTime = Date.now();
    const runId = `run-${Date.now()}`;
    const allPatches: Patch[] = [];
    let totalIterations = 0;

    // Log run configuration to Weave
    if (isWeaveEnabled()) {
      weave.withAttributes(
        {
          run_id: runId,
          target_url: config.targetUrl,
          max_iterations: config.maxIterations,
          test_count: config.testSpecs.length,
          test_ids: config.testSpecs.map((t) => t.id).join(','),
          started_at: new Date().toISOString(),
        },
        () => {}
      );
    }

    console.log('\n🚀 QAgent Starting\n');
    console.log(`📋 Tests to run: ${config.testSpecs.length}`);
    console.log(`🔄 Max iterations: ${config.maxIterations}`);
    console.log(`🎯 Target: ${config.targetUrl}\n`);
    if (isWeaveEnabled()) {
      console.log(`📊 Weave run ID: ${runId}\n`);
    }

    try {
      // Initialize tester agent
      await this.testerAgent.init();
      this.emitSessionIfAvailable();

      // Process each test spec
      for (const testSpec of config.testSpecs) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📝 Test: ${testSpec.name} (${testSpec.id})`);
        console.log('='.repeat(60));

        // Update test URL to target
        const spec: TestSpec = {
          ...testSpec,
          url: testSpec.url.replace(/https?:\/\/[^/]+/, config.targetUrl),
        };

        // Run the fix loop for this test
        const result = await this.runFixLoop(spec, config.maxIterations);

        totalIterations += result.iterations;
        if (result.patches.length > 0) {
          allPatches.push(...result.patches);
        }

        if (!result.success) {
          console.log(`\n❌ Test ${testSpec.id} could not be fixed after ${result.iterations} iterations`);
        } else {
          console.log(`\n✅ Test ${testSpec.id} passing after ${result.iterations} iteration(s)`);
        }
      }

      // Run final test suite to confirm all fixes
      console.log('\n' + '='.repeat(60));
      console.log('🔍 Final Verification');
      console.log('='.repeat(60));

      const finalResults = await this.runAllTests(config.testSpecs, config.targetUrl);
      const allPassed = finalResults.every((r) => r.passed);

      // Clean up
      await this.testerAgent.close();

      const totalDuration = Date.now() - startTime;

      const passCount = finalResults.filter((r) => r.passed).length;
      const failCount = finalResults.filter((r) => !r.passed).length;

      // Print summary
      this.printSummary({
        success: allPassed,
        iterations: totalIterations,
        patches: allPatches,
        duration: totalDuration,
        testCount: config.testSpecs.length,
        passCount,
      });

      // Log metrics to Weave
      const metrics: RunMetrics = {
        testsTotal: config.testSpecs.length,
        testsPassed: passCount,
        testsFailed: failCount,
        bugsFound: allPatches.length,
        bugsFixed: allPassed ? allPatches.length : allPatches.length - failCount,
        iterationsTotal: totalIterations,
        durationMs: totalDuration,
        avgFixTimeMs: allPatches.length > 0 ? totalDuration / allPatches.length : 0,
        success: allPassed,
      };
      logRunMetrics(metrics);

      // Store each test result in Weave dataset for future evaluations
      for (const testSpec of config.testSpecs) {
        const testResult = finalResults.find((r) => r.testId === testSpec.id);
        const testPatches = allPatches.filter((p) => p.diagnosisId === testSpec.id);

        const datasetRow: RunDatasetRow = {
          id: `run-${Date.now()}-${testSpec.id}`,
          timestamp: new Date().toISOString(),
          testSpec,
          passed: testResult?.passed ?? false,
          patch: testPatches[0],
          iterations: totalIterations,
          durationMs: testResult?.duration ?? 0,
          success: testResult?.passed ?? false,
        };

        await storeRunInDataset(datasetRow);
      }

      // Run TraceTriage analysis if enabled
      if (isTraceTriageEnabled()) {
        try {
          const { TraceTriage } = await import('@/lib/tracetriage');
          const traceTriage = new TraceTriage({ autoApplySafe: true });
          traceTriage.startSession();
          const session = traceTriage.endSession();
          if (session) {
            console.log(`\n🔬 TraceTriage: analyzed ${session.tracesAnalyzed} traces, found ${session.failuresFound} failures`);
          }
        } catch (err) {
          console.log(`\n⚠️ TraceTriage analysis skipped: ${err instanceof Error ? err.message : 'unknown error'}`);
        }
      }

      // Log Weave project URL
      if (isWeaveEnabled()) {
        console.log(`\n📊 View traces at: ${getWeaveProjectUrl()}`);
      }

      // Convert last result to TestResult format
      const lastResult = finalResults[finalResults.length - 1];
      const finalTestResult = lastResult
        ? { passed: lastResult.passed, duration: lastResult.duration }
        : undefined;

      return {
        success: allPassed,
        iterations: totalIterations,
        totalDuration,
        patches: allPatches,
        finalTestResult,
      };
    } catch (error) {
      await this.testerAgent.close();
      console.error('\n💥 Orchestrator error:', error);

      return {
        success: false,
        iterations: totalIterations,
        totalDuration: Date.now() - startTime,
        patches: allPatches,
      };
    }
  }

  /**
   * Run the fix loop for a single test
   */
  private async runFixLoop(
    testSpec: TestSpec,
    maxIterations: number
  ): Promise<{ success: boolean; iterations: number; patches: Patch[] }> {
    const patches: Patch[] = [];
    const failedAttempts: FailedAttempt[] = [];

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      this.checkAborted();
      console.log(`\n--- Iteration ${iteration}/${maxIterations} ---`);

      // Step 1: Run test
      console.log('🧪 Running test...');
      this.emitSessionIfAvailable();
      const testResult = await this.testerAgent.runTest(testSpec);
      this.emitSessionIfAvailable();

      if (testResult.passed) {
        console.log('✅ Test passed!');
        return { success: true, iterations: iteration, patches };
      }

      console.log(`❌ Test failed: ${testResult.failureReport?.error.message}`);

      if (!testResult.failureReport) {
        console.log('⚠️ No failure report available, cannot proceed');
        return { success: false, iterations: iteration, patches };
      }

      // Step 2: Triage the failure
      console.log('🔍 Triaging failure...');
      const diagnosis = await this.triageAgent.diagnose(testResult.failureReport);
      console.log(`   Type: ${diagnosis.failureType}`);
      console.log(`   Root cause: ${diagnosis.rootCause.slice(0, 100)}...`);
      console.log(`   File: ${diagnosis.localization.file}:${diagnosis.localization.startLine}`);
      console.log(`   Confidence: ${(diagnosis.confidence * 100).toFixed(0)}%`);

      // Step 3: Generate fix
      console.log('🔧 Generating fix...');
      const patchResult = await this.fixerAgent.generatePatch(diagnosis, failedAttempts);

      if (!patchResult.success || !patchResult.patch) {
        console.log(`⚠️ Could not generate fix: ${patchResult.error}`);
        continue;
      }

      console.log(`   Patch: ${patchResult.patch.description}`);

      // Validate patch safety before applying
      try {
        const { validatePatch } = await import('@/lib/redteam');
        const validation = validatePatch(patchResult.patch, this.projectRoot);
        if (!validation.valid) {
          const reasons = validation.errors.map((e: { message: string }) => e.message).join(', ');
          console.log(`   Patch rejected (security): ${reasons}`);
          continue;
        }
      } catch {
        // RedTeam module may not be available, skip validation
      }

      patches.push(patchResult.patch);

      // Call callback for cloud mode (creates PRs)
      if (this.onPatchGenerated) {
        await this.onPatchGenerated(patchResult.patch, diagnosis);
      }

      // Step 4: Verify the fix
      console.log('✔️ Verifying fix...');
      // Pass failure report to verifier for learning
      this.verifierAgent.setFailureReport(testResult.failureReport);
      const verifyResult = await this.verifierAgent.verify(patchResult.patch, testSpec);

      // Notify about patch application result
      if (this.onPatchApplied) {
        this.onPatchApplied(patchResult.patch, verifyResult.success);
      }

      if (verifyResult.success) {
        console.log('✅ Fix verified!');
        return { success: true, iterations: iteration, patches };
      }

      console.log(`⚠️ Fix did not work: ${verifyResult.error}`);
      failedAttempts.push({
        patch: patchResult.patch,
        diagnosis,
        verificationError: verifyResult.error || 'Test still fails',
        iteration,
        timestamp: new Date(),
      });
    }

    return { success: false, iterations: maxIterations, patches };
  }

  /**
   * Run all tests and return results
   */
  private async runAllTests(
    testSpecs: TestSpec[],
    targetUrl: string
  ): Promise<Array<{ testId: string; passed: boolean; duration: number }>> {
    const results: Array<{ testId: string; passed: boolean; duration: number }> = [];

    for (const spec of testSpecs) {
      this.emitSessionIfAvailable();
      const testSpec: TestSpec = {
        ...spec,
        url: spec.url.replace(/https?:\/\/[^/]+/, targetUrl),
      };

      const result = await this.testerAgent.runTest(testSpec);
      this.emitSessionIfAvailable();
      results.push({
        testId: spec.id,
        passed: result.passed,
        duration: result.duration,
      });

      console.log(`   ${result.passed ? '✅' : '❌'} ${spec.name}`);
    }

    return results;
  }

  /**
   * Print a summary of the run
   */
  private printSummary(stats: {
    success: boolean;
    iterations: number;
    patches: Patch[];
    duration: number;
    testCount: number;
    passCount: number;
  }): void {
    console.log('\n' + '='.repeat(60));
    console.log('📊 QAGENT SUMMARY');
    console.log('='.repeat(60));
    console.log(`Status: ${stats.success ? '✅ ALL TESTS PASSING' : '❌ SOME TESTS FAILING'}`);
    console.log(`Tests: ${stats.passCount}/${stats.testCount} passing`);
    console.log(`Iterations: ${stats.iterations}`);
    console.log(`Patches applied: ${stats.patches.length}`);
    console.log(`Duration: ${(stats.duration / 1000).toFixed(1)}s`);

    if (stats.patches.length > 0) {
      console.log('\nPatches:');
      for (const patch of stats.patches) {
        console.log(`  - ${patch.file}: ${patch.description}`);
      }
    }

    console.log('='.repeat(60) + '\n');
  }

  private emitSessionIfAvailable(): void {
    if (!this.onSessionStarted) {
      return;
    }

    const sessionId = this.testerAgent.getSessionId();
    if (sessionId && sessionId !== this.lastSessionId) {
      this.onSessionStarted(sessionId);
      this.lastSessionId = sessionId;
    }
  }
}

// CLI entry point
async function main() {
  const targetUrl = process.env.TARGET_URL || 'http://localhost:3000';
  const maxIterations = parseInt(process.env.MAX_ITERATIONS || '5', 10);

  // Initialize Weave for observability
  await initWeave('qagent');

  // Import test specs
  const { allTestSpecs } = await import('@/tests/e2e/specs');

  const orchestrator = new Orchestrator({
    targetUrl,
    autoCommit: true, // CLI mode uses auto-commit
  });

  const result = await orchestrator.run({
    maxIterations,
    testSpecs: allTestSpecs,
    targetUrl,
  });

  process.exit(result.success ? 0 : 1);
}

// Only run main() when this file is executed directly, not when imported
const isDirectRun = process.argv[1]?.includes('orchestrator');
if (isDirectRun) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export default Orchestrator;
