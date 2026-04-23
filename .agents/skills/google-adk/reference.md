# Reference: Google Cloud ADK

Copy-paste code patterns for multi-agent orchestration.

---

## Quick Start

```typescript
import { Agent, Workflow } from '@google-cloud/adk';

// Define an agent
const myAgent = new Agent({
  name: 'my-agent',
  process: async (input) => {
    return { result: 'done' };
  }
});

// Run the agent
const output = await myAgent.run({ data: 'input' });
```

---

## Code Patterns

### Pattern 1: QAgent Orchestrator

**Use when:** Implementing the main orchestration loop

```typescript
import { Workflow, Agent, Context } from '@google-cloud/adk';
import weave from 'weave';

interface QAgentContext {
  testSpec: TestSpec;
  appUrl: string;
  maxIterations: number;
  currentIteration: number;
  testResult?: TestResult;
  failureReport?: FailureReport;
  diagnosis?: DiagnosisReport;
  patch?: Patch;
  verificationResult?: VerificationResult;
}

class QAgentOrchestrator {
  private tester: TesterAgent;
  private triage: TriageAgent;
  private fixer: FixerAgent;
  private verifier: VerifierAgent;

  constructor() {
    this.tester = new TesterAgent();
    this.triage = new TriageAgent();
    this.fixer = new FixerAgent();
    this.verifier = new VerifierAgent();
  }

  @weave.op()
  async run(testSpec: TestSpec, appUrl: string): Promise<RunResult> {
    const context: QAgentContext = {
      testSpec,
      appUrl,
      maxIterations: 5,
      currentIteration: 0
    };

    // Main loop
    while (context.currentIteration < context.maxIterations) {
      context.currentIteration++;
      console.log(`\n=== Iteration ${context.currentIteration} ===`);

      // Step 1: Run test
      context.testResult = await this.tester.runTest(context.testSpec);

      if (context.testResult.passed) {
        return this.createSuccessResult(context);
      }

      // Step 2: Capture failure
      context.failureReport = context.testResult.failureReport;

      // Step 3: Diagnose
      context.diagnosis = await this.triage.diagnose(context.failureReport!);

      // Step 4: Generate fix
      context.patch = await this.fixer.generatePatch(context.diagnosis);

      // Step 5: Verify fix
      context.verificationResult = await this.verifier.verify(
        context.patch,
        context.testSpec
      );

      if (context.verificationResult.passed) {
        return this.createSuccessResult(context);
      }

      // Update for next iteration
      console.log('Fix did not work, trying again...');
    }

    return this.createFailureResult(context);
  }

  private createSuccessResult(context: QAgentContext): RunResult {
    return {
      success: true,
      iterations: context.currentIteration,
      finalPatch: context.patch,
      testsPassed: true
    };
  }

  private createFailureResult(context: QAgentContext): RunResult {
    return {
      success: false,
      iterations: context.currentIteration,
      finalPatch: context.patch,
      testsPassed: false,
      error: 'Max iterations reached'
    };
  }
}
```

### Pattern 2: Agent Message Protocol

**Use when:** Defining communication between agents

```typescript
// Message types for A2A communication
interface AgentMessage<T = unknown> {
  id: string;
  timestamp: Date;
  from: string;
  to: string;
  type: 'request' | 'response' | 'error';
  payload: T;
  traceId: string;
}

// Tester → Triage message
interface TestFailureMessage extends AgentMessage<FailureReport> {
  from: 'tester';
  to: 'triage';
  type: 'request';
}

// Triage → Fixer message
interface DiagnosisMessage extends AgentMessage<DiagnosisReport> {
  from: 'triage';
  to: 'fixer';
  type: 'request';
}

// Fixer → Verifier message
interface PatchMessage extends AgentMessage<Patch> {
  from: 'fixer';
  to: 'verifier';
  type: 'request';
}

// Message dispatcher
class MessageBus {
  private handlers: Map<string, (msg: AgentMessage) => Promise<AgentMessage>> = new Map();

  register(agentName: string, handler: (msg: AgentMessage) => Promise<AgentMessage>) {
    this.handlers.set(agentName, handler);
  }

  async dispatch(message: AgentMessage): Promise<AgentMessage> {
    const handler = this.handlers.get(message.to);
    if (!handler) {
      throw new Error(`No handler for agent: ${message.to}`);
    }
    return handler(message);
  }
}
```

### Pattern 3: Simple Sequential Orchestrator

**Use when:** MVP without full ADK complexity

```typescript
// Simplified orchestrator for MVP
class SimpleOrchestrator {
  async run(testSpec: TestSpec): Promise<boolean> {
    const tester = new TesterAgent();
    const triage = new TriageAgent();
    const fixer = new FixerAgent();
    const verifier = new VerifierAgent();

    let iteration = 0;
    const maxIterations = 5;

    while (iteration < maxIterations) {
      iteration++;

      // Test
      const testResult = await tester.runTest(testSpec);
      if (testResult.passed) {
        console.log(`Success after ${iteration} iterations`);
        return true;
      }

      // Diagnose
      const diagnosis = await triage.diagnose(testResult.failureReport!);

      // Fix
      const patch = await fixer.generatePatch(diagnosis);

      // Verify
      const verified = await verifier.verify(patch, testSpec);
      if (verified.passed) {
        console.log(`Fixed after ${iteration} iterations`);
        return true;
      }
    }

    console.log('Max iterations reached');
    return false;
  }
}

// Usage
const orchestrator = new SimpleOrchestrator();
const success = await orchestrator.run(checkoutTestSpec);
```

### Pattern 4: Parallel Agent Execution

**Use when:** Running independent operations concurrently

```typescript
// Run multiple tests in parallel
async function runTestsParallel(tests: TestSpec[]): Promise<TestResult[]> {
  const tester = new TesterAgent();

  const results = await Promise.all(
    tests.map(test => tester.runTest(test))
  );

  return results;
}

// Diagnose multiple failures in parallel
async function triageParallel(failures: FailureReport[]): Promise<DiagnosisReport[]> {
  const triage = new TriageAgent();

  const diagnoses = await Promise.all(
    failures.map(failure => triage.diagnose(failure))
  );

  return diagnoses;
}
```

### Pattern 5: Error Recovery and Retry

**Use when:** Handling agent failures gracefully

```typescript
interface RetryConfig {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
}

async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = { maxRetries: 3, backoffMs: 1000, backoffMultiplier: 2 }
): Promise<T> {
  let lastError: Error | undefined;
  let backoff = config.backoffMs;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.log(`Attempt ${attempt} failed: ${lastError.message}`);

      if (attempt < config.maxRetries) {
        await new Promise(resolve => setTimeout(resolve, backoff));
        backoff *= config.backoffMultiplier;
      }
    }
  }

  throw lastError;
}

// Usage in orchestrator
async function runWithRecovery(testSpec: TestSpec): Promise<RunResult> {
  return withRetry(async () => {
    const orchestrator = new QAgentOrchestrator();
    return orchestrator.run(testSpec, process.env.APP_URL!);
  });
}
```

---

## Configuration Examples

### Basic ADK Setup

```typescript
import { ADK } from '@google-cloud/adk';

const adk = new ADK({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS
});

await adk.init();
```

### Register Agents

```typescript
adk.registerAgent('tester', testerAgent);
adk.registerAgent('triage', triageAgent);
adk.registerAgent('fixer', fixerAgent);
adk.registerAgent('verifier', verifierAgent);
```

---

## Common Commands

```bash
# Install ADK
pnpm add @google-cloud/adk

# Set up credentials
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json
export GOOGLE_CLOUD_PROJECT=your-project-id

# Run locally
pnpm run orchestrator
```

---

## Troubleshooting

### Issue: Agent timeout

**Symptom:** Agent call times out

**Solution:**
```typescript
// Increase timeout in agent config
const agent = new Agent({
  name: 'slow-agent',
  timeout: 120000, // 2 minutes
  process: async (input) => { /* ... */ }
});
```

### Issue: Context not passed

**Symptom:** Agent receives undefined input

**Solution:**
```typescript
// Explicitly map context to input
const workflow = new Workflow({
  steps: [
    {
      agent: 'triage',
      input: (ctx) => ({
        failureReport: ctx.steps.tester.output.failureReport,
        testId: ctx.testSpec.id  // Explicitly include needed data
      })
    }
  ]
});
```

---

## Cheat Sheet

| Task | Code |
|------|------|
| Create agent | `new Agent({ name, process })` |
| Run agent | `await agent.run(input)` |
| Create workflow | `new Workflow({ name, steps })` |
| Run workflow | `await workflow.run(context)` |
| Sequential | `[step1, step2, step3]` |
| Conditional | `conditional({ condition, then, else })` |
| Loop | `{ goto: 'stepName' }` |
| Parallel | `Promise.all([...])` |
