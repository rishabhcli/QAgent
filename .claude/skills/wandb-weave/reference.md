# Reference: W&B Weave

Copy-paste code patterns for observability and tracing.

---

## Quick Start

```typescript
import weave from 'weave';

// Initialize
await weave.init({ project: 'qagent' });

// Trace a function
class MyAgent {
  @weave.op()
  async doSomething(input: string): Promise<string> {
    return `processed: ${input}`;
  }
}

// Log metrics
weave.log({ success: true, duration_ms: 1234 });
```

---

## Code Patterns

### Pattern 1: Full Agent Tracing Setup

**Use when:** Setting up tracing for all QAgent agents

```typescript
import weave from 'weave';

// Initialize at app startup
export async function initWeave(): Promise<void> {
  await weave.init({
    project: process.env.WANDB_PROJECT || 'qagent',
    entity: process.env.WANDB_ENTITY
  });
}

// Traced Tester Agent
export class TesterAgent {
  @weave.op()
  async runTest(spec: TestSpec): Promise<TestResult> {
    const startTime = Date.now();
    try {
      const result = await this.executeTest(spec);
      return {
        ...result,
        duration: Date.now() - startTime
      };
    } catch (error) {
      throw error; // Error will be logged in trace
    }
  }

  @weave.op()
  private async executeTest(spec: TestSpec): Promise<TestResult> {
    // Implementation
  }
}

// Traced Triage Agent
export class TriageAgent {
  @weave.op()
  async diagnose(failure: FailureReport): Promise<DiagnosisReport> {
    const similarIssues = await this.findSimilar(failure);
    const diagnosis = await this.generateDiagnosis(failure, similarIssues);
    return diagnosis;
  }

  @weave.op()
  private async findSimilar(failure: FailureReport): Promise<SimilarIssue[]> {
    // Redis query - traced separately
  }

  @weave.op()
  private async generateDiagnosis(
    failure: FailureReport,
    similar: SimilarIssue[]
  ): Promise<DiagnosisReport> {
    // LLM call - traced separately
  }
}

// Traced Fixer Agent
export class FixerAgent {
  @weave.op()
  async generatePatch(diagnosis: DiagnosisReport): Promise<Patch> {
    const code = await this.loadSourceCode(diagnosis.file);
    const fixPatterns = await this.getFixPatterns(diagnosis.failureType);
    const patch = await this.callLLM(diagnosis, code, fixPatterns);
    return patch;
  }

  @weave.op()
  private async callLLM(
    diagnosis: DiagnosisReport,
    code: string,
    patterns: FixPattern[]
  ): Promise<Patch> {
    // OpenAI call - traced with input/output
  }
}

// Traced Verifier Agent
export class VerifierAgent {
  @weave.op()
  async verify(patch: Patch, test: TestSpec): Promise<VerificationResult> {
    await this.applyPatch(patch);
    const deployUrl = await this.deploy();
    const testResult = await this.retest(test, deployUrl);
    return { passed: testResult.passed, deployUrl };
  }
}
```

### Pattern 2: Logging Run Metrics

**Use when:** Recording metrics after each QAgent run

```typescript
import weave from 'weave';

interface RunMetrics {
  // Test metrics
  testsTotal: number;
  testsPassed: number;
  testsFailed: number;

  // Fix metrics
  bugsFound: number;
  bugsFixed: number;
  iterationsTotal: number;

  // Performance metrics
  durationMs: number;
  avgFixTimeMs: number;

  // Resource metrics
  llmTokensUsed: number;
  redisQueriesCount: number;
  redisHitRate: number;

  // Outcome
  success: boolean;
}

async function logRunMetrics(metrics: RunMetrics): Promise<void> {
  weave.log({
    // Test metrics
    tests_total: metrics.testsTotal,
    tests_passed: metrics.testsPassed,
    tests_failed: metrics.testsFailed,
    pass_rate: metrics.testsTotal > 0
      ? metrics.testsPassed / metrics.testsTotal
      : 0,

    // Fix metrics
    bugs_found: metrics.bugsFound,
    bugs_fixed: metrics.bugsFixed,
    fix_success_rate: metrics.bugsFound > 0
      ? metrics.bugsFixed / metrics.bugsFound
      : 0,
    iterations_total: metrics.iterationsTotal,
    iterations_per_bug: metrics.bugsFound > 0
      ? metrics.iterationsTotal / metrics.bugsFound
      : 0,

    // Performance
    duration_seconds: metrics.durationMs / 1000,
    avg_fix_time_seconds: metrics.avgFixTimeMs / 1000,

    // Resources
    llm_tokens_used: metrics.llmTokensUsed,
    redis_queries: metrics.redisQueriesCount,
    redis_hit_rate: metrics.redisHitRate,

    // Outcome
    run_success: metrics.success,

    // Metadata
    timestamp: Date.now(),
    version: process.env.npm_package_version || '0.0.0'
  });
}
```

### Pattern 3: TraceTriage - Analyzing Agent Failures

**Use when:** Implementing self-improvement by analyzing traces

```typescript
import weave from 'weave';

interface TraceAnalysis {
  runId: string;
  failurePoint: string;
  failureCause: 'TOOL_ERROR' | 'RETRIEVAL_ERROR' | 'PROMPT_DRIFT' | 'PARSE_ERROR' | 'UNKNOWN';
  details: string;
  suggestedFix: string;
}

async function analyzeFailedRun(runId: string): Promise<TraceAnalysis> {
  // Get trace from Weave
  const trace = await weave.getTrace(runId);

  // Find the failing operation
  const failingOp = trace.operations.find(op => op.error);

  if (!failingOp) {
    return {
      runId,
      failurePoint: 'unknown',
      failureCause: 'UNKNOWN',
      details: 'No error found in trace',
      suggestedFix: 'Manual investigation required'
    };
  }

  // Classify the failure
  const cause = classifyFailure(failingOp);

  return {
    runId,
    failurePoint: failingOp.name,
    failureCause: cause.type,
    details: cause.details,
    suggestedFix: cause.suggestion
  };
}

function classifyFailure(op: TraceOperation): {
  type: TraceAnalysis['failureCause'];
  details: string;
  suggestion: string;
} {
  const errorMsg = op.error?.message || '';

  // Tool error (browser, Redis, Vercel)
  if (errorMsg.includes('timeout') || errorMsg.includes('ECONNREFUSED')) {
    return {
      type: 'TOOL_ERROR',
      details: `External service error in ${op.name}: ${errorMsg}`,
      suggestion: 'Add retry logic with exponential backoff'
    };
  }

  // Retrieval error (wrong/no results from Redis)
  if (op.name.includes('findSimilar') && op.output?.length === 0) {
    return {
      type: 'RETRIEVAL_ERROR',
      details: 'No similar failures found in knowledge base',
      suggestion: 'Lower similarity threshold or expand embedding context'
    };
  }

  // Prompt drift (LLM didn't follow format)
  if (op.name.includes('LLM') && errorMsg.includes('JSON')) {
    return {
      type: 'PROMPT_DRIFT',
      details: 'LLM output was not valid JSON',
      suggestion: 'Add output validation and retry, or use function calling'
    };
  }

  // Parse error
  if (errorMsg.includes('parse') || errorMsg.includes('syntax')) {
    return {
      type: 'PARSE_ERROR',
      details: `Parsing failed: ${errorMsg}`,
      suggestion: 'Add input validation and sanitization'
    };
  }

  return {
    type: 'UNKNOWN',
    details: errorMsg,
    suggestion: 'Manual investigation required'
  };
}
```

### Pattern 4: Evaluation for A/B Testing

**Use when:** Comparing different agent configurations

```typescript
import weave from 'weave';

// Define test cases
const evaluationDataset = [
  {
    input: {
      errorMessage: 'TypeError: Cannot read property onClick of undefined',
      stackTrace: 'at Checkout.tsx:42'
    },
    expected: {
      failureType: 'UI_BUG',
      file: 'Checkout.tsx'
    }
  },
  {
    input: {
      errorMessage: 'GET /api/payment 404 Not Found',
      stackTrace: ''
    },
    expected: {
      failureType: 'BACKEND_ERROR',
      file: 'api/payment'
    }
  }
];

// Custom scorer
function diagnosisAccuracyScorer(
  output: DiagnosisReport,
  expected: { failureType: string; file: string }
): number {
  let score = 0;

  if (output.failureType === expected.failureType) {
    score += 0.5;
  }

  if (output.file.includes(expected.file)) {
    score += 0.5;
  }

  return score;
}

// Run evaluation
async function evaluateTriageAgent(
  agent: TriageAgent,
  name: string
): Promise<EvaluationResult> {
  const results = await weave.evaluate({
    model: agent,
    dataset: evaluationDataset,
    scorers: [diagnosisAccuracyScorer],
    name: `triage-eval-${name}`
  });

  return {
    name,
    accuracy: results.scores.mean,
    results: results.examples
  };
}

// Compare two versions
async function compareAgentVersions(): Promise<void> {
  const agentV1 = new TriageAgent({ promptVersion: 'v1' });
  const agentV2 = new TriageAgent({ promptVersion: 'v2' });

  const [resultV1, resultV2] = await Promise.all([
    evaluateTriageAgent(agentV1, 'v1'),
    evaluateTriageAgent(agentV2, 'v2')
  ]);

  console.log('V1 Accuracy:', resultV1.accuracy);
  console.log('V2 Accuracy:', resultV2.accuracy);
  console.log('Improvement:', resultV2.accuracy - resultV1.accuracy);
}
```

---

## Configuration Examples

### Basic Configuration

```typescript
import weave from 'weave';

await weave.init({
  project: 'qagent'
});
```

### Full Configuration

```typescript
await weave.init({
  project: process.env.WANDB_PROJECT || 'qagent',
  entity: process.env.WANDB_ENTITY,
  settings: {
    silent: process.env.NODE_ENV === 'production'
  }
});
```

---

## Common Commands

```bash
# Install
pnpm add weave

# Set API key
export WANDB_API_KEY=your_key_here

# View traces
# Go to https://wandb.ai/<entity>/<project>/weave
```

---

## Troubleshooting

### Issue: Traces not appearing

**Symptom:** No traces in Weave dashboard

**Solution:**
```typescript
// Ensure init is called and awaited
await weave.init({ project: 'qagent' });

// Ensure WANDB_API_KEY is set
console.log('API Key set:', !!process.env.WANDB_API_KEY);
```

### Issue: Large trace payloads

**Symptom:** Slow uploads, storage warnings

**Solution:**
```typescript
// Truncate large strings
function truncate(str: string, max: number = 1000): string {
  return str.length > max ? str.substring(0, max) + '...' : str;
}

@weave.op()
async function diagnose(failure: FailureReport): Promise<DiagnosisReport> {
  // Truncate DOM before logging
  const truncatedFailure = {
    ...failure,
    context: {
      ...failure.context,
      domSnapshot: truncate(failure.context.domSnapshot, 5000)
    }
  };
  // Process...
}
```

---

## Cheat Sheet

| Task | Code |
|------|------|
| Initialize | `await weave.init({ project: 'name' })` |
| Trace function | `@weave.op()` decorator |
| Log metrics | `weave.log({ key: value })` |
| Get trace | `await weave.getTrace(runId)` |
| Run evaluation | `await weave.evaluate({ model, dataset, scorers })` |
