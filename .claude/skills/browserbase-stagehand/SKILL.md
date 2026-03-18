# Skill: Browserbase + Stagehand

## When to Use This Skill

Use this skill when:
- Implementing the Tester Agent
- Writing E2E tests for the demo app
- Setting up browser automation
- Capturing screenshots and DOM state on failures
- Converting natural language to browser actions

Do NOT use this skill when:
- Working on non-browser-related agents (Fixer, Triage)
- Implementing Redis or Vercel integrations

---

## Overview

Browserbase provides cloud browser infrastructure for running tests in isolated, consistent environments. Stagehand is an AI-powered browser automation SDK that provides "the predictability of code and the adaptability of AI" - it can interpret natural language test descriptions and convert them to deterministic browser actions.

Together, they enable:
- Running real browser tests (not jsdom)
- Writing tests in natural language
- Reliable, repeatable test execution
- Screenshot and DOM capture on failure

---

## Key Concepts

### Browserbase Sessions

A session is an isolated browser instance. Each test run should create a new session to ensure clean state.

```typescript
const browser = await browserbase.createSession({
  projectId: process.env.BROWSERBASE_PROJECT_ID
});
```

### Stagehand Actions

Stagehand interprets natural language instructions:

```typescript
await stagehand.act("Click the login button");
await stagehand.act("Type 'user@example.com' into the email field");
await stagehand.assert("I see a welcome message");
```

### Failure Capture

On test failure, capture evidence:
- Screenshot of current page state
- DOM HTML snapshot
- Console logs
- Network request/response data

---

## Common Patterns

### Initialize Browser Session

```typescript
import { Browserbase } from '@browserbase/sdk';
import { Stagehand } from 'stagehand';

const browserbase = new Browserbase({
  apiKey: process.env.BROWSERBASE_API_KEY,
  projectId: process.env.BROWSERBASE_PROJECT_ID
});

const stagehand = new Stagehand({
  browserbase,
  model: 'gpt-4'
});

await stagehand.init();
```

### Execute Test Steps

```typescript
// Natural language approach
await stagehand.act("Go to https://example.com");
await stagehand.act("Click the Sign Up button");
await stagehand.act("Fill in the email field with test@example.com");
await stagehand.act("Fill in the password field with password123");
await stagehand.act("Click Submit");

// Assert expected outcome
const result = await stagehand.assert("I see 'Welcome!' on the page");
```

### Capture Failure Evidence

```typescript
async function captureFailure(): Promise<FailureEvidence> {
  const screenshot = await stagehand.page.screenshot({
    fullPage: true,
    encoding: 'base64'
  });

  const domSnapshot = await stagehand.page.content();

  const consoleLogs = await stagehand.page.evaluate(() => {
    // Collect console messages (requires setup)
    return window.__consoleLogs || [];
  });

  return {
    screenshot,
    domSnapshot,
    consoleLogs,
    url: stagehand.page.url()
  };
}
```

---

## Best Practices

1. **Create fresh sessions for each test** - Don't reuse browser state
2. **Set reasonable timeouts** - Default 30s, but adjust for slow pages
3. **Capture evidence early** - Screenshot immediately on failure
4. **Use specific assertions** - "I see 'Welcome John'" vs "I see welcome"
5. **Handle async properly** - Many page actions are asynchronous

---

## Common Pitfalls

### Session Limits
- Browserbase free tier has session limits
- Clean up sessions after tests complete
- Use `browser.close()` in finally blocks

### Flaky Tests
- Add waits for dynamic content
- Use `stagehand.waitFor()` before assertions
- Retry transient failures

### Selector Issues
- Stagehand handles selectors via AI, but may need hints
- If element not found, provide more context in the instruction
- Use visible text or ARIA labels when possible

---

## Related Skills

- `qagent-agents/` - Agent implementation patterns
- `wandb-weave/` - Logging test results

---

## References

- [Stagehand Documentation](https://www.stagehand.dev/)
- [Browserbase Documentation](https://docs.browserbase.com/)
- [Stagehand GitHub](https://github.com/browserbase/stagehand)
