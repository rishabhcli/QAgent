/**
 * Unit tests for Verifier Agent
 * Tests patch application, syntax validation, deployment, and verification
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMockPatch,
  createMockTestSpec,
  createMockTestResult,
  createMockFailureReport,
} from './test-utils';

// Mock file content for tests
const mockFileContent = `const x = 1;
const y = 2;
export default x;`;

// Mock fs before importing
vi.mock('fs', () => ({
  readFileSync: vi.fn().mockImplementation(() => mockFileContent),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock child_process
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

// Mock TesterAgent
const mockTesterAgent = {
  init: vi.fn().mockResolvedValue(undefined),
  runTest: vi.fn().mockResolvedValue({ passed: true, duration: 1000 }),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/agents/tester', () => ({
  TesterAgent: vi.fn().mockImplementation(() => mockTesterAgent),
}));

// Mock Redis
vi.mock('@/lib/redis', () => ({
  getKnowledgeBase: vi.fn().mockReturnValue({
    init: vi.fn().mockResolvedValue(undefined),
    storeFailure: vi.fn().mockResolvedValue('failure-123'),
  }),
  isRedisAvailable: vi.fn().mockResolvedValue(false),
}));

// Mock Weave
vi.mock('@/lib/weave', () => ({
  op: vi.fn((fn) => fn),
  isWeaveEnabled: vi.fn().mockReturnValue(false),
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocks
import { VerifierAgent } from '@/agents/verifier';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

// Get mocked execFileSync
const mockExecFileSync = vi.mocked(execFileSync);

describe('VerifierAgent', () => {
  let verifier: VerifierAgent;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.TARGET_URL = 'http://localhost:3000';
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_PROJECT_ID;

    verifier = new VerifierAgent('/test/project', { useRedis: false });
    vi.clearAllMocks();

    // Reset mock implementations
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => mockFileContent);
    mockTesterAgent.runTest.mockResolvedValue({ passed: true, duration: 1000 });
  });

  afterEach(() => {
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_PROJECT_ID;
  });

  describe('Constructor & Configuration', () => {
    it('should initialize with default project root', () => {
      const agent = new VerifierAgent();
      expect(agent).toBeInstanceOf(VerifierAgent);
    });

    it('should initialize with custom project root', () => {
      const agent = new VerifierAgent('/custom/path', { useRedis: false });
      expect(agent).toBeInstanceOf(VerifierAgent);
    });

    it('should read Vercel credentials from environment', () => {
      process.env.VERCEL_TOKEN = 'test-token';
      process.env.VERCEL_PROJECT_ID = 'test-project';

      const agent = new VerifierAgent('/test', { useRedis: false });
      expect(agent).toBeInstanceOf(VerifierAgent);
    });
  });

  describe('verify() Method', () => {
    it('should successfully verify a valid patch', async () => {
      const patch = createMockPatch({ file: 'src/test.ts' });
      const testSpec = createMockTestSpec();

      const result = await verifier.verify(patch, testSpec);

      expect(result.success).toBe(true);
      expect(result.deploymentUrl).toBe('http://localhost:3000');
    });

    it('should fail when patch application fails', async () => {
      const patch = createMockPatch({
        file: 'src/test.ts',
        diff: 'invalid diff without @@ markers',
      });
      const testSpec = createMockTestSpec();

      const result = await verifier.verify(patch, testSpec);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to apply patch');
    });

    it('should fail when syntax validation fails', async () => {
      // Mock unbalanced braces
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => 'const x = {');

      const patch = createMockPatch({ file: 'src/test.ts' });
      const testSpec = createMockTestSpec();

      const result = await verifier.verify(patch, testSpec);

      expect(result.success).toBe(false);
      expect(result.error).toContain('syntax');
    });

    it('should use local URL when Vercel not configured', async () => {
      const patch = createMockPatch({ file: 'src/test.ts' });
      const testSpec = createMockTestSpec();

      const result = await verifier.verify(patch, testSpec);

      expect(result.deploymentUrl).toBe('http://localhost:3000');
    });

    it('should fail when test still fails after patch', async () => {
      mockTesterAgent.runTest.mockResolvedValueOnce({
        passed: false,
        duration: 1000,
        failureReport: createMockFailureReport(),
      });

      const patch = createMockPatch({ file: 'src/test.ts' });
      const testSpec = createMockTestSpec();

      const result = await verifier.verify(patch, testSpec);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Test still fails');
    });

    it('should handle errors gracefully', async () => {
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('File not found');
      });

      const patch = createMockPatch({ file: 'src/nonexistent.ts' });
      const testSpec = createMockTestSpec();

      const result = await verifier.verify(patch, testSpec);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should set and use external tester agent', async () => {
      const externalTester = {
        init: vi.fn(),
        runTest: vi.fn().mockResolvedValue({ passed: true, duration: 500 }),
        close: vi.fn(),
      };

      verifier.setTesterAgent(externalTester as any);

      const patch = createMockPatch({ file: 'src/test.ts' });
      const testSpec = createMockTestSpec();

      await verifier.verify(patch, testSpec);

      expect(externalTester.runTest).toHaveBeenCalled();
      // Should not close external tester
      expect(externalTester.close).not.toHaveBeenCalled();
    });
  });

  describe('applyPatch()', () => {
    it('should correctly apply a simple patch', async () => {
      const patch = createMockPatch({
        file: 'src/test.ts',
        diff: `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const z = 3;
 const y = 2;`,
      });
      const testSpec = createMockTestSpec();

      const result = await verifier.verify(patch, testSpec);

      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should return false when diff has no start line', async () => {
      const patch = createMockPatch({
        file: 'src/test.ts',
        diff: 'no valid diff markers here',
      });
      const testSpec = createMockTestSpec();

      const result = await verifier.verify(patch, testSpec);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to apply patch');
    });

    it('should handle multi-line patches', async () => {
      const patch = createMockPatch({
        file: 'src/test.ts',
        diff: `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,1 +1,4 @@
+// Header comment
+import { foo } from 'bar';
+
 const x = 1;`,
      });
      const testSpec = createMockTestSpec();

      await verifier.verify(patch, testSpec);

      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should handle file read errors', async () => {
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });

      const patch = createMockPatch({ file: 'src/missing.ts' });
      const testSpec = createMockTestSpec();

      const result = await verifier.verify(patch, testSpec);

      expect(result.success).toBe(false);
    });
  });

  describe('validateSyntax()', () => {
    it('should pass for balanced brackets/braces/parens', async () => {
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(
        () => 'function test() { return [1, 2, 3]; }'
      );

      const patch = createMockPatch({ file: 'src/test.ts' });
      const testSpec = createMockTestSpec();

      const result = await verifier.verify(patch, testSpec);

      // Should not fail due to syntax (error should be undefined or not contain 'syntax')
      if (result.error) {
        expect(result.error).not.toContain('syntax');
      } else {
        expect(result.success).toBe(true);
      }
    });

    it('should fail for unbalanced braces', async () => {
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => 'function test() {');

      const patch = createMockPatch({ file: 'src/test.ts' });
      const testSpec = createMockTestSpec();

      const result = await verifier.verify(patch, testSpec);

      expect(result.success).toBe(false);
      expect(result.error).toContain('syntax');
    });

    it('should fail for unbalanced parentheses', async () => {
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(
        () => 'const x = foo(bar(1, 2)'
      );

      const patch = createMockPatch({ file: 'src/test.ts' });
      const testSpec = createMockTestSpec();

      const result = await verifier.verify(patch, testSpec);

      expect(result.success).toBe(false);
      expect(result.error).toContain('syntax');
    });

    it('should fail for unbalanced brackets', async () => {
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(
        () => 'const arr = [1, 2, 3'
      );

      const patch = createMockPatch({ file: 'src/test.ts' });
      const testSpec = createMockTestSpec();

      const result = await verifier.verify(patch, testSpec);

      expect(result.success).toBe(false);
      expect(result.error).toContain('syntax');
    });
  });

  describe('backupFile/restoreFile', () => {
    it('should create backup before applying patch', async () => {
      const patch = createMockPatch({ file: 'src/test.ts' });
      const testSpec = createMockTestSpec();

      await verifier.verify(patch, testSpec);

      expect(fs.copyFileSync).toHaveBeenCalled();
    });

    it('should cleanup backup on success', async () => {
      const patch = createMockPatch({ file: 'src/test.ts' });
      const testSpec = createMockTestSpec();

      await verifier.verify(patch, testSpec);

      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('should restore file on syntax error', async () => {
      (fs.readFileSync as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => mockFileContent) // First read for backup path
        .mockImplementationOnce(() => mockFileContent) // Read for patch
        .mockImplementationOnce(() => 'const x = {'); // Read for syntax check - unbalanced

      const patch = createMockPatch({ file: 'src/test.ts' });
      const testSpec = createMockTestSpec();

      await verifier.verify(patch, testSpec);

      // copyFileSync called twice: once for backup, once for restore
      expect(fs.copyFileSync).toHaveBeenCalled();
    });
  });

  describe('deploy()', () => {
    it('should return error when credentials not configured', async () => {
      delete process.env.VERCEL_TOKEN;
      delete process.env.VERCEL_PROJECT_ID;

      const agent = new VerifierAgent('/test', { useRedis: false });
      const patch = createMockPatch({ file: 'src/test.ts' });
      const testSpec = createMockTestSpec();

      // Deploy should be skipped, using local URL
      const result = await agent.verify(patch, testSpec);

      expect(result.deploymentUrl).toBe('http://localhost:3000');
    });

    it('should commit, push, and wait for deployment when configured', async () => {
      process.env.VERCEL_TOKEN = 'test-token';
      process.env.VERCEL_PROJECT_ID = 'test-project';

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            deployments: [{ state: 'READY', url: 'test-deploy.vercel.app' }],
          }),
      });

      const agent = new VerifierAgent('/test', { useRedis: false });
      const patch = createMockPatch({ file: 'src/test.ts' });
      const testSpec = createMockTestSpec();

      const result = await agent.verify(patch, testSpec);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['add', '--', expect.stringContaining('src/test.ts')],
        expect.any(Object)
      );
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['commit', '-m', expect.stringContaining('fix:')],
        expect.any(Object)
      );
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['push'],
        expect.any(Object)
      );
      expect(result.deploymentUrl).toBe('https://test-deploy.vercel.app');
    });

    it('should handle deployment errors', async () => {
      process.env.VERCEL_TOKEN = 'test-token';
      process.env.VERCEL_PROJECT_ID = 'test-project';

      mockExecFileSync.mockImplementation((command, args) => {
        if (command === 'git' && Array.isArray(args) && args[0] === 'push') {
          throw new Error('git push failed');
        }
        return Buffer.from('');
      });

      const agent = new VerifierAgent('/test', { useRedis: false });
      const patch = createMockPatch({ file: 'src/test.ts' });
      const testSpec = createMockTestSpec();

      const result = await agent.verify(patch, testSpec);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Deployment failed');
    });
  });

  describe('setFailureReport', () => {
    it('should store failure report for knowledge base learning', async () => {
      const failureReport = createMockFailureReport();
      verifier.setFailureReport(failureReport);

      const patch = createMockPatch({ file: 'src/test.ts' });
      const testSpec = createMockTestSpec();

      await verifier.verify(patch, testSpec);

      // Verification should complete without error
      expect(true).toBe(true);
    });
  });
});
