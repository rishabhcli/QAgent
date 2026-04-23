# Skill: QAgent Agents

## When to Use This Skill

Use this skill when:
- Implementing any of the four core agents
- Understanding agent interfaces and data flow
- Working on the QAgent loop logic
- Debugging agent interactions

This is the **primary skill** for QAgent development.

---

## Overview

QAgent consists of four cooperating agents:

1. **Tester Agent** - Runs E2E tests, captures failures
2. **Triage Agent** - Diagnoses failures, queries knowledge base
3. **Fixer Agent** - Generates code patches using LLM
4. **Verifier Agent** - Applies patches, deploys, re-tests

Each agent has clear inputs, outputs, and responsibilities.

---

## Agent Specifications

### Tester Agent

**Purpose:** Execute tests and detect failures

**Input:**
```typescript
interface TesterInput {
  testSpec: TestSpec;
  appUrl: string;
}
```

**Output:**
```typescript
interface TestResult {
  passed: boolean;
  duration: number;
  failureReport?: FailureReport;
}

interface FailureReport {
  testId: string;
  step: number;
  error: { message: string; stack: string };
  context: {
    url: string;
    screenshot: string;
    domSnapshot: string;
    consoleLogs: string[];
  };
}
```

**Dependencies:**
- Browserbase (browser sessions)
- Stagehand (test execution)

---

### Triage Agent

**Purpose:** Diagnose failures and identify root cause

**Input:**
```typescript
interface TriageInput {
  failureReport: FailureReport;
}
```

**Output:**
```typescript
interface DiagnosisReport {
  failureId: string;
  failureType: 'UI_BUG' | 'BACKEND_ERROR' | 'TEST_FLAKY' | 'DATA_ERROR';
  rootCause: string;
  localization: {
    file: string;
    startLine: number;
    endLine: number;
    codeSnippet: string;
  };
  similarIssues: SimilarIssue[];
  suggestedFix: string;
  confidence: number;
}
```

**Dependencies:**
- Redis (similar issue lookup)
- OpenAI (diagnosis generation)
- File system (code reading)

---

### Fixer Agent

**Purpose:** Generate code patches to fix bugs

**Input:**
```typescript
interface FixerInput {
  diagnosis: DiagnosisReport;
}
```

**Output:**
```typescript
interface Patch {
  id: string;
  file: string;
  diff: string;
  description: string;
  metadata: {
    linesAdded: number;
    linesRemoved: number;
    llmModel: string;
  };
}
```

**Dependencies:**
- Redis (fix patterns)
- OpenAI (patch generation)
- File system (code reading/writing)

---

### Verifier Agent

**Purpose:** Apply patches and verify fixes

**Input:**
```typescript
interface VerifierInput {
  patch: Patch;
  testSpec: TestSpec;
}
```

**Output:**
```typescript
interface VerificationResult {
  passed: boolean;
  deployUrl: string;
  testResult: TestResult;
  duration: number;
}
```

**Dependencies:**
- Git (apply patch, commit)
- Vercel (deployment)
- Browserbase/Stagehand (re-test)
- Redis (store successful fix)

---

## The QAgent Loop

```
                    ┌─────────────────────┐
                    │       START         │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │    TESTER AGENT     │
                    │    Run E2E test     │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │    Test Passed?     │
                    └──────────┬──────────┘
                               │
              ┌────────────────┴────────────────┐
              │ YES                         NO  │
              ▼                                 ▼
       ┌──────────────┐              ┌──────────────────┐
       │    DONE      │              │   TRIAGE AGENT   │
       │   Success!   │              │ Diagnose failure │
       └──────────────┘              └────────┬─────────┘
                                              │
                                   ┌──────────▼──────────┐
                                   │    FIXER AGENT      │
                                   │   Generate patch    │
                                   └──────────┬──────────┘
                                              │
                                   ┌──────────▼──────────┐
                                   │   VERIFIER AGENT    │
                                   │  Deploy & re-test   │
                                   └──────────┬──────────┘
                                              │
                                   ┌──────────▼──────────┐
                                   │    Fix Worked?      │
                                   └──────────┬──────────┘
                                              │
                      ┌───────────────────────┴───────────┐
                      │ YES                           NO  │
                      ▼                                   ▼
               ┌──────────────┐                ┌──────────────────┐
               │    DONE      │                │ Iteration < Max? │
               │   Fixed!     │                └────────┬─────────┘
               └──────────────┘                         │
                                          ┌─────────────┴─────────┐
                                          │ YES               NO  │
                                          ▼                       ▼
                                   ┌──────────────┐       ┌──────────────┐
                                   │ Loop back to │       │    DONE      │
                                   │ TRIAGE AGENT │       │   Failed     │
                                   └──────────────┘       └──────────────┘
```

---

## Common Patterns

### Implement Agent Base Class

```typescript
abstract class BaseAgent<TInput, TOutput> {
  abstract name: string;

  @weave.op()
  async run(input: TInput): Promise<TOutput> {
    console.log(`[${this.name}] Starting...`);
    const startTime = Date.now();

    try {
      const output = await this.process(input);
      console.log(`[${this.name}] Completed in ${Date.now() - startTime}ms`);
      return output;
    } catch (error) {
      console.error(`[${this.name}] Error:`, error);
      throw error;
    }
  }

  protected abstract process(input: TInput): Promise<TOutput>;
}
```

### Error Classification

```typescript
function classifyError(error: string): FailureType {
  if (error.includes('onClick') || error.includes('handler')) {
    return 'UI_BUG';
  }
  if (error.includes('404') || error.includes('500') || error.includes('API')) {
    return 'BACKEND_ERROR';
  }
  if (error.includes('timeout') || error.includes('flaky')) {
    return 'TEST_FLAKY';
  }
  if (error.includes('null') || error.includes('undefined')) {
    return 'DATA_ERROR';
  }
  return 'UNKNOWN';
}
```

---

## Best Practices

1. **Keep agents stateless** - All state through input/output
2. **Log all boundaries** - Entry/exit of each agent
3. **Validate inputs** - Check required fields before processing
4. **Handle errors gracefully** - Don't crash the loop
5. **Track metrics** - Log duration, success rate, iterations

---

## Related Skills

- `browserbase-stagehand/` - Tester Agent implementation
- `redis-vectorstore/` - Triage/Fixer knowledge base
- `vercel-deployment/` - Verifier Agent deployment
- `wandb-weave/` - All agent tracing
- `google-adk/` - Orchestration

---

## References

- [QAgent Paper](https://arxiv.org/html/2502.02747v1)
- [docs/DESIGN.md](../../docs/DESIGN.md) - Agent data structures
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) - System design
