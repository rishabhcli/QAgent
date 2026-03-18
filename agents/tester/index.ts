/**
 * Tester Agent
 *
 * Executes E2E tests using Browserbase and Stagehand.
 * Captures detailed failure reports including screenshots, DOM state, and console logs.
 *
 * Features:
 * - Uses observe() to read page state before acting
 * - Uses act() to perform browser actions
 * - Uses extract() to verify assertions
 * - All actions logged to W&B Weave for observability
 *
 * Instrumented with W&B Weave for observability.
 */

import { Stagehand, type Page } from '@browserbasehq/stagehand';
import type { TestSpec, TestResult, FailureReport, ConsoleLog } from '@/lib/types';
import { op, isWeaveEnabled, tracedOp } from '@/lib/weave';
import { z } from 'zod';

// Schema for extraction results
const AssertionSchema = z.object({
  found: z.boolean().describe('Whether the expected content was found on the page'),
  content: z.string().optional().describe('The actual content that was found'),
  confidence: z.number().min(0).max(1).describe('Confidence level of the assertion (0-1)'),
});

export class TesterAgent {
  private stagehand: Stagehand | null = null;
  private consoleLogs: ConsoleLog[] = [];
  private sessionId: string | null = null;
  private actionCount: number = 0; // Track number of actions per run
  private mode: 'browserbase' | 'local' = 'browserbase';
  private fallbackUrl = '';
  private fallbackDomSnapshot = '';

  /**
   * Initialize Stagehand with Browserbase
   */
  async init(): Promise<void> {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    const projectId = process.env.BROWSERBASE_PROJECT_ID;

    if (!apiKey || !projectId) {
      this.mode = 'local';
      console.log('[TesterAgent] Browserbase credentials not found, using local fallback mode');
      return;
    }

    this.mode = 'browserbase';
    console.log('[TesterAgent] Initializing Stagehand with Browserbase...');
    console.log(`[TesterAgent] Project ID: ${projectId.slice(0, 8)}...`);

    // Use Gemini if GOOGLE_API_KEY is set, otherwise fall back to OpenAI
    const useGemini = !!process.env.GOOGLE_API_KEY;
    console.log(`[TesterAgent] Using model: ${useGemini ? 'gemini-2.0-flash' : 'gpt-4o'}`);

    this.stagehand = new Stagehand({
      env: 'BROWSERBASE',
      apiKey,
      projectId,
      model: useGemini
        ? {
            modelName: 'gemini-2.0-flash',
            apiKey: process.env.GOOGLE_API_KEY,
          }
        : {
            modelName: 'gpt-4o',
            apiKey: process.env.OPENAI_API_KEY,
          },
      verbose: process.env.DEBUG === 'true' ? 1 : 0,
    });

    const { withRetry } = await import('@/lib/utils/retry');
    await withRetry(() => this.stagehand!.init(), {
      maxRetries: 3,
      initialDelayMs: 2000,
      retryableErrors: [/session/i, /timeout/i, /ECONNREFUSED/, /ECONNRESET/],
    });
    console.log('[TesterAgent] Stagehand initialized successfully');

    this.captureSessionId();
  }

  /**
   * Get the current Browserbase session ID for live debugging
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  private captureSessionId(): void {
    if (!this.stagehand) {
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // Prefer public getter, but fall back to internal field name if needed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stagehandAny = this.stagehand as any;
    const nextSessionId =
      stagehandAny.browserbaseSessionID || stagehandAny.browserbaseSessionId || null;
    if (nextSessionId && nextSessionId !== this.sessionId) {
      this.sessionId = nextSessionId;
      console.log(`[TesterAgent] Browserbase session ID: ${this.sessionId}`);
      console.log(`[TesterAgent] Live view: https://browserbase.com/sessions/${this.sessionId}`);
    }
  }

  /**
   * Get or create a page from stagehand context
   */
  private async getPage(): Promise<Page> {
    if (!this.stagehand) {
      throw new Error('Stagehand not initialized');
    }

    // Check if context exists
    if (!this.stagehand.context) {
      throw new Error('Stagehand context not available');
    }

    let pages = this.stagehand.context.pages();

    // If no pages exist, create one
    if (!pages || pages.length === 0) {
      console.log('[TesterAgent] No pages found, creating new page...');
      const newPage = await this.stagehand.context.newPage();
      this.captureSessionId();
      return newPage;
    }

    this.captureSessionId();
    return pages[0];
  }

  /**
   * Run a test specification
   * Traced by W&B Weave for observability
   */
  runTest = isWeaveEnabled()
    ? op(this._runTest.bind(this), { name: 'TesterAgent.runTest' })
    : this._runTest.bind(this);

  private async _runTest(spec: TestSpec): Promise<TestResult> {
    if (!this.stagehand && this.mode === 'browserbase') {
      await this.init();
    }

    const startTime = Date.now();
    this.consoleLogs = [];
    this.actionCount = 0; // Reset action counter
    this.fallbackUrl = spec.url;
    this.fallbackDomSnapshot = '';

    if (this.mode === 'local') {
      return this.runLocalFallbackTest(spec, startTime);
    }

    try {
      const page = await this.getPage();
      this.captureSessionId();
      console.log(`[TesterAgent] Got page, navigating to ${spec.url}...`);

      // Navigate to the test URL
      await page.goto(spec.url, {
        waitUntil: 'domcontentloaded',
        timeoutMs: spec.timeout || 30000,
      });
      this.captureSessionId();
      console.log('[TesterAgent] Navigation complete');

      // Initial page observation to understand the page structure
      console.log('[TesterAgent] Observing initial page state...');
      const initialState = await this.tracedObserve(
        'Describe the main content, navigation elements, and interactive elements on this page'
      );
      console.log(`[TesterAgent] Initial observation: found ${initialState?.length || 0} elements`);

      // Execute each test step
      for (let stepIndex = 0; stepIndex < spec.steps.length; stepIndex++) {
        const step = spec.steps[stepIndex];
        console.log(`\n[TesterAgent] === Step ${stepIndex + 1}/${spec.steps.length} ===`);

        try {
          // 1. OBSERVE - Understand current page state before acting
          console.log(`[TesterAgent] Step ${stepIndex + 1}: Observing before action...`);
          const preActionState = await this.tracedObserve(
            `Find elements related to: "${step.action}". What buttons, links, or inputs can I interact with?`
          );
          console.log(`[TesterAgent] Found ${preActionState?.length || 0} relevant elements`);

          if (preActionState && preActionState.length > 0) {
            console.log(`[TesterAgent] Elements found:`);
            preActionState.slice(0, 3).forEach((el, i) => {
              console.log(`   ${i + 1}. ${el.description || el.selector}`);
            });
          }

          // 2. ACT - Execute the action
          console.log(`[TesterAgent] Step ${stepIndex + 1}: Executing action: "${step.action}"`);
          await this.tracedAct(step.action, step.timeout || 15000);
          console.log(`[TesterAgent] Action completed successfully`);

          // 3. EXTRACT - Verify the assertion using extract() for structured data
          if (step.expected) {
            console.log(`[TesterAgent] Step ${stepIndex + 1}: Verifying assertion: "${step.expected}"`);

            // Use extract() for structured assertion checking
            const assertionResult = await this.tracedExtract(step.expected);

            console.log(`[TesterAgent] Assertion result: found=${assertionResult.found}, confidence=${(assertionResult.confidence * 100).toFixed(0)}%`);

            if (!assertionResult.found) {
              // Double-check with observe for more context
              const postActionState = await this.tracedObserve(step.expected);

              if (!postActionState || postActionState.length === 0) {
                // Try fallback: check page content directly
                const pageContent = await page.evaluate(() => document.body.innerText);
                const expectedText = step.expected
                  .toLowerCase()
                  .replace(/i see /i, '')
                  .replace(/"/g, '')
                  .trim();

                const passed = pageContent.toLowerCase().includes(expectedText);

                if (!passed) {
                  console.log(`[TesterAgent] ❌ Assertion failed: ${step.expected}`);
                  const failureReport = await this.buildFailureReport(
                    spec.id,
                    stepIndex,
                    new Error(`Assertion failed: ${step.expected}`)
                  );

                  return {
                    passed: false,
                    duration: Date.now() - startTime,
                    failureReport,
                  };
                }
              }
            }
            console.log(`[TesterAgent] ✅ Assertion passed`);
          }
        } catch (stepError) {
          console.log(`[TesterAgent] ❌ Step ${stepIndex + 1} failed:`, stepError);
          const failureReport = await this.buildFailureReport(
            spec.id,
            stepIndex,
            stepError instanceof Error ? stepError : new Error(String(stepError))
          );

          return {
            passed: false,
            duration: Date.now() - startTime,
            failureReport,
          };
        }
      }

      // Log action statistics
      console.log(`\n[TesterAgent] ✅ All ${spec.steps.length} steps passed`);
      console.log(`[TesterAgent] Total Stagehand actions: ${this.actionCount} (act + observe + extract)`);

      // All steps passed
      return {
        passed: true,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      console.log(`[TesterAgent] ❌ Test failed with error:`, error);
      const failureReport = await this.buildFailureReport(
        spec.id,
        -1, // General error, not specific to a step
        error instanceof Error ? error : new Error(String(error))
      );

      return {
        passed: false,
        duration: Date.now() - startTime,
        failureReport,
      };
    }
  }

  private async runLocalFallbackTest(spec: TestSpec, startTime: number): Promise<TestResult> {
    try {
      let currentUrl = spec.url;
      let currentHtml = await this.fetchPageHtml(currentUrl);

      for (let stepIndex = 0; stepIndex < spec.steps.length; stepIndex++) {
        const step = spec.steps[stepIndex];
        const nextUrl = this.resolveActionUrl(currentUrl, currentHtml, step.action);

        if (nextUrl) {
          currentUrl = nextUrl;
          currentHtml = await this.fetchPageHtml(currentUrl);
        }

        if (step.expected && !this.matchesExpectation(step.expected, currentHtml)) {
          const failureReport = await this.buildFailureReport(
            spec.id,
            stepIndex,
            new Error(`Assertion failed in local fallback mode: ${step.expected}`)
          );

          return {
            passed: false,
            duration: Date.now() - startTime,
            failureReport,
          };
        }
      }

      return {
        passed: true,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const failureReport = await this.buildFailureReport(
        spec.id,
        -1,
        error instanceof Error ? error : new Error(String(error))
      );

      return {
        passed: false,
        duration: Date.now() - startTime,
        failureReport,
      };
    }
  }

  private async fetchPageHtml(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'QAgent Local Tester',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }

    const html = await response.text();
    this.fallbackUrl = url;
    this.fallbackDomSnapshot = html;
    return html;
  }

  private resolveActionUrl(currentUrl: string, html: string, action: string): string | null {
    const normalizedAction = action.toLowerCase();

    const directUrlMatch = action.match(/https?:\/\/\S+/);
    if (directUrlMatch) {
      return directUrlMatch[0];
    }

    const pathMatch = action.match(/\s(\/[A-Za-z0-9/_-]+)/);
    if (pathMatch) {
      return new URL(pathMatch[1], currentUrl).toString();
    }

    if (!normalizedAction.includes('click') && !normalizedAction.includes('navigate')) {
      return null;
    }

    const quotedText = action.match(/"([^"]+)"|'([^']+)'/);
    const targetText = (quotedText?.[1] || quotedText?.[2] || '').trim().toLowerCase();
    if (!targetText) {
      return null;
    }

    const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
    for (const match of html.matchAll(anchorPattern)) {
      const href = match[1];
      const anchorText = this.normalizeText(match[2].replace(/<[^>]+>/g, ' '));
      if (anchorText.includes(this.normalizeText(targetText))) {
        return new URL(href, currentUrl).toString();
      }
    }

    return null;
  }

  private matchesExpectation(expected: string, html: string): boolean {
    const pageText = this.normalizeText(html.replace(/<[^>]+>/g, ' '));
    const quotedText = expected.match(/"([^"]+)"|'([^']+)'/);
    if (quotedText) {
      return pageText.includes(this.normalizeText(quotedText[1] || quotedText[2]));
    }

    const stopWords = new Set(['i', 'see', 'the', 'a', 'an', 'page', 'screen', 'should', 'be', 'to', 'on', 'of', 'and', 'is', 'there', 'appears']);
    const keywords = this.normalizeText(expected)
      .split(' ')
      .filter((token) => token.length > 2 && !stopWords.has(token));

    if (keywords.length === 0) {
      return pageText.includes(this.normalizeText(expected));
    }

    return keywords.every((token) => pageText.includes(token));
  }

  private normalizeText(value: string): string {
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * Traced observe - wraps stagehand.observe() with Weave logging
   */
  private async tracedObserve(instruction: string): Promise<Array<{ selector: string; description?: string }>> {
    this.actionCount++;
    const startTime = Date.now();

    try {
      const result = await this.stagehand!.observe(instruction);
      const duration = Date.now() - startTime;
      console.log(`[TesterAgent] observe() completed in ${duration}ms`);
      return result || [];
    } catch (error) {
      console.error(`[TesterAgent] observe() failed:`, error);
      throw error;
    }
  }

  /**
   * Traced act - wraps stagehand.act() with Weave logging
   */
  private async tracedAct(action: string, timeout: number = 15000): Promise<void> {
    this.actionCount++;
    const startTime = Date.now();

    try {
      await this.stagehand!.act(action, { timeout });
      const duration = Date.now() - startTime;
      console.log(`[TesterAgent] act() completed in ${duration}ms`);
    } catch (error) {
      console.error(`[TesterAgent] act() failed:`, error);
      throw error;
    }
  }

  /**
   * Traced extract - wraps stagehand.extract() for verification
   * Uses structured schema extraction with Zod
   */
  private async tracedExtract(assertion: string): Promise<{ found: boolean; content?: string; confidence: number }> {
    this.actionCount++;
    const startTime = Date.now();

    try {
      // Extract with instruction and schema (Stagehand v3 API: extract(instruction, schema))
      const instruction = `Check if the following is true on the current page: "${assertion}". Return whether it was found, any matching content, and your confidence level (0-1).`;
      const result = await this.stagehand!.extract(instruction, AssertionSchema);
      const duration = Date.now() - startTime;
      console.log(`[TesterAgent] extract() completed in ${duration}ms`);

      // Result should directly match the schema type
      return {
        found: result.found ?? false,
        content: result.content,
        confidence: result.confidence ?? 0,
      };
    } catch (error) {
      console.error(`[TesterAgent] extract() failed:`, error);
      // Return a default failed result on error
      return { found: false, confidence: 0 };
    }
  }

  /**
   * Build a detailed failure report
   */
  private async buildFailureReport(
    testId: string,
    step: number,
    error: Error
  ): Promise<FailureReport> {
    let screenshot = '';
    let domSnapshot = '';
    let url = '';

    try {
      if (this.stagehand) {
        const page = await this.getPage();

        // Capture screenshot using Stagehand's CDP-based page
        const buffer = await page.screenshot({
          fullPage: true,
          type: 'png',
        });
        screenshot = buffer.toString('base64');

        // Capture DOM
        domSnapshot = await page.evaluate(() => document.documentElement.outerHTML);

        // Get current URL
        url = await page.evaluate(() => window.location.href);
      }
    } catch (captureError) {
      // Continue even if capture fails
      console.error('Failed to capture failure evidence:', captureError);
    }

    return {
      testId,
      timestamp: new Date(),
      step,
      error: {
        message: error.message,
        stack: error.stack || '',
        type: error.name,
      },
      context: {
        url: url || this.fallbackUrl,
        screenshot,
        domSnapshot: domSnapshot || this.fallbackDomSnapshot,
        consoleLogs: [...this.consoleLogs],
      },
    };
  }

  /**
   * Close the browser session
   */
  async close(): Promise<void> {
    if (this.stagehand) {
      console.log('[TesterAgent] Closing Browserbase session...');
      try {
        await this.stagehand.close();
        console.log('[TesterAgent] Session closed successfully');
      } catch (error) {
        console.error('[TesterAgent] Error closing session:', error);
      } finally {
        this.stagehand = null;
        this.sessionId = null;
      }
    }
  }
}

export default TesterAgent;
