# Reference: Browserbase + Stagehand v3

Copy-paste code patterns for browser automation with Stagehand v3.

---

## Quick Start

```typescript
import { Stagehand } from '@browserbasehq/stagehand';

// Initialize with Browserbase cloud
const stagehand = new Stagehand({
  env: 'BROWSERBASE',
  apiKey: process.env.BROWSERBASE_API_KEY,
  projectId: process.env.BROWSERBASE_PROJECT_ID,
  model: 'gpt-4o',  // or { modelName: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY }
  verbose: 0,  // 0 = silent, 1 = info, 2 = debug
});

await stagehand.init();

// Get the page from context
const page = stagehand.context.pages()[0];

// Run test
await page.goto('https://example.com');
await stagehand.act('Click the login button');
const result = await stagehand.observe('Find all buttons on this page');

// Cleanup
await stagehand.close();
```

---

## Stagehand v3 Constructor Options

```typescript
interface V3Options {
  env: 'LOCAL' | 'BROWSERBASE';  // Required
  apiKey?: string;               // Browserbase API key (for BROWSERBASE env)
  projectId?: string;            // Browserbase project ID
  model?: ModelConfiguration;    // Model to use for AI actions
  verbose?: 0 | 1 | 2;          // Logging level
  domSettleTimeoutMs?: number;   // Wait for DOM to settle (default: 30000)
}

// ModelConfiguration can be:
// 1. Simple string: 'gpt-4o', 'gpt-4o-mini', 'gemini-2.0-flash'
// 2. Object with apiKey:
type ModelConfiguration =
  | string  // e.g., 'gpt-4o'
  | {
      modelName: 'gpt-4o' | 'gpt-4o-mini' | 'gemini-2.0-flash' | string;
      apiKey?: string;  // Override API key for this model
    };
```

---

## Code Patterns

### Pattern 1: Basic Test Runner (v3)

**Use when:** Implementing the Tester Agent core loop

```typescript
import { Stagehand, type Page } from '@browserbasehq/stagehand';

interface TestSpec {
  id: string;
  name: string;
  steps: { action: string; expected?: string }[];
  url: string;
}

interface TestResult {
  passed: boolean;
  failedStep?: number;
  error?: string;
  screenshot?: string;
  duration: number;
}

async function runTest(spec: TestSpec): Promise<TestResult> {
  const startTime = Date.now();

  // Use Gemini if available, otherwise OpenAI
  const useGemini = !!process.env.GOOGLE_API_KEY;

  const stagehand = new Stagehand({
    env: 'BROWSERBASE',
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    model: useGemini
      ? { modelName: 'gemini-2.0-flash', apiKey: process.env.GOOGLE_API_KEY }
      : { modelName: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY },
    verbose: 0,
  });

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];

    await page.goto(spec.url, {
      waitUntil: 'domcontentloaded',
      timeoutMs: 30000,  // Note: use timeoutMs, not timeout
    });

    for (let i = 0; i < spec.steps.length; i++) {
      const step = spec.steps[i];

      try {
        await stagehand.act(step.action);

        if (step.expected) {
          const observations = await stagehand.observe(step.expected);
          if (!observations || observations.length === 0) {
            const screenshot = await page.screenshot({ encoding: 'base64' });
            return {
              passed: false,
              failedStep: i,
              error: `Assertion failed: ${step.expected}`,
              screenshot,
              duration: Date.now() - startTime
            };
          }
        }
      } catch (error) {
        const screenshot = await page.screenshot({ encoding: 'base64' });
        return {
          passed: false,
          failedStep: i,
          error: error instanceof Error ? error.message : String(error),
          screenshot,
          duration: Date.now() - startTime
        };
      }
    }

    return { passed: true, duration: Date.now() - startTime };
  } finally {
    await stagehand.close();
  }
}
```

### Pattern 2: Element Discovery with observe()

**Use when:** Crawling pages to discover interactive elements

```typescript
import { Stagehand } from '@browserbasehq/stagehand';

interface DiscoveredElement {
  selector: string;
  description?: string;
  type: 'button' | 'link' | 'input' | 'form';
}

async function discoverElements(url: string): Promise<DiscoveredElement[]> {
  const stagehand = new Stagehand({
    env: 'BROWSERBASE',
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    model: { modelName: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY },
    verbose: 0,
  });

  await stagehand.init();
  const page = stagehand.context.pages()[0];

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeoutMs: 30000,
    });

    const elements: DiscoveredElement[] = [];

    // Find clickable elements
    const clickableObservations = await stagehand.observe(
      'Find all clickable buttons and links on this page'
    );

    for (const obs of clickableObservations) {
      elements.push({
        selector: obs.selector,
        description: obs.description,
        type: obs.selector.includes('button') ? 'button' : 'link',
      });
    }

    // Find form inputs
    const inputObservations = await stagehand.observe(
      'Find all input fields and text areas on this page'
    );

    for (const obs of inputObservations) {
      elements.push({
        selector: obs.selector,
        description: obs.description,
        type: 'input',
      });
    }

    return elements;
  } finally {
    await stagehand.close();
  }
}
```

### Pattern 3: Failure Report Builder

**Use when:** Capturing detailed failure evidence

```typescript
import { Stagehand, type Page } from '@browserbasehq/stagehand';

interface FailureReport {
  testId: string;
  timestamp: Date;
  step: number;
  error: {
    message: string;
    stack?: string;
    type: string;
  };
  context: {
    url: string;
    screenshot: string;
    domSnapshot: string;
    consoleLogs: ConsoleLog[];
  };
}

interface ConsoleLog {
  type: 'log' | 'error' | 'warn';
  message: string;
  timestamp: number;
}

async function buildFailureReport(
  page: Page,
  testId: string,
  step: number,
  error: Error
): Promise<FailureReport> {
  // Capture screenshot
  const screenshot = await page.screenshot({
    fullPage: true,
    encoding: 'base64'
  });

  // Capture DOM
  const domSnapshot = await page.content();

  // Get console logs (requires prior setup)
  const consoleLogs = await page.evaluate(() => {
    return (window as any).__consoleLogs || [];
  });

  return {
    testId,
    timestamp: new Date(),
    step,
    error: {
      message: error.message,
      stack: error.stack,
      type: error.name
    },
    context: {
      url: page.url(),
      screenshot,
      domSnapshot,
      consoleLogs
    }
  };
}
```

### Pattern 4: Console Log Capture Setup

**Use when:** Need to capture JavaScript console errors

```typescript
import { type Page } from '@browserbasehq/stagehand';

async function setupConsoleCapture(page: Page) {
  await page.evaluate(() => {
    (window as any).__consoleLogs = [];
    const originalConsole = {
      log: console.log,
      error: console.error,
      warn: console.warn
    };

    console.log = (...args) => {
      (window as any).__consoleLogs.push({
        type: 'log',
        message: args.map(String).join(' '),
        timestamp: Date.now()
      });
      originalConsole.log.apply(console, args);
    };

    console.error = (...args) => {
      (window as any).__consoleLogs.push({
        type: 'error',
        message: args.map(String).join(' '),
        timestamp: Date.now()
      });
      originalConsole.error.apply(console, args);
    };

    console.warn = (...args) => {
      (window as any).__consoleLogs.push({
        type: 'warn',
        message: args.map(String).join(' '),
        timestamp: Date.now()
      });
      originalConsole.warn.apply(console, args);
    };

    // Capture unhandled errors
    window.onerror = (msg, url, line, col, error) => {
      (window as any).__consoleLogs.push({
        type: 'uncaught',
        message: `${msg} at ${url}:${line}:${col}`,
        timestamp: Date.now()
      });
    };
  });
}
```

### Pattern 5: Test Spec Format

**Use when:** Defining test specifications

```typescript
const signupTestSpec: TestSpec = {
  id: 'test-signup-001',
  name: 'User Signup Flow',
  url: 'http://localhost:3000',
  steps: [
    { action: 'Click the Sign Up link' },
    { action: 'Type "test@example.com" into the email field' },
    { action: 'Type "password123" into the password field' },
    { action: 'Type "password123" into the confirm password field' },
    { action: 'Click the Create Account button' },
    { action: 'Wait for the page to load', expected: 'I see "Welcome" on the page' }
  ]
};
```

---

## Configuration Examples

### Basic Configuration (v3)

```typescript
const stagehand = new Stagehand({
  env: 'BROWSERBASE',
  apiKey: process.env.BROWSERBASE_API_KEY,
  projectId: process.env.BROWSERBASE_PROJECT_ID,
  model: 'gpt-4o',  // Simple string model
  verbose: 0,
});
```

### Advanced Configuration (v3)

```typescript
const stagehand = new Stagehand({
  env: 'BROWSERBASE',
  apiKey: process.env.BROWSERBASE_API_KEY,
  projectId: process.env.BROWSERBASE_PROJECT_ID,
  model: {
    modelName: 'gpt-4o',
    apiKey: process.env.OPENAI_API_KEY,  // Explicit API key
  },
  verbose: 1,  // Enable info logging
  domSettleTimeoutMs: 5000,  // Wait 5s for DOM to settle
});

await stagehand.init();
const page = stagehand.context.pages()[0];

// Custom viewport
await page.setViewportSize({
  width: 1280,
  height: 720
});
```

### Multi-Model Support (Gemini/OpenAI)

```typescript
// Prefer Gemini, fall back to OpenAI
const useGemini = !!process.env.GOOGLE_API_KEY;

const stagehand = new Stagehand({
  env: 'BROWSERBASE',
  apiKey: process.env.BROWSERBASE_API_KEY,
  projectId: process.env.BROWSERBASE_PROJECT_ID,
  model: useGemini
    ? { modelName: 'gemini-2.0-flash', apiKey: process.env.GOOGLE_API_KEY }
    : { modelName: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY },
  verbose: 0,
});
```

---

## Key API Differences (v2 → v3)

| v2 (Old) | v3 (Current) |
|----------|--------------|
| `import { Stagehand } from 'stagehand'` | `import { Stagehand } from '@browserbasehq/stagehand'` |
| `new Stagehand({ browserbase, model: 'gpt-4' })` | `new Stagehand({ env: 'BROWSERBASE', model: 'gpt-4o' })` |
| `stagehand.page` | `stagehand.context.pages()[0]` |
| `stagehand.assert("...")` | `stagehand.observe("...") + check result` |
| `page.goto(url, { timeout: 30000 })` | `page.goto(url, { timeoutMs: 30000 })` |
| `timeout: 30000` (in config) | `domSettleTimeoutMs: 30000` |

---

## Common Commands

```bash
# Install Stagehand v3
pnpm add @browserbasehq/stagehand

# Check types
pnpm tsc --noEmit

# Run specific test
pnpm run test:e2e -- --grep "checkout"
```

---

## Troubleshooting

### Issue: "Stagehand is not a constructor"

**Symptom:** TypeError when creating Stagehand instance

**Solution:** Check import path and constructor options
```typescript
// Wrong (v2):
import { Stagehand } from 'stagehand';
new Stagehand({ browserbase, model: 'gpt-4' });

// Correct (v3):
import { Stagehand } from '@browserbasehq/stagehand';
new Stagehand({
  env: 'BROWSERBASE',
  apiKey: process.env.BROWSERBASE_API_KEY,
  projectId: process.env.BROWSERBASE_PROJECT_ID,
  model: 'gpt-4o',
});
```

### Issue: "modelName does not exist on type"

**Symptom:** TypeScript error with modelName/modelClientOptions

**Solution:** Use the `model` property, not `modelName`
```typescript
// Wrong:
new Stagehand({
  modelName: 'gpt-4o',
  modelClientOptions: { apiKey: '...' },
});

// Correct:
new Stagehand({
  model: { modelName: 'gpt-4o', apiKey: '...' },
});
```

### Issue: page.goto timeout error

**Symptom:** "timeout" property doesn't exist

**Solution:** Use `timeoutMs` instead of `timeout`
```typescript
// Wrong:
await page.goto(url, { timeout: 30000 });

// Correct:
await page.goto(url, { timeoutMs: 30000 });
```

### Issue: Session timeout

**Symptom:** Test fails with "Session closed" error

**Solution:**
```typescript
const stagehand = new Stagehand({
  env: 'BROWSERBASE',
  // ...
  domSettleTimeoutMs: 60000,  // 60 seconds
});
```

### Issue: Element not found

**Symptom:** "Could not find element" error

**Solution:**
```typescript
// Be more specific in the action description
// Bad:
await stagehand.act("Click button");
// Good:
await stagehand.act("Click the blue Submit button at the bottom of the form");
```

---

## Cheat Sheet

| Task | Code |
|------|------|
| Initialize | `await stagehand.init()` |
| Get Page | `const page = stagehand.context.pages()[0]` |
| Navigate | `await page.goto(url, { timeoutMs: 30000 })` |
| Click | `await stagehand.act("Click the button")` |
| Type | `await stagehand.act("Type 'text' into field")` |
| Observe | `await stagehand.observe("Find all buttons")` |
| Screenshot | `await page.screenshot({ encoding: 'base64' })` |
| Get DOM | `await page.content()` |
| Close | `await stagehand.close()` |
| Get URL | `page.url()` |
| Session ID | `(stagehand as any).browserbaseSessionID` |
