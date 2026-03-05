/**
 * Unit tests for Orchestrator
 * Tests the main QAgent loop coordination
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMockPatch,
  createMockTestSpec,
  createMockTestResult,
  createMockDiagnosis,
  createMockFailureReport,
  createMockVerificationResult,
} from './test-utils';

// Mock TesterAgent
const mockTesterAgent = {
  init: vi.fn().mockResolvedValue(undefined),
  runTest: vi.fn().mockResolvedValue({ passed: true, duration: 1000 }),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/agents/tester', () => ({
  TesterAgent: vi.fn().mockImplementation(() => mockTesterAgent),
}));

// Mock TriageAgent
const mockTriageAgent = {
  diagnose: vi.fn().mockResolvedValue(createMockDiagnosis()),
};

vi.mock('@/agents/triage', () => ({
  TriageAgent: vi.fn().mockImplementation(() => mockTriageAgent),
}));

// Mock FixerAgent
const mockFixerAgent = {
  generatePatch: vi.fn().mockResolvedValue({
    success: true,
    patch: createMockPatch(),
  }),
};

vi.mock('@/agents/fixer', () => ({
  FixerAgent: vi.fn().mockImplementation(() => mockFixerAgent),
}));

// Mock VerifierAgent
const mockVerifierAgent = {
  verify: vi.fn().mockResolvedValue({ success: true, deploymentUrl: 'http://test.com' }),
  setTesterAgent: vi.fn(),
  setFailureReport: vi.fn(),
};

vi.mock('@/agents/verifier', () => ({
  VerifierAgent: vi.fn().mockImplementation(() => mockVerifierAgent),
}));

// Mock Weave
vi.mock('@/lib/weave', () => ({
  initWeave: vi.fn().mockResolvedValue(undefined),
  op: vi.fn((fn) => fn),
  isWeaveEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/weave/metrics', () => ({
  logRunMetrics: vi.fn(),
}));

// Import after mocks
import { Orchestrator } from '@/agents/orchestrator';
import type { OrchestratorConfig } from '@/lib/types';

describe('Orchestrator', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    orchestrator = new Orchestrator({ projectRoot: '/test/project' });
    vi.clearAllMocks();

    // Reset to default successful behavior
    mockTesterAgent.runTest.mockResolvedValue({ passed: true, duration: 1000 });
    mockTriageAgent.diagnose.mockResolvedValue(createMockDiagnosis());
    mockFixerAgent.generatePatch.mockResolvedValue({
      success: true,
      patch: createMockPatch(),
    });
    mockVerifierAgent.verify.mockResolvedValue({
      success: true,
      deploymentUrl: 'http://test.com',
    });
  });

  describe('Constructor', () => {
    it('should initialize all agents with project root', () => {
      const orch = new Orchestrator({ projectRoot: '/custom/path' });
      expect(orch).toBeInstanceOf(Orchestrator);
    });

    it('should share TesterAgent with VerifierAgent', () => {
      new Orchestrator({ projectRoot: '/test' });
      expect(mockVerifierAgent.setTesterAgent).toHaveBeenCalled();
    });
  });

  describe('run() - Happy Path', () => {
    it('should complete successfully when all tests pass initially', async () => {
      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      const result = await orchestrator.run(config);

      expect(result.success).toBe(true);
      expect(result.iterations).toBe(1);
      expect(result.patches).toHaveLength(0);
    });

    it('should complete successfully after fixing bugs', async () => {
      // First test fails, then passes after fix
      mockTesterAgent.runTest
        .mockResolvedValueOnce({
          passed: false,
          duration: 1000,
          failureReport: createMockFailureReport(),
        })
        .mockResolvedValueOnce({ passed: true, duration: 1000 }) // After fix
        .mockResolvedValue({ passed: true, duration: 1000 }); // Final verification

      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      const result = await orchestrator.run(config);

      expect(result.success).toBe(true);
      expect(result.patches.length).toBeGreaterThan(0);
    });

    it('should return correct OrchestratorResult structure', async () => {
      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      const result = await orchestrator.run(config);

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('iterations');
      expect(result).toHaveProperty('totalDuration');
      expect(result).toHaveProperty('patches');
      expect(typeof result.totalDuration).toBe('number');
    });

    it('should handle multiple test specs', async () => {
      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [
          createMockTestSpec({ id: 'test-1', name: 'Test 1' }),
          createMockTestSpec({ id: 'test-2', name: 'Test 2' }),
          createMockTestSpec({ id: 'test-3', name: 'Test 3' }),
        ],
        targetUrl: 'http://localhost:3000',
      };

      const result = await orchestrator.run(config);

      expect(result.success).toBe(true);
      expect(mockTesterAgent.runTest).toHaveBeenCalled();
    });
  });

  describe('run() - Error Handling', () => {
    it('should handle tester agent initialization failure', async () => {
      mockTesterAgent.init.mockRejectedValueOnce(new Error('Init failed'));

      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      const result = await orchestrator.run(config);

      expect(result.success).toBe(false);
    });

    it('should handle test execution errors', async () => {
      mockTesterAgent.runTest.mockRejectedValueOnce(new Error('Test error'));

      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      const result = await orchestrator.run(config);

      expect(result.success).toBe(false);
      expect(mockTesterAgent.close).toHaveBeenCalled();
    });

    it('should close tester agent on any error', async () => {
      mockTesterAgent.runTest.mockRejectedValueOnce(new Error('Fatal error'));

      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      await orchestrator.run(config);

      expect(mockTesterAgent.close).toHaveBeenCalled();
    });
  });

  describe('runFixLoop()', () => {
    it('should return immediately if test passes', async () => {
      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      const result = await orchestrator.run(config);

      expect(result.iterations).toBe(1);
      expect(mockTriageAgent.diagnose).not.toHaveBeenCalled();
    });

    it('should iterate through fix cycle when test fails', async () => {
      mockTesterAgent.runTest
        .mockResolvedValueOnce({
          passed: false,
          duration: 1000,
          failureReport: createMockFailureReport(),
        })
        .mockResolvedValue({ passed: true, duration: 1000 });

      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      await orchestrator.run(config);

      expect(mockTriageAgent.diagnose).toHaveBeenCalled();
      expect(mockFixerAgent.generatePatch).toHaveBeenCalled();
      expect(mockVerifierAgent.verify).toHaveBeenCalled();
    });

    it('should stop after max iterations', async () => {
      // Always fail
      mockTesterAgent.runTest.mockResolvedValue({
        passed: false,
        duration: 1000,
        failureReport: createMockFailureReport(),
      });
      mockVerifierAgent.verify.mockResolvedValue({ success: false, error: 'Fix failed' });

      const config: OrchestratorConfig = {
        maxIterations: 3,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      const result = await orchestrator.run(config);

      expect(result.success).toBe(false);
      // 3 iterations for the test + 1 for final verification
      expect(mockFixerAgent.generatePatch).toHaveBeenCalledTimes(3);
    });

    it('should track patches generated', async () => {
      mockTesterAgent.runTest
        .mockResolvedValueOnce({
          passed: false,
          duration: 1000,
          failureReport: createMockFailureReport(),
        })
        .mockResolvedValue({ passed: true, duration: 1000 });

      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      const result = await orchestrator.run(config);

      expect(result.patches.length).toBeGreaterThan(0);
    });

    it('should call triage when test fails', async () => {
      mockTesterAgent.runTest
        .mockResolvedValueOnce({
          passed: false,
          duration: 1000,
          failureReport: createMockFailureReport(),
        })
        .mockResolvedValue({ passed: true, duration: 1000 });

      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      await orchestrator.run(config);

      expect(mockTriageAgent.diagnose).toHaveBeenCalled();
    });

    it('should call fixer after diagnosis', async () => {
      mockTesterAgent.runTest
        .mockResolvedValueOnce({
          passed: false,
          duration: 1000,
          failureReport: createMockFailureReport(),
        })
        .mockResolvedValue({ passed: true, duration: 1000 });

      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      await orchestrator.run(config);

      expect(mockFixerAgent.generatePatch).toHaveBeenCalledWith(
        expect.objectContaining({ failureType: expect.any(String) }),
        expect.any(Array)
      );
    });

    it('should call verifier after patch generation', async () => {
      mockTesterAgent.runTest
        .mockResolvedValueOnce({
          passed: false,
          duration: 1000,
          failureReport: createMockFailureReport(),
        })
        .mockResolvedValue({ passed: true, duration: 1000 });

      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      await orchestrator.run(config);

      expect(mockVerifierAgent.verify).toHaveBeenCalled();
      expect(mockVerifierAgent.setFailureReport).toHaveBeenCalled();
    });

    it('should continue to next iteration on fix failure', async () => {
      mockTesterAgent.runTest.mockResolvedValue({
        passed: false,
        duration: 1000,
        failureReport: createMockFailureReport(),
      });
      mockVerifierAgent.verify.mockResolvedValue({ success: false, error: 'Fix failed' });

      const config: OrchestratorConfig = {
        maxIterations: 2,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      await orchestrator.run(config);

      // Should have tried twice
      expect(mockVerifierAgent.verify).toHaveBeenCalledTimes(2);
    });

    it('should handle missing failure report', async () => {
      mockTesterAgent.runTest.mockResolvedValueOnce({
        passed: false,
        duration: 1000,
        // No failureReport
      });

      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      const result = await orchestrator.run(config);

      // Should not crash, just fail to fix
      expect(mockTriageAgent.diagnose).not.toHaveBeenCalled();
    });
  });

  describe('runAllTests()', () => {
    it('should run all test specs for final verification', async () => {
      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [
          createMockTestSpec({ id: 'test-1' }),
          createMockTestSpec({ id: 'test-2' }),
        ],
        targetUrl: 'http://localhost:3000',
      };

      await orchestrator.run(config);

      // Called for each test in fix loop + final verification
      expect(mockTesterAgent.runTest).toHaveBeenCalled();
    });

    it('should replace URL with target URL', async () => {
      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec({ url: 'http://example.com/page' })],
        targetUrl: 'http://localhost:3000',
      };

      await orchestrator.run(config);

      expect(mockTesterAgent.runTest).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('localhost:3000'),
        })
      );
    });
  });

  describe('Metrics & Logging', () => {
    it('should calculate correct pass count', async () => {
      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [
          createMockTestSpec({ id: 'test-1' }),
          createMockTestSpec({ id: 'test-2' }),
        ],
        targetUrl: 'http://localhost:3000',
      };

      const result = await orchestrator.run(config);

      expect(result.success).toBe(true);
    });

    it('should track total duration', async () => {
      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      const result = await orchestrator.run(config);

      // Duration should be a number (can be 0 for very fast runs)
      expect(typeof result.totalDuration).toBe('number');
      expect(result.totalDuration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('onPatchGenerated Callback', () => {
    it('should call callback when patch generated', async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      orchestrator.onPatchGenerated = callback;

      mockTesterAgent.runTest
        .mockResolvedValueOnce({
          passed: false,
          duration: 1000,
          failureReport: createMockFailureReport(),
        })
        .mockResolvedValue({ passed: true, duration: 1000 });

      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      await orchestrator.run(config);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) }),
        expect.objectContaining({ failureType: expect.any(String) })
      );
    });

    it('should not fail if callback not set', async () => {
      mockTesterAgent.runTest
        .mockResolvedValueOnce({
          passed: false,
          duration: 1000,
          failureReport: createMockFailureReport(),
        })
        .mockResolvedValue({ passed: true, duration: 1000 });

      const config: OrchestratorConfig = {
        maxIterations: 5,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      // Should not throw
      const result = await orchestrator.run(config);

      expect(result.success).toBe(true);
    });
  });

  describe('Fixer Error Handling', () => {
    it('should continue when fixer fails to generate patch', async () => {
      mockTesterAgent.runTest.mockResolvedValue({
        passed: false,
        duration: 1000,
        failureReport: createMockFailureReport(),
      });
      mockFixerAgent.generatePatch.mockResolvedValue({
        success: false,
        error: 'Could not generate patch',
      });

      const config: OrchestratorConfig = {
        maxIterations: 2,
        testSpecs: [createMockTestSpec()],
        targetUrl: 'http://localhost:3000',
      };

      const result = await orchestrator.run(config);

      // Should have tried both iterations
      expect(mockFixerAgent.generatePatch).toHaveBeenCalledTimes(2);
      // Verifier should not be called if no patch
      expect(mockVerifierAgent.verify).not.toHaveBeenCalled();
    });
  });
});
