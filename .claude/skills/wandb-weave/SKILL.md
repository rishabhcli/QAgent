# Skill: W&B Weave

## When to Use This Skill

Use this skill when:
- Adding observability to agent functions
- Logging metrics for the dashboard
- Creating traces for debugging
- Evaluating agent performance
- Implementing TraceTriage self-improvement

Do NOT use this skill when:
- Working on core agent logic without logging
- Setting up infrastructure (Redis, Vercel, etc.)

---

## Overview

Weights & Biases Weave provides observability for LLM applications. For QAgent, it:
- Creates trace trees showing agent interactions
- Logs inputs/outputs of every function
- Tracks metrics like pass rate, time-to-fix
- Enables evaluation and comparison of runs

Key features:
- `@weave.op()` decorator for automatic tracing
- Structured logging with `weave.log()`
- Evaluation framework for A/B testing
- Dashboard for visualization

---

## Key Concepts

### Traces

A trace is a tree of function calls. In QAgent:

```
Run: qagent-run-123
├── Orchestrator.run()
│   ├── TesterAgent.runTest()
│   │   └── [inputs, outputs, duration]
│   ├── TriageAgent.diagnose()
│   │   └── [inputs, outputs, duration]
│   ├── FixerAgent.generatePatch()
│   │   └── [inputs, outputs, duration]
│   └── VerifierAgent.verify()
│       └── [inputs, outputs, duration]
```

### Operations

An operation is a traced function. Use `@weave.op()`:

```typescript
class TesterAgent {
  @weave.op()
  async runTest(spec: TestSpec): Promise<TestResult> {
    // Automatically logged
  }
}
```

### Metrics

Metrics are key-value pairs logged per run:

```typescript
weave.log({
  test_pass_rate: 0.87,
  time_to_fix_seconds: 192,
  iterations: 2
});
```

---

## Common Patterns

### Initialize Weave

```typescript
import weave from 'weave';

await weave.init({
  project: 'qagent',
  entity: process.env.WANDB_ENTITY
});
```

### Trace Agent Methods

```typescript
import weave from 'weave';

class TesterAgent {
  @weave.op()
  async runTest(spec: TestSpec): Promise<TestResult> {
    // All inputs and outputs automatically logged
    const result = await this.executeTest(spec);
    return result;
  }

  @weave.op()
  async captureFailure(error: Error): Promise<FailureReport> {
    // Nested calls create trace tree
    const screenshot = await this.getScreenshot();
    return { error, screenshot };
  }
}
```

### Log Metrics

```typescript
async function logRunMetrics(result: RunResult): Promise<void> {
  weave.log({
    // Test metrics
    tests_total: result.totalTests,
    tests_passed: result.passedTests,
    pass_rate: result.passedTests / result.totalTests,

    // Fix metrics
    bugs_found: result.bugsFound,
    bugs_fixed: result.bugsFixed,
    fix_success_rate: result.bugsFixed / result.bugsFound,

    // Performance metrics
    total_duration_seconds: result.duration / 1000,
    avg_fix_time_seconds: result.avgFixTime / 1000,
    total_iterations: result.totalIterations,

    // Cost metrics
    llm_tokens_used: result.tokensUsed,
    redis_queries: result.redisQueries
  });
}
```

### Create Evaluation

```typescript
import weave from 'weave';

// Define evaluation dataset
const evalDataset = [
  { input: { errorMessage: 'Missing onClick' }, expected: 'UI_BUG' },
  { input: { errorMessage: 'API 404' }, expected: 'BACKEND_ERROR' }
];

// Run evaluation
const evaluation = await weave.evaluate({
  model: triageAgent,
  dataset: evalDataset,
  scorers: [
    (output, expected) => output.failureType === expected ? 1 : 0
  ]
});

console.log('Accuracy:', evaluation.scores.mean);
```

---

## Best Practices

1. **Trace all agent entry points** - Every public method should have `@weave.op()`
2. **Log structured data** - Use objects, not strings
3. **Name operations clearly** - Include agent name in function names
4. **Log at consistent points** - After each run, not during
5. **Include metadata** - Test IDs, timestamps, versions

---

## Common Pitfalls

### Missing Async Handling
- `@weave.op()` works with async functions
- Ensure all promises are awaited

### Large Payloads
- Don't log huge DOM snapshots
- Truncate long strings
- Use references for binary data

### Missing Context
- Initialize weave early
- Ensure `WANDB_API_KEY` is set

---

## Related Skills

- `marimo-dashboards/` - Visualizing Weave data
- `qagent-agents/` - Where to add tracing

---

## References

- [Weave Documentation](https://wandb.ai/site/weave)
- [Weave Python SDK](https://docs.wandb.ai/guides/weave)
- [W&B Dashboard](https://wandb.ai/)
