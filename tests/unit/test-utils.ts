/**
 * Shared Test Utilities
 * Factory functions for creating test data
 */

import { vi } from 'vitest';
import type {
  Patch,
  DiagnosisReport,
  FailureReport,
  TestSpec,
  TestResult,
  VerificationResult,
  FailureType,
} from '@/lib/types';

/**
 * Create a mock Patch object
 */
export function createMockPatch(overrides: Partial<Patch> = {}): Patch {
  return {
    id: `patch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    diagnosisId: 'diag-001',
    file: 'src/test.ts',
    diff: `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 export default x;`,
    description: 'Add missing variable',
    metadata: {
      linesAdded: 1,
      linesRemoved: 0,
      llmModel: 'gpt-4',
      promptTokens: 100,
    },
    ...overrides,
  };
}

/**
 * Create a mock DiagnosisReport object
 */
export function createMockDiagnosis(overrides: Partial<DiagnosisReport> = {}): DiagnosisReport {
  return {
    failureId: 'fail-001',
    failureType: 'UI_BUG' as FailureType,
    rootCause: 'Button missing onClick handler',
    localization: {
      file: 'src/components/Button.tsx',
      startLine: 10,
      endLine: 15,
      codeSnippet: '<button>Click me</button>',
    },
    similarIssues: [],
    suggestedFix: 'Add onClick handler to button',
    confidence: 0.9,
    ...overrides,
  };
}

/**
 * Create a mock FailureReport object
 */
export function createMockFailureReport(overrides: Partial<FailureReport> = {}): FailureReport {
  return {
    testId: 'test-001',
    timestamp: new Date(),
    step: 1,
    error: {
      message: 'Element not found: #checkout-button',
      stack: 'Error: Element not found\n    at click (test.ts:10)',
      type: 'Error',
    },
    context: {
      url: 'http://localhost:3000/cart',
      screenshot: 'base64-screenshot-data',
      domSnapshot: '<html><body>...</body></html>',
      consoleLogs: [
        { type: 'error', message: 'Failed to load resource', timestamp: Date.now() },
      ],
    },
    ...overrides,
  };
}

/**
 * Create a mock TestSpec object
 */
export function createMockTestSpec(overrides: Partial<TestSpec> = {}): TestSpec {
  return {
    id: 'test-checkout-001',
    name: 'Checkout Flow',
    url: 'http://localhost:3000/cart',
    steps: [
      { action: 'Click the checkout button', expected: 'Payment form appears' },
      { action: 'Fill in payment details', expected: 'Submit button enabled' },
    ],
    timeout: 30000,
    ...overrides,
  };
}

/**
 * Create a mock TestResult object
 */
export function createMockTestResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    passed: true,
    duration: 1500,
    ...overrides,
  };
}

/**
 * Create a mock VerificationResult object
 */
export function createMockVerificationResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    success: true,
    deploymentUrl: 'https://test-deployment.vercel.app',
    testResult: createMockTestResult(),
    ...overrides,
  };
}

/**
 * Create mock fetch response
 */
export function createMockFetchResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

/**
 * Create mock Octokit instance
 */
export function createMockOctokit(overrides: Record<string, unknown> = {}) {
  return {
    repos: {
      get: vi.fn().mockResolvedValue({ data: { default_branch: 'main' } }),
      getContent: vi.fn().mockResolvedValue({
        data: {
          type: 'file',
          content: Buffer.from('const x = 1;').toString('base64'),
          sha: 'abc123',
        },
      }),
      createOrUpdateFileContents: vi.fn().mockResolvedValue({
        data: { commit: { sha: 'commit123' } },
      }),
    },
    git: {
      getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'sha123' } } }),
      createRef: vi.fn().mockResolvedValue({}),
    },
    pulls: {
      create: vi.fn().mockResolvedValue({
        data: { html_url: 'https://github.com/owner/repo/pull/1', number: 1 },
      }),
      merge: vi.fn().mockResolvedValue({
        data: { merged: true, sha: 'merge123', message: 'Pull Request successfully merged' },
      }),
    },
    ...overrides,
  };
}
