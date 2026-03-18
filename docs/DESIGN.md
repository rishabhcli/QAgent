# Design Specifications

## Project: QAgent - Self-Healing QA Agent

**Version:** 1.0
**Status:** Approved
**Last Updated:** 2024

---

## 1. System Design

### 1.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              QAGENT SYSTEM                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                  ORCHESTRATOR (Custom, ADK-compatible)               │   │
│  │                                                                      │   │
│  │   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐        │   │
│  │   │  TESTER  │──▶│  TRIAGE  │──▶│  FIXER   │──▶│ VERIFIER │        │   │
│  │   │  Agent   │   │  Agent   │   │  Agent   │   │  Agent   │        │   │
│  │   └────┬─────┘   └────┬─────┘   └────┬─────┘   └────┬─────┘        │   │
│  │        │              │              │              │               │   │
│  └────────┼──────────────┼──────────────┼──────────────┼───────────────┘   │
│           │              │              │              │                    │
│           ▼              ▼              ▼              ▼                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │
│  │ Browserbase │  │   Redis     │  │   OpenAI    │  │   Vercel    │       │
│  │ + Stagehand │  │ (Vector DB) │  │    LLM      │  │   Deploy    │       │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘       │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      OBSERVABILITY LAYER                             │   │
│  │                                                                      │   │
│  │   ┌─────────────────────────┐   ┌─────────────────────────┐         │   │
│  │   │      W&B Weave          │──▶│    Marimo Dashboard     │         │   │
│  │   │   (Tracing/Logging)     │   │   (Visualization)       │         │   │
│  │   └─────────────────────────┘   └─────────────────────────┘         │   │
│  │                                                                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Note:** The current implementation uses a custom orchestrator with ADK/A2A-compatible interfaces. Full ADK/A2A integration is planned.

### 1.2 Data Flow

```
┌──────────────┐
│   Web App    │
│   (Vercel)   │
└──────┬───────┘
       │
       ▼
┌──────────────┐     ┌──────────────┐
│   Tester     │────▶│   Failure    │
│   Agent      │     │   Report     │
└──────────────┘     └──────┬───────┘
                            │
                            ▼
                     ┌──────────────┐     ┌──────────────┐
                     │   Triage     │◀───▶│    Redis     │
                     │   Agent      │     │  (Similar    │
                     └──────┬───────┘     │   Issues)    │
                            │             └──────────────┘
                            ▼
                     ┌──────────────┐
                     │  Diagnosis   │
                     │   Report     │
                     └──────┬───────┘
                            │
                            ▼
                     ┌──────────────┐     ┌──────────────┐
                     │   Fixer      │◀───▶│    Redis     │
                     │   Agent      │     │  (Fix        │
                     └──────┬───────┘     │   Patterns)  │
                            │             └──────────────┘
                            ▼
                     ┌──────────────┐
                     │    Patch     │
                     │    (Diff)    │
                     └──────┬───────┘
                            │
                            ▼
                     ┌──────────────┐     ┌──────────────┐
                     │  Verifier    │────▶│   Vercel     │
                     │   Agent      │     │   Deploy     │
                     └──────┬───────┘     └──────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │  Pass/Fail   │──┐
                     │   Result     │  │
                     └──────────────┘  │
                            │          │
            ┌───────────────┘          │ If Fail
            │                          │
            ▼                          ▼
     ┌──────────────┐          ┌──────────────┐
     │   Success    │          │   Iterate    │
     │   (Done)     │          │   (Loop)     │
     └──────────────┘          └──────────────┘
```

---

## 2. Agent Designs

### 2.1 Tester Agent

**Purpose:** Execute E2E tests and detect failures

**Inputs:**
- Test specifications (natural language or code)
- Target application URL

**Outputs:**
- Test result (pass/fail)
- Failure report with:
  - Error message
  - Stack trace
  - Screenshot
  - DOM state
  - Console logs
  - Network requests

**Process:**
```
1. Initialize Browserbase session
2. Load Stagehand with test spec
3. Execute test steps
4. Monitor for errors/assertions
5. On failure:
   a. Capture screenshot
   b. Extract DOM state
   c. Collect console logs
   d. Build failure report
6. Return structured result
```

**Key Methods:**
```typescript
interface TesterAgent {
  runTest(spec: TestSpec): Promise<TestResult>;
  captureFailure(error: Error): FailureReport;
  getScreenshot(): Promise<Buffer>;
  getDOMState(): Promise<string>;
  getConsoleLogs(): string[];
}
```

---

### 2.2 Triage Agent

**Purpose:** Diagnose failures and identify root cause

**Inputs:**
- Failure report from Tester Agent
- Access to codebase
- Access to Redis knowledge base

**Outputs:**
- Diagnosis report with:
  - Failure type classification
  - Root cause analysis
  - File and line localization
  - Similar past issues
  - Suggested fix approach

**Process:**
```
1. Parse error message and stack trace
2. Classify failure type:
   - UI_BUG: Missing handler, wrong element
   - BACKEND_ERROR: API failure, wrong route
   - TEST_FLAKY: Timing issue, race condition
   - DATA_ERROR: Invalid state, missing data
3. Localize to file/line in codebase
4. Query Redis for similar failures
5. Generate diagnosis with LLM assistance
6. Return structured diagnosis
```

**Classification Rules:**
```typescript
type FailureType =
  | 'UI_BUG'       // Missing onClick, wrong selector
  | 'BACKEND_ERROR' // 404, 500, wrong endpoint
  | 'TEST_FLAKY'    // Timeout, race condition
  | 'DATA_ERROR'    // Null reference, missing field
  | 'UNKNOWN';

interface DiagnosisReport {
  failureType: FailureType;
  rootCause: string;
  file: string;
  line: number;
  similarIssues: SimilarIssue[];
  suggestedFix: string;
  confidence: number;
}
```

---

### 2.3 Fixer Agent

**Purpose:** Generate code patches to fix bugs

**Inputs:**
- Diagnosis report from Triage Agent
- Relevant source code
- Similar past fixes from Redis

**Outputs:**
- Code patch (git diff format)
- Patch metadata

**Process:**
```
1. Load relevant source file(s)
2. Retrieve similar fix patterns from Redis
3. Construct LLM prompt with:
   - Diagnosis
   - Current code
   - Similar fixes as examples
4. Generate patch with LLM
5. Validate patch:
   - Syntax check
   - No obvious errors
   - Reasonable size
6. Format as git diff
7. Return patch with metadata
```

**Patch Generation Prompt Template:**
```
You are a senior developer fixing a bug.

## Bug Diagnosis
{diagnosis}

## Current Code ({file})
```{language}
{code}
```

## Similar Past Fixes
{similar_fixes}

## Instructions
1. Identify the exact location of the bug
2. Generate a minimal fix
3. Return ONLY the modified code section
4. Use the same coding style as existing code

## Output Format
Return a JSON object:
{
  "file": "path/to/file",
  "startLine": number,
  "endLine": number,
  "newCode": "fixed code here"
}
```

---

### 2.4 Verifier Agent

**Purpose:** Apply patches and verify fixes work

**Inputs:**
- Patch from Fixer Agent
- Original failing test
- Regression test list

**Outputs:**
- Verification result
- Deployment status
- Test results

**Process:**
```
1. Apply patch to local codebase
2. Run local syntax/lint check
3. Commit changes to git
4. Push to trigger Vercel deployment
5. Poll Vercel API for deployment status
6. Wait for deployment to complete
7. Re-run originally failing test
8. Run regression tests
9. Report results
10. If pass: store fix in Redis
11. If fail: return to Triage for next iteration
```

**Vercel Integration:**
```typescript
interface VerifierAgent {
  applyPatch(patch: Patch): Promise<void>;
  commitAndPush(message: string): Promise<string>;
  waitForDeployment(commitSha: string): Promise<DeploymentStatus>;
  runTest(test: TestSpec): Promise<TestResult>;
  runRegressionTests(): Promise<TestResult[]>;
}
```

---

## 3. Data Structures

### 3.1 Test Specification

```typescript
interface TestSpec {
  id: string;
  name: string;
  description: string;
  steps: TestStep[];
  expectedOutcome: string;
  timeout: number;
}

interface TestStep {
  action: 'navigate' | 'click' | 'type' | 'assert' | 'wait';
  target?: string;  // Selector or URL
  value?: string;   // Input value or assertion
  description: string;
}
```

### 3.2 Failure Report

```typescript
interface FailureReport {
  testId: string;
  timestamp: Date;
  step: number;
  error: {
    message: string;
    stack: string;
    type: string;
  };
  context: {
    url: string;
    screenshot: string;  // Base64 or URL
    domSnapshot: string;
    consoleLogs: string[];
    networkRequests: NetworkRequest[];
  };
}
```

### 3.3 Diagnosis Report

```typescript
interface DiagnosisReport {
  failureId: string;
  failureType: FailureType;
  rootCause: string;
  localization: {
    file: string;
    startLine: number;
    endLine: number;
    codeSnippet: string;
  };
  similarIssues: {
    id: string;
    similarity: number;
    fix: string;
  }[];
  suggestedFix: string;
  confidence: number;  // 0-1
}
```

### 3.4 Patch

```typescript
interface Patch {
  id: string;
  diagnosisId: string;
  file: string;
  diff: string;  // Git diff format
  description: string;
  metadata: {
    linesAdded: number;
    linesRemoved: number;
    llmModel: string;
    promptTokens: number;
  };
}
```

### 3.5 Redis Schema

```typescript
// Failure trace stored in Redis
interface FailureTrace {
  id: string;
  embedding: number[];  // Vector for similarity search
  errorMessage: string;
  stackTrace: string;
  file: string;
  line: number;
  failureType: FailureType;
  fix: {
    patchId: string;
    description: string;
    diff: string;
    success: boolean;
  };
  createdAt: Date;
}

// Redis index configuration
const failureIndex = {
  name: 'failure_idx',
  prefix: 'failure:',
  schema: {
    embedding: { type: 'VECTOR', algorithm: 'HNSW', dim: 1536 },
    errorMessage: { type: 'TEXT' },
    failureType: { type: 'TAG' },
    file: { type: 'TAG' },
    createdAt: { type: 'NUMERIC', sortable: true }
  }
};
```

---

## 4. Dashboard Design

### 4.1 Main Dashboard Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  QAgent Dashboard                                    [Live] 🟢  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐           │
│  │  Pass Rate    │  │  Avg Fix Time │  │  Total Bugs   │           │
│  │     87%       │  │    3.2 min    │  │      23       │           │
│  │   ↑ 12%       │  │   ↓ 40%       │  │   Fixed: 20   │           │
│  └───────────────┘  └───────────────┘  └───────────────┘           │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Pass Rate Over Time                                         │   │
│  │  100% ┤                                          ●───────●   │   │
│  │   80% ┤                              ●───────●               │   │
│  │   60% ┤                  ●───────●                           │   │
│  │   40% ┤      ●───────●                                       │   │
│  │   20% ┤  ●                                                   │   │
│  │    0% ┼───────────────────────────────────────────────────   │   │
│  │       Run 1   Run 2   Run 3   Run 4   Run 5   Run 6          │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────┐  ┌──────────────────────────────────┐   │
│  │  Bug Types           │  │  Recent Fixes                     │   │
│  │  ┌────────────────┐  │  │  ✓ Missing onClick - 2m ago      │   │
│  │  │ UI: 45%        │  │  │  ✓ Wrong API route - 5m ago      │   │
│  │  │ Backend: 30%   │  │  │  ✓ Typo in variable - 8m ago     │   │
│  │  │ Data: 20%      │  │  │  ✗ Null reference - retrying     │   │
│  │  │ Other: 5%      │  │  │                                   │   │
│  │  └────────────────┘  │  │                                   │   │
│  └──────────────────────┘  └──────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 Marimo Components

```python
import marimo as mo

# Key metrics cards
pass_rate = mo.stat(
    value="87%",
    label="Pass Rate",
    delta="+12%",
    delta_color="green"
)

# Pass rate chart
pass_chart = mo.ui.altair_chart(
    alt.Chart(data).mark_line().encode(
        x='run:O',
        y='pass_rate:Q'
    )
)

# Bug types pie chart
bug_types = mo.ui.altair_chart(
    alt.Chart(type_data).mark_arc().encode(
        theta='count:Q',
        color='type:N'
    )
)

# Recent fixes table
fixes_table = mo.ui.table(
    data=recent_fixes,
    columns=['status', 'bug', 'time', 'iterations']
)
```

---

## 5. API Designs

### 5.1 Agent Communication Protocol

```typescript
// Message passed between agents
interface AgentMessage {
  id: string;
  from: AgentType;
  to: AgentType;
  type: MessageType;
  payload: any;
  timestamp: Date;
  traceId: string;  // For Weave logging
}

type AgentType = 'orchestrator' | 'tester' | 'triage' | 'fixer' | 'verifier';
type MessageType = 'request' | 'response' | 'error';
```

### 5.2 External API Integrations

```typescript
// Browserbase
const browserbase = new Browserbase({
  apiKey: process.env.BROWSERBASE_API_KEY,
  projectId: process.env.BROWSERBASE_PROJECT_ID
});

// Stagehand
const stagehand = new Stagehand({
  browserbase,
  model: 'gpt-4'
});

// Redis
const redis = new Redis(process.env.REDIS_URL);

// Vercel
const vercel = new Vercel({
  token: process.env.VERCEL_TOKEN
});

// Weave
import weave from 'weave';
weave.init({ project: 'qagent' });

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});
```

---

## 6. Error Handling

### 6.1 Retry Strategy

| Error Type | Retries | Backoff | Action |
|------------|---------|---------|--------|
| Network timeout | 3 | Exponential | Retry with backoff |
| Browser crash | 2 | Linear | New session |
| LLM rate limit | 5 | Exponential | Wait and retry |
| Vercel deploy fail | 1 | None | Log and skip |
| Redis unavailable | 3 | Linear | Proceed without cache |

### 6.2 Circuit Breaker

```typescript
interface CircuitBreaker {
  failureThreshold: 5;      // Open after 5 failures
  resetTimeout: 60000;      // Try again after 60s
  halfOpenRequests: 1;      // Allow 1 test request
}
```

---

## 7. Logging & Tracing

### 7.1 Weave Trace Structure

```
Run: qagent-run-123
├── Orchestrator
│   ├── [10:00:00] Start run
│   ├── [10:00:01] Dispatch to Tester
│   │   └── Tester
│   │       ├── [10:00:02] Initialize browser
│   │       ├── [10:00:05] Execute test "checkout"
│   │       ├── [10:00:15] Test failed
│   │       └── [10:00:16] Return failure report
│   ├── [10:00:17] Dispatch to Triage
│   │   └── Triage
│   │       ├── [10:00:18] Parse error
│   │       ├── [10:00:19] Query Redis (2 similar)
│   │       ├── [10:00:20] Generate diagnosis
│   │       └── [10:00:21] Return diagnosis
│   ├── [10:00:22] Dispatch to Fixer
│   │   └── Fixer
│   │       ├── [10:00:23] Load source file
│   │       ├── [10:00:24] Call LLM
│   │       ├── [10:00:28] Validate patch
│   │       └── [10:00:29] Return patch
│   ├── [10:00:30] Dispatch to Verifier
│   │   └── Verifier
│   │       ├── [10:00:31] Apply patch
│   │       ├── [10:00:32] Commit and push
│   │       ├── [10:00:33] Trigger deploy
│   │       ├── [10:01:15] Deploy complete
│   │       ├── [10:01:16] Re-run test
│   │       ├── [10:01:25] Test passed!
│   │       └── [10:01:26] Return success
│   └── [10:01:27] Run complete (1 iteration)
```

### 7.2 Metrics Logged

| Metric | Type | Description |
|--------|------|-------------|
| `test_duration_ms` | Gauge | Time to run single test |
| `patch_generation_ms` | Gauge | Time to generate patch |
| `deploy_duration_ms` | Gauge | Time for Vercel deploy |
| `iterations_per_bug` | Counter | Fix attempts needed |
| `redis_hit_rate` | Gauge | % of queries with results |
| `fix_success_rate` | Gauge | % of fixes that worked |
| `llm_tokens_used` | Counter | API token consumption |

---

*Last updated: 2024*
