# Reference: QAgent Agents

Copy-paste code patterns for implementing the core agents.

---

## Quick Start

```typescript
// Run the full QAgent loop
const orchestrator = new QAgentOrchestrator();
const result = await orchestrator.run({
  testSpec: checkoutTestSpec,
  appUrl: 'https://demo.vercel.app'
});

console.log('Success:', result.success);
console.log('Iterations:', result.iterations);
```

---

## Code Patterns

### Pattern 1: Tester Agent Implementation

```typescript
import { Stagehand } from 'stagehand';
import { Browserbase } from '@browserbase/sdk';
import weave from 'weave';

interface TestSpec {
  id: string;
  name: string;
  url: string;
  steps: { action: string; expected?: string }[];
}

interface TestResult {
  passed: boolean;
  duration: number;
  failureReport?: FailureReport;
}

interface FailureReport {
  testId: string;
  timestamp: Date;
  step: number;
  error: { message: string; stack: string; type: string };
  context: {
    url: string;
    screenshot: string;
    domSnapshot: string;
    consoleLogs: string[];
  };
}

class TesterAgent {
  private browserbase: Browserbase;

  constructor() {
    this.browserbase = new Browserbase({
      apiKey: process.env.BROWSERBASE_API_KEY!,
      projectId: process.env.BROWSERBASE_PROJECT_ID!
    });
  }

  @weave.op()
  async runTest(spec: TestSpec): Promise<TestResult> {
    const startTime = Date.now();
    const stagehand = new Stagehand({
      browserbase: this.browserbase,
      model: 'gpt-4'
    });

    try {
      await stagehand.init();
      await stagehand.act(`Go to ${spec.url}`);

      for (let i = 0; i < spec.steps.length; i++) {
        const step = spec.steps[i];

        try {
          await stagehand.act(step.action);

          if (step.expected) {
            const passed = await stagehand.assert(step.expected);
            if (!passed) {
              return {
                passed: false,
                duration: Date.now() - startTime,
                failureReport: await this.captureFailure(
                  stagehand, spec.id, i,
                  new Error(`Assertion failed: ${step.expected}`)
                )
              };
            }
          }
        } catch (error) {
          return {
            passed: false,
            duration: Date.now() - startTime,
            failureReport: await this.captureFailure(
              stagehand, spec.id, i,
              error instanceof Error ? error : new Error(String(error))
            )
          };
        }
      }

      return { passed: true, duration: Date.now() - startTime };
    } finally {
      await stagehand.close();
    }
  }

  private async captureFailure(
    stagehand: Stagehand,
    testId: string,
    step: number,
    error: Error
  ): Promise<FailureReport> {
    const page = stagehand.page;

    return {
      testId,
      timestamp: new Date(),
      step,
      error: {
        message: error.message,
        stack: error.stack || '',
        type: error.name
      },
      context: {
        url: page.url(),
        screenshot: await page.screenshot({ encoding: 'base64', fullPage: true }),
        domSnapshot: await page.content(),
        consoleLogs: [] // Would need setup to capture
      }
    };
  }
}
```

### Pattern 2: Triage Agent Implementation

```typescript
import { createClient } from 'redis';
import OpenAI from 'openai';
import weave from 'weave';
import fs from 'fs/promises';

type FailureType = 'UI_BUG' | 'BACKEND_ERROR' | 'TEST_FLAKY' | 'DATA_ERROR' | 'UNKNOWN';

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
  similarIssues: { id: string; similarity: number; fix: string }[];
  suggestedFix: string;
  confidence: number;
}

class TriageAgent {
  private redis: ReturnType<typeof createClient>;
  private openai: OpenAI;

  constructor() {
    this.redis = createClient({ url: process.env.REDIS_URL });
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async init() {
    await this.redis.connect();
  }

  @weave.op()
  async diagnose(failure: FailureReport): Promise<DiagnosisReport> {
    // 1. Classify failure type
    const failureType = this.classifyFailure(failure.error.message);

    // 2. Localize to file/line
    const localization = await this.localize(failure);

    // 3. Find similar past failures
    const similarIssues = await this.findSimilar(failure.error.message);

    // 4. Generate diagnosis with LLM
    const { rootCause, suggestedFix, confidence } = await this.generateDiagnosis(
      failure, failureType, localization, similarIssues
    );

    return {
      failureId: failure.testId,
      failureType,
      rootCause,
      localization,
      similarIssues,
      suggestedFix,
      confidence
    };
  }

  private classifyFailure(errorMessage: string): FailureType {
    const msg = errorMessage.toLowerCase();

    if (msg.includes('onclick') || msg.includes('handler') || msg.includes('click')) {
      return 'UI_BUG';
    }
    if (msg.includes('404') || msg.includes('500') || msg.includes('api') || msg.includes('fetch')) {
      return 'BACKEND_ERROR';
    }
    if (msg.includes('timeout') || msg.includes('race')) {
      return 'TEST_FLAKY';
    }
    if (msg.includes('null') || msg.includes('undefined') || msg.includes('cannot read')) {
      return 'DATA_ERROR';
    }
    return 'UNKNOWN';
  }

  private async localize(failure: FailureReport): Promise<DiagnosisReport['localization']> {
    // Parse stack trace to find file:line
    const stackLines = failure.error.stack.split('\n');
    for (const line of stackLines) {
      const match = line.match(/at .+ \((.+):(\d+):(\d+)\)/);
      if (match) {
        const [, file, lineNum] = match;
        if (!file.includes('node_modules')) {
          try {
            const content = await fs.readFile(file, 'utf-8');
            const lines = content.split('\n');
            const start = Math.max(0, parseInt(lineNum) - 3);
            const end = Math.min(lines.length, parseInt(lineNum) + 3);
            const snippet = lines.slice(start, end).join('\n');

            return {
              file,
              startLine: start + 1,
              endLine: end,
              codeSnippet: snippet
            };
          } catch {
            // File not found, continue
          }
        }
      }
    }

    return { file: 'unknown', startLine: 0, endLine: 0, codeSnippet: '' };
  }

  @weave.op()
  private async findSimilar(errorMessage: string): Promise<DiagnosisReport['similarIssues']> {
    // Generate embedding
    const embResponse = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: errorMessage
    });
    const embedding = embResponse.data[0].embedding;
    const vectorBuffer = Buffer.from(new Float32Array(embedding).buffer);

    // Search Redis
    try {
      const results = await this.redis.ft.search(
        'failure_idx',
        '*=>[KNN 3 @embedding $vec AS score]',
        {
          PARAMS: { vec: vectorBuffer },
          RETURN: ['error_message', 'fix_description', 'fix_diff', 'score'],
          SORTBY: { BY: 'score', DIRECTION: 'ASC' },
          DIALECT: 2
        }
      );

      return results.documents
        .filter((doc: any) => doc.value.fix_description)
        .map((doc: any) => ({
          id: doc.id,
          similarity: 1 - parseFloat(doc.value.score),
          fix: doc.value.fix_description
        }));
    } catch {
      return []; // Index might not exist yet
    }
  }

  private async generateDiagnosis(
    failure: FailureReport,
    failureType: FailureType,
    localization: DiagnosisReport['localization'],
    similarIssues: DiagnosisReport['similarIssues']
  ): Promise<{ rootCause: string; suggestedFix: string; confidence: number }> {
    const prompt = `You are diagnosing a test failure.

Error: ${failure.error.message}
Type: ${failureType}
File: ${localization.file}
Code:
\`\`\`
${localization.codeSnippet}
\`\`\`

Similar past fixes:
${similarIssues.map(i => `- ${i.fix}`).join('\n') || 'None found'}

Provide:
1. Root cause (1 sentence)
2. Suggested fix (1 sentence)
3. Confidence (0-1)

Respond in JSON: { "rootCause": "...", "suggestedFix": "...", "confidence": 0.X }`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    });

    return JSON.parse(response.choices[0].message.content!);
  }
}
```

### Pattern 3: Fixer Agent Implementation

```typescript
import OpenAI from 'openai';
import { createClient } from 'redis';
import fs from 'fs/promises';
import weave from 'weave';
import { v4 as uuidv4 } from 'uuid';

interface Patch {
  id: string;
  file: string;
  diff: string;
  description: string;
  changes: { line: number; old: string; new: string }[];
}

class FixerAgent {
  private openai: OpenAI;
  private redis: ReturnType<typeof createClient>;

  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.redis = createClient({ url: process.env.REDIS_URL });
  }

  @weave.op()
  async generatePatch(diagnosis: DiagnosisReport): Promise<Patch> {
    // 1. Load source file
    const sourceCode = await fs.readFile(diagnosis.localization.file, 'utf-8');

    // 2. Get fix patterns from Redis
    const patterns = await this.getFixPatterns(diagnosis.failureType);

    // 3. Generate patch with LLM
    const patch = await this.callLLM(diagnosis, sourceCode, patterns);

    return patch;
  }

  private async getFixPatterns(failureType: string): Promise<string[]> {
    try {
      const results = await this.redis.ft.search(
        'failure_idx',
        `@failure_type:{${failureType}} @success:{true}`,
        { RETURN: ['fix_diff'], LIMIT: { from: 0, size: 3 } }
      );

      return results.documents
        .map((doc: any) => doc.value.fix_diff)
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  @weave.op()
  private async callLLM(
    diagnosis: DiagnosisReport,
    sourceCode: string,
    patterns: string[]
  ): Promise<Patch> {
    const prompt = `You are a senior developer fixing a bug.

## Bug Diagnosis
- Type: ${diagnosis.failureType}
- Root Cause: ${diagnosis.rootCause}
- Suggested Fix: ${diagnosis.suggestedFix}
- File: ${diagnosis.localization.file}
- Lines: ${diagnosis.localization.startLine}-${diagnosis.localization.endLine}

## Current Code
\`\`\`typescript
${sourceCode}
\`\`\`

## Similar Past Fixes
${patterns.map((p, i) => `Fix ${i + 1}:\n${p}`).join('\n\n') || 'None available'}

## Instructions
1. Generate a minimal fix for the bug
2. Only change what's necessary
3. Keep the same coding style

## Output Format
Return JSON:
{
  "description": "Brief description of the fix",
  "changes": [
    { "line": <line number>, "old": "original line", "new": "fixed line" }
  ]
}`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0].message.content!);

    // Generate diff from changes
    const diff = this.generateDiff(diagnosis.localization.file, result.changes);

    return {
      id: uuidv4(),
      file: diagnosis.localization.file,
      diff,
      description: result.description,
      changes: result.changes
    };
  }

  private generateDiff(file: string, changes: { line: number; old: string; new: string }[]): string {
    let diff = `--- a/${file}\n+++ b/${file}\n`;

    for (const change of changes) {
      diff += `@@ -${change.line},1 +${change.line},1 @@\n`;
      diff += `-${change.old}\n`;
      diff += `+${change.new}\n`;
    }

    return diff;
  }
}
```

### Pattern 4: Verifier Agent Implementation

```typescript
import { execSync } from 'child_process';
import fs from 'fs/promises';
import weave from 'weave';

interface VerificationResult {
  passed: boolean;
  deployUrl: string;
  duration: number;
  error?: string;
}

class VerifierAgent {
  private tester: TesterAgent;

  constructor() {
    this.tester = new TesterAgent();
  }

  @weave.op()
  async verify(patch: Patch, testSpec: TestSpec): Promise<VerificationResult> {
    const startTime = Date.now();

    try {
      // 1. Apply patch
      await this.applyPatch(patch);

      // 2. Verify syntax
      await this.checkSyntax();

      // 3. Commit and push
      await this.commitAndPush(patch.description);

      // 4. Wait for Vercel deployment
      const deployUrl = await this.waitForDeployment();

      // 5. Re-run test
      const testResult = await this.tester.runTest({
        ...testSpec,
        url: deployUrl
      });

      // 6. Store successful fix in Redis (if passed)
      if (testResult.passed) {
        await this.storeSuccessfulFix(patch);
      }

      return {
        passed: testResult.passed,
        deployUrl,
        duration: Date.now() - startTime
      };
    } catch (error) {
      // Rollback on failure
      await this.rollback();

      return {
        passed: false,
        deployUrl: '',
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async applyPatch(patch: Patch): Promise<void> {
    // Read current file
    const content = await fs.readFile(patch.file, 'utf-8');
    const lines = content.split('\n');

    // Apply changes
    for (const change of patch.changes) {
      if (lines[change.line - 1].trim() === change.old.trim()) {
        lines[change.line - 1] = change.new;
      }
    }

    // Write updated file
    await fs.writeFile(patch.file, lines.join('\n'));
  }

  private async checkSyntax(): Promise<void> {
    execSync('pnpm tsc --noEmit', { stdio: 'pipe' });
  }

  private async commitAndPush(message: string): Promise<void> {
    execSync('git add -A', { stdio: 'pipe' });
    execSync(`git commit -m "fix: ${message}"`, { stdio: 'pipe' });
    execSync('git push origin main', { stdio: 'pipe' });
  }

  private async waitForDeployment(): Promise<string> {
    const timeout = 120000; // 2 minutes
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const response = await fetch(
        `https://api.vercel.com/v6/deployments?projectId=${process.env.VERCEL_PROJECT_ID}&limit=1`,
        { headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` } }
      );
      const data = await response.json();
      const deployment = data.deployments[0];

      if (deployment.readyState === 'READY') {
        return `https://${deployment.url}`;
      }

      if (deployment.readyState === 'ERROR') {
        throw new Error('Deployment failed');
      }

      await new Promise(r => setTimeout(r, 5000));
    }

    throw new Error('Deployment timeout');
  }

  private async rollback(): Promise<void> {
    execSync('git checkout .', { stdio: 'pipe' });
  }

  private async storeSuccessfulFix(patch: Patch): Promise<void> {
    // Implementation would store in Redis
  }
}
```

---

## Cheat Sheet

| Agent | Input | Output | Key Deps |
|-------|-------|--------|----------|
| Tester | TestSpec | TestResult + FailureReport | Browserbase, Stagehand |
| Triage | FailureReport | DiagnosisReport | Redis, OpenAI |
| Fixer | DiagnosisReport | Patch | Redis, OpenAI |
| Verifier | Patch + TestSpec | VerificationResult | Vercel, Git, Tester |
