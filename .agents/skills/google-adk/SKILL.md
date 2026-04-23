# Skill: Google Cloud ADK

## When to Use This Skill

Use this skill when:
- Implementing the Orchestrator agent
- Coordinating multi-agent workflows
- Defining agent-to-agent communication
- Managing agent lifecycle

Do NOT use this skill when:
- Working on individual agent logic
- Implementing tool integrations (Redis, Vercel, etc.)

---

## Overview

Google Cloud's Agent Development Kit (ADK) and Agent-to-Agent (A2A) protocol provide infrastructure for building and orchestrating multi-agent systems. For QAgent:

- Define agents as independent services
- Coordinate Tester → Triage → Fixer → Verifier workflow
- Handle context passing between agents
- Manage iterations and state

---

## Key Concepts

### ADK Agent

An agent is a self-contained unit with:
- Input schema (what it receives)
- Output schema (what it returns)
- Processing logic
- Tool access

### A2A Protocol

Agent-to-agent communication with:
- Request/Response messages
- Streaming support
- Context preservation
- Error handling

### Workflow Orchestration

Define how agents interact:
- Sequential: A → B → C
- Parallel: A → [B, C] → D
- Conditional: A → (if X) B else C
- Loop: A → B → (repeat until done)

---

## Common Patterns

### Define Agent Interface

```typescript
import { Agent, AgentInput, AgentOutput } from '@google-cloud/adk';

interface TesterInput extends AgentInput {
  testSpec: TestSpec;
  appUrl: string;
}

interface TesterOutput extends AgentOutput {
  result: TestResult;
  failureReport?: FailureReport;
}

const testerAgent = new Agent<TesterInput, TesterOutput>({
  name: 'tester',
  description: 'Runs E2E tests on web application',
  process: async (input) => {
    // Implementation
    return { result, failureReport };
  }
});
```

### Create Workflow

```typescript
import { Workflow, sequential, conditional } from '@google-cloud/adk';

const qAgentWorkflow = new Workflow({
  name: 'qagent',
  steps: [
    // 1. Run tests
    { agent: 'tester', input: (ctx) => ctx.testSpec },

    // 2. If failure, diagnose
    conditional({
      condition: (ctx) => !ctx.steps.tester.result.passed,
      then: { agent: 'triage', input: (ctx) => ctx.steps.tester.failureReport },
      else: { return: { success: true } }
    }),

    // 3. Generate fix
    { agent: 'fixer', input: (ctx) => ctx.steps.triage.diagnosis },

    // 4. Verify fix
    { agent: 'verifier', input: (ctx) => ({
      patch: ctx.steps.fixer.patch,
      test: ctx.testSpec
    })},

    // 5. Loop if still failing
    conditional({
      condition: (ctx) => !ctx.steps.verifier.passed && ctx.iteration < 5,
      then: { goto: 'triage' },
      else: { return: { success: ctx.steps.verifier.passed } }
    })
  ]
});
```

### Run Workflow

```typescript
const result = await qAgentWorkflow.run({
  testSpec: {
    name: 'checkout-flow',
    steps: [/* ... */]
  },
  appUrl: 'https://demo.vercel.app'
});

console.log('Workflow completed:', result.success);
console.log('Iterations:', result.iterations);
```

---

## Best Practices

1. **Keep agents focused** - Each agent does one thing well
2. **Define clear schemas** - Type inputs and outputs
3. **Handle errors gracefully** - Use try/catch in agent process
4. **Log at boundaries** - Log when entering/exiting agents
5. **Set iteration limits** - Prevent infinite loops

---

## Common Pitfalls

### Context Loss
- Pass all needed data explicitly
- Don't rely on external state

### Infinite Loops
- Always check iteration count
- Have fallback exit conditions

### Error Propagation
- Decide: stop workflow or continue?
- Log errors for debugging

---

## Related Skills

- `qagent-agents/` - Individual agent implementations
- `wandb-weave/` - Tracing workflow execution

---

## References

- [Google Cloud ADK](https://cloud.google.com/agent-development-kit)
- [A2A Protocol Spec](https://cloud.google.com/agent-development-kit/docs/a2a)
