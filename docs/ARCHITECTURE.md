# Architecture Decision Records

## Project: QAgent - Self-Healing QA Agent

This document captures key architecture decisions using the ADR (Architecture Decision Record) format.

---

## ADR Index

| ID | Title | Status | Date |
|----|-------|--------|------|
| ADR-001 | Multi-Agent Architecture (ADK/A2A-compatible) | Accepted | 2024 |
| ADR-002 | Browserbase + Stagehand for Browser Automation | Accepted | 2024 |
| ADR-003 | Redis for Vector Knowledge Base | Accepted | 2024 |
| ADR-004 | Vercel for Deployment Automation | Accepted | 2024 |
| ADR-005 | W&B Weave for Observability | Accepted | 2024 |
| ADR-006 | Marimo for Dashboard | Accepted | 2024 |
| ADR-007 | OpenAI for Patch Generation | Accepted | 2024 |
| ADR-008 | Next.js for Demo Application | Accepted | 2024 |

---

## ADR-001: Multi-Agent Architecture (ADK/A2A-compatible)

**Status:** Accepted
**Date:** 2024
**Deciders:** Team

### Context

QAgent requires coordination between multiple specialized components: testing, diagnosis, fixing, and verification. We need a way to structure these as independent agents that can communicate and hand off work reliably.

### Decision

Implement a custom orchestrator now, keeping agent interfaces ADK/A2A-compatible and deferring full ADK/A2A integration until a dedicated integration phase.

### Consequences

**Positive:**
- Immediate integration with the existing TypeScript codebase
- No new runtime dependency for the MVP
- Clear agent boundaries for future ADK/A2A mapping

**Negative:**
- Missing ADK/A2A features (standardized orchestration, tools, telemetry)
- Additional migration work later

**Mitigation:**
- Keep agent inputs/outputs explicit and stable
- Document ADK/A2A mapping points
- Revisit ADK/A2A integration post-MVP

### Alternatives Considered

1. **Adopt ADK/A2A now**: Deferred - integration not implemented yet
2. **Custom orchestration**: Chosen - fastest path for MVP
3. **LangGraph**: Rejected - different paradigm, not sponsor

---

## ADR-002: Browserbase + Stagehand for Browser Automation

**Status:** Accepted
**Date:** 2024
**Deciders:** Team

### Context

The Tester Agent needs to execute E2E tests in a real browser environment. Tests should be easy to write and maintain, ideally using natural language descriptions that get translated to browser actions.

### Decision

Use Browserbase for cloud browser infrastructure and Stagehand for AI-powered browser automation.

### Consequences

**Positive:**
- Real browser testing (not jsdom)
- Isolated, consistent environments
- Stagehand enables natural language test writing
- "Predictability of code and adaptability of AI"
- Hackathon sponsor integration

**Negative:**
- External dependency for test execution
- Session limits on free tier
- Network latency for browser operations

**Mitigation:**
- Cache browser sessions where possible
- Batch test operations
- Have fallback to local Playwright if needed

### Implementation Notes

```typescript
// Stagehand natural language test
const stagehand = new Stagehand({ browserbase });

await stagehand.act("Go to the signup page");
await stagehand.act("Fill in the email field with test@example.com");
await stagehand.act("Click the Sign Up button");
await stagehand.assert("I see a welcome message");
```

### Alternatives Considered

1. **Playwright alone**: Rejected - requires explicit selectors, brittle
2. **Puppeteer**: Rejected - less AI integration
3. **Selenium**: Rejected - dated, complex setup

---

## ADR-003: Redis for Vector Knowledge Base

**Status:** Accepted
**Date:** 2024
**Deciders:** Team

### Context

QAgent's self-improvement capability requires storing past failures and fixes, then retrieving similar ones when new bugs are encountered. This needs semantic similarity search, not just keyword matching.

### Decision

Use Redis Stack with vector search capabilities as the knowledge base.

### Consequences

**Positive:**
- Fast vector similarity search (HNSW)
- Can also store structured metadata
- Caching capabilities for other uses
- Single database for multiple purposes
- Hackathon sponsor integration

**Negative:**
- Need to manage embeddings
- Redis vector search is newer feature
- Memory-bound storage

**Mitigation:**
- Use OpenAI embeddings (1536 dim)
- Keep index size reasonable for hackathon
- Set TTL on old entries if needed

### Schema Design

```
failure:{id}
├── embedding: VECTOR (1536 dim)
├── error_message: TEXT
├── stack_trace: TEXT
├── file: TAG
├── line: NUMERIC
├── failure_type: TAG
├── fix_description: TEXT
├── fix_diff: TEXT
├── success: TAG
└── created_at: NUMERIC
```

### Query Pattern

```typescript
// Find similar failures
const results = await redis.call(
  'FT.SEARCH', 'failure_idx',
  `*=>[KNN 5 @embedding $query_vec AS score]`,
  'PARAMS', 2, 'query_vec', embedding,
  'SORTBY', 'score',
  'RETURN', 4, 'error_message', 'fix_description', 'fix_diff', 'score'
);
```

### Alternatives Considered

1. **Pinecone**: Rejected - another external service, not sponsor
2. **Chroma**: Rejected - less production-ready
3. **PostgreSQL + pgvector**: Rejected - more complex setup

---

## ADR-004: Vercel for Deployment Automation

**Status:** Accepted
**Date:** 2024
**Deciders:** Team

### Context

The Verifier Agent needs to deploy code changes and get a running application to test against. This should be fast and automated.

### Decision

Use Vercel for hosting the demo application and programmatic deployment after patches are applied.

### Consequences

**Positive:**
- Fast deployments (~30-60 seconds)
- Git integration (push triggers deploy)
- Preview URLs for each deployment
- API for programmatic control
- Hackathon sponsor integration

**Negative:**
- Vercel-specific workflow
- Build failures need handling
- Deployment limits on free tier

**Mitigation:**
- Monitor deployment status via API
- Handle build failures gracefully
- Use preview deployments to avoid prod issues

### Deployment Flow

```typescript
// After patch is applied and committed
const deployment = await vercel.deployments.create({
  name: 'qagent-demo',
  gitSource: {
    type: 'github',
    ref: 'main',
    repoId: process.env.REPO_ID
  }
});

// Poll for completion
while (deployment.readyState !== 'READY') {
  await sleep(5000);
  deployment = await vercel.deployments.get(deployment.id);
}

// Test against deployment URL
const testUrl = deployment.url;
```

### Alternatives Considered

1. **Netlify**: Rejected - similar but not sponsor
2. **Railway**: Rejected - less frontend-focused
3. **Self-hosted**: Rejected - too much setup for hackathon

---

## ADR-005: W&B Weave for Observability

**Status:** Accepted
**Date:** 2024
**Deciders:** Team

### Context

We need to trace every step of the agent pipeline for debugging, evaluation, and demonstrating improvement over time. This includes timing, inputs/outputs, and success metrics.

### Decision

Use Weights & Biases Weave for tracing and evaluation of the multi-agent system.

### Consequences

**Positive:**
- Rich trace trees showing agent interactions
- Automatic logging of function calls
- Evaluation framework for measuring improvement
- Links traces to final outcomes
- Hackathon sponsor integration

**Negative:**
- Requires wrapping functions with decorators
- Data sent to W&B servers
- Learning curve for trace analysis

**Mitigation:**
- Use weave decorators consistently
- Set up project early in development
- Practice navigating traces before demo

### Integration Pattern

```typescript
import weave from 'weave';

weave.init({ project: 'qagent' });

// Wrap agent methods
class TesterAgent {
  @weave.op()
  async runTest(spec: TestSpec): Promise<TestResult> {
    // Implementation
  }
}

// Log metrics
weave.log({
  test_pass_rate: 0.87,
  avg_fix_time_seconds: 192,
  iterations_this_run: 2
});
```

### Alternatives Considered

1. **LangSmith**: Rejected - LangChain ecosystem, not sponsor
2. **OpenTelemetry**: Rejected - lower-level, more setup
3. **Custom logging**: Rejected - reinventing tracing

---

## ADR-006: Marimo for Dashboard

**Status:** Accepted
**Date:** 2024
**Deciders:** Team

### Context

We need a live dashboard to visualize agent performance, show metrics improvement, and provide a compelling demo experience.

### Decision

Use Marimo, a reactive Python notebook, to create an interactive analytics dashboard.

### Consequences

**Positive:**
- Reactive UI updates automatically
- Python-native (can use Weave SDK directly)
- Easy to create charts and visualizations
- Can be deployed as web app
- Hackathon sponsor integration

**Negative:**
- Python-based (rest of project is TypeScript)
- Need to bridge data between systems
- Less customizable than custom React app

**Mitigation:**
- Keep dashboard logic simple
- Fetch data from Weave API
- Focus on key metrics only

### Dashboard Structure

```python
import marimo as mo
import weave

app = mo.App()

@app.cell
def metrics():
    # Fetch from Weave
    runs = weave.query(
        project='qagent',
        entity='team'
    )

    return mo.vstack([
        mo.stat("Pass Rate", f"{pass_rate}%"),
        mo.stat("Avg Fix Time", f"{avg_time}s"),
        mo.stat("Bugs Fixed", bugs_fixed)
    ])

@app.cell
def chart():
    return mo.ui.altair_chart(
        alt.Chart(data).mark_line().encode(
            x='run', y='pass_rate'
        )
    )
```

### Alternatives Considered

1. **Streamlit**: Rejected - not sponsor, less reactive
2. **Grafana**: Rejected - overkill for demo
3. **Custom React**: Rejected - time consuming

---

## ADR-007: OpenAI for Patch Generation

**Status:** Accepted
**Date:** 2024
**Deciders:** Team

### Context

The Fixer Agent needs an LLM to generate code patches based on the diagnosis and similar past fixes. The LLM should be reliable, fast, and capable of understanding code.

### Decision

Use OpenAI GPT-4 as the primary LLM for patch generation, with Anthropic Claude as backup.

### Consequences

**Positive:**
- GPT-4 excellent at code generation
- Well-documented API
- Fast response times
- Function calling for structured output

**Negative:**
- API costs
- Rate limits
- External dependency

**Mitigation:**
- Cache common patterns
- Use GPT-3.5 for simple patches
- Implement retry with backoff
- Have Anthropic as fallback

### Prompt Engineering

```typescript
const patchPrompt = `
You are a senior developer fixing a bug.

## Diagnosis
${diagnosis}

## Source Code
\`\`\`${language}
${code}
\`\`\`

## Similar Past Fixes
${similarFixes.map(f => `- ${f.description}: ${f.diff}`).join('\n')}

Generate a minimal fix. Return JSON:
{
  "file": "path/to/file.ts",
  "changes": [
    { "line": 42, "old": "old code", "new": "new code" }
  ]
}
`;
```

### Alternatives Considered

1. **Anthropic only**: Rejected - less code-focused historically
2. **Open source (Llama)**: Rejected - hosting complexity
3. **Fine-tuned model**: Rejected - no time for hackathon

---

## ADR-008: Next.js for Demo Application

**Status:** Accepted
**Date:** 2024
**Deciders:** Team

### Context

We need a demo web application that the QAgent agent will test and fix. It should be simple, have intentional bugs, and be easy to deploy on Vercel.

### Decision

Create a simple Next.js application with 2-3 pages and intentional bugs that can be fixed by the agent.

### Consequences

**Positive:**
- First-class Vercel support
- TypeScript support
- Easy to introduce realistic bugs
- Fast refresh for development

**Negative:**
- Limited to React ecosystem
- May be too simple to show full agent capability

**Mitigation:**
- Make bugs representative of real issues
- Include both frontend and API bugs
- Keep scope minimal for reliability

### Intentional Bugs

1. **Bug 1: Missing onClick Handler**
   - File: `components/CheckoutButton.tsx`
   - Issue: Button renders but click does nothing
   - Fix: Add onClick callback

2. **Bug 2: Wrong API Route**
   - File: `pages/api/payment.ts` → should be `checkout.ts`
   - Issue: Form POST gets 404
   - Fix: Rename file or change route

3. **Bug 3: Typo Causing Error**
   - File: `pages/cart.tsx`
   - Issue: `cartItems` spelled `cartItmes`
   - Fix: Correct typo

### Alternatives Considered

1. **Real production app**: Rejected - too unpredictable
2. **Static HTML**: Rejected - not representative
3. **Vue/Svelte**: Rejected - less Vercel integration

---

## Technical Diagrams

### System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              USER/DEVELOPER                              │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    │ Triggers QAgent
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                            QAGENT SYSTEM                             │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │              ORCHESTRATOR (Custom, ADK-compatible)                 │  │
│  │                                                                    │  │
│  │    ┌──────────┐      ┌──────────┐      ┌──────────┐               │  │
│  │    │  TESTER  │─────▶│  TRIAGE  │─────▶│  FIXER   │               │  │
│  │    └────┬─────┘      └────┬─────┘      └────┬─────┘               │  │
│  │         │                 │                 │                      │  │
│  │         │                 │                 │     ┌──────────┐    │  │
│  │         │                 │                 └────▶│ VERIFIER │    │  │
│  │         │                 │                       └────┬─────┘    │  │
│  │         │                 │                            │          │  │
│  └─────────┼─────────────────┼────────────────────────────┼──────────┘  │
│            │                 │                            │             │
│  ┌─────────▼─────┐   ┌───────▼───────┐   ┌────────────────▼──────────┐ │
│  │  Browserbase  │   │     Redis     │   │         Vercel            │ │
│  │  + Stagehand  │   │  (Vectors)    │   │      (Deploy)             │ │
│  └───────────────┘   └───────────────┘   └───────────────────────────┘ │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     OBSERVABILITY                                │   │
│  │   ┌─────────────────────┐     ┌─────────────────────┐           │   │
│  │   │     W&B Weave       │────▶│   Marimo Dashboard  │           │   │
│  │   │    (Tracing)        │     │   (Visualization)   │           │   │
│  │   └─────────────────────┘     └─────────────────────┘           │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Tests & Fixes
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         NEXT.JS DEMO APP (Vercel)                        │
│                                                                         │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                │
│   │   Signup    │    │    Cart     │    │  Checkout   │                │
│   │    Page     │    │    Page     │    │    Page     │                │
│   └─────────────┘    └─────────────┘    └─────────────┘                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### QAgent Loop Sequence

```
    User          Orchestrator      Tester        Triage        Fixer       Verifier
      │                │              │             │             │             │
      │   Start Run    │              │             │             │             │
      │───────────────▶│              │             │             │             │
      │                │   Run Tests  │             │             │             │
      │                │─────────────▶│             │             │             │
      │                │              │  Execute    │             │             │
      │                │              │  in Browser │             │             │
      │                │              │◀────────────│             │             │
      │                │   Failure    │             │             │             │
      │                │◀─────────────│             │             │             │
      │                │              │             │             │             │
      │                │   Diagnose   │             │             │             │
      │                │─────────────────────────▶  │             │             │
      │                │              │             │  Query      │             │
      │                │              │             │  Redis      │             │
      │                │              │             │◀────────────│             │
      │                │   Diagnosis  │             │             │             │
      │                │◀────────────────────────── │             │             │
      │                │              │             │             │             │
      │                │   Generate Fix             │             │             │
      │                │──────────────────────────────────────▶  │             │
      │                │              │             │             │   Call LLM  │
      │                │              │             │             │◀────────────│
      │                │   Patch      │             │             │             │
      │                │◀─────────────────────────────────────── │             │
      │                │              │             │             │             │
      │                │   Verify     │             │             │             │
      │                │───────────────────────────────────────────────────▶   │
      │                │              │             │             │   Deploy    │
      │                │              │             │             │   to Vercel │
      │                │              │             │             │◀────────────│
      │                │              │             │             │   Re-test   │
      │                │              │             │             │◀────────────│
      │                │   Result     │             │             │             │
      │                │◀──────────────────────────────────────────────────────│
      │                │              │             │             │             │
      │   Complete     │              │             │             │             │
      │◀───────────────│              │             │             │             │
      │                │              │             │             │             │
```

---

## Infrastructure

### Environments

| Environment | URL | Purpose |
|-------------|-----|---------|
| Development | localhost:3000 | Local development |
| Preview | *.vercel.app | PR preview deployments |
| Production | qagent-demo.vercel.app | Live demo application |
| Dashboard | localhost:2718 | Marimo dashboard |

### Services

| Service | Provider | Purpose | Tier |
|---------|----------|---------|------|
| Browser Automation | Browserbase | Cloud browsers | Free/Pro |
| AI Browser Control | Stagehand | Natural language to actions | Free |
| Vector Database | Redis Cloud | Knowledge base | Free |
| Hosting | Vercel | App deployment | Hobby |
| Tracing | W&B Weave | Observability | Free |
| Dashboard | Marimo | Visualization | Free |
| LLM | OpenAI | Patch generation | Pay-as-go |
| Orchestration | Custom (ADK/A2A-compatible; ADK planned) | Agent coordination | n/a |

### Resource Limits (Free Tier)

| Service | Limit | Impact |
|---------|-------|--------|
| Browserbase | 100 sessions/month | Plan test runs carefully |
| Redis Cloud | 30MB | Keep embeddings minimal |
| Vercel | 100 deployments/day | Should be plenty |
| OpenAI | $5 free credit | ~50-100 patches |
| W&B | 100GB storage | More than enough |

---

*Last updated: 2024*
