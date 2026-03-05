import type {
  RunEvent,
  ActivityLogEntry,
  DiagnosticsData,
  AgentType,
  ActivityAction,
  LLMCallDetails,
} from '@/lib/types';
import { v4 as uuidv4 } from 'uuid';

type SSECallback = (event: RunEvent) => void;

// Singleton SSE emitter
class SSEEmitter {
  private subscribers: Map<string, Set<SSECallback>> = new Map();
  private eventBuffer: Map<string, RunEvent[]> = new Map();
  private static MAX_BUFFER_SIZE = 100;

  subscribe(runId: string, callback: SSECallback): () => void {
    if (!this.subscribers.has(runId)) {
      this.subscribers.set(runId, new Set());
    }

    this.subscribers.get(runId)!.add(callback);

    // Return unsubscribe function
    return () => {
      const callbacks = this.subscribers.get(runId);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.subscribers.delete(runId);
        }
      }
    };
  }

  getBufferedEvents(runId: string): RunEvent[] {
    return this.eventBuffer.get(runId) || [];
  }

  clearBuffer(runId: string): void {
    this.eventBuffer.delete(runId);
  }

  emit(event: RunEvent): void {
    // Buffer the event for late joiners
    if (!this.eventBuffer.has(event.runId)) {
      this.eventBuffer.set(event.runId, []);
    }
    const buffer = this.eventBuffer.get(event.runId)!;
    buffer.push(event);
    if (buffer.length > SSEEmitter.MAX_BUFFER_SIZE) {
      buffer.shift();
    }

    // Notify current subscribers
    const callbacks = this.subscribers.get(event.runId);
    if (callbacks) {
      callbacks.forEach((callback) => callback(event));
    }
  }

  emitToAll(event: Omit<RunEvent, 'runId'> & { runId?: string }): void {
    this.subscribers.forEach((callbacks) => {
      callbacks.forEach((callback) => callback(event as RunEvent));
    });
  }

  hasSubscribers(runId: string): boolean {
    return (this.subscribers.get(runId)?.size || 0) > 0;
  }
}

// Export singleton instance
export const sseEmitter = new SSEEmitter();

// Helper to emit common events
export function emitRunStarted(runId: string): void {
  sseEmitter.emit({
    type: 'status',
    timestamp: new Date(),
    runId,
    data: { status: 'running' },
  });
}

export function emitAgentStarted(runId: string, agent: string): void {
  sseEmitter.emit({
    type: 'agent',
    timestamp: new Date(),
    runId,
    data: { agent, status: 'started' },
  });
}

export function emitAgentCompleted(runId: string, agent: string, result?: unknown): void {
  sseEmitter.emit({
    type: 'agent',
    timestamp: new Date(),
    runId,
    data: { agent, status: 'completed', result },
  });
}

export function emitTestResult(
  runId: string,
  testId: string,
  passed: boolean,
  screenshot?: string
): void {
  sseEmitter.emit({
    type: 'test',
    timestamp: new Date(),
    runId,
    data: { testId, passed, screenshot },
  });
}

export function emitPatchGenerated(runId: string, patch: unknown): void {
  sseEmitter.emit({
    type: 'patch',
    timestamp: new Date(),
    runId,
    data: { patch, status: 'generated' },
  });
}

export function emitPatchApplied(runId: string, patchId: string, prUrl?: string): void {
  sseEmitter.emit({
    type: 'patch',
    timestamp: new Date(),
    runId,
    data: { patchId, status: 'applied', prUrl },
  });
}

export function emitRunCompleted(runId: string, success: boolean): void {
  sseEmitter.emit({
    type: 'complete',
    timestamp: new Date(),
    runId,
    data: { success },
  });
}

export function emitRunError(runId: string, error: string): void {
  sseEmitter.emit({
    type: 'error',
    timestamp: new Date(),
    runId,
    data: { error },
  });
}

// ============================================================================
// Activity Log Emitters
// ============================================================================

export function emitActivity(
  runId: string,
  agent: AgentType,
  action: ActivityAction,
  message: string,
  details?: ActivityLogEntry['details']
): void {
  const entry: ActivityLogEntry = {
    id: uuidv4(),
    timestamp: new Date(),
    agent,
    action,
    message,
    details,
  };

  sseEmitter.emit({
    type: 'activity' as RunEvent['type'],
    timestamp: new Date(),
    runId,
    data: entry,
  });
}

export function emitLLMCall(
  runId: string,
  agent: AgentType,
  llmCall: LLMCallDetails
): void {
  emitActivity(runId, agent, 'llm_call', `LLM Call (${llmCall.model})`, {
    llmCall,
  });
}

export function emitTestStep(
  runId: string,
  step: number,
  action: string,
  passed?: boolean
): void {
  const status = passed === undefined ? '' : passed ? ' - Passed' : ' - Failed';
  emitActivity(runId, 'tester', 'test_step', `Step ${step}: ${action}${status}`, {
    testStep: { step, action, passed },
  });
}

export function emitNavigation(runId: string, agent: AgentType, url: string): void {
  emitActivity(runId, agent, 'navigation', `Navigating to ${url}`, { url });
}

export function emitScreenshot(runId: string, agent: AgentType, screenshotUrl: string): void {
  emitActivity(runId, agent, 'screenshot', 'Screenshot captured', {
    screenshot: screenshotUrl,
  });
}

export function emitDiagnosis(runId: string, diagnosis: string): void {
  emitActivity(runId, 'triage', 'diagnosis', diagnosis);
}

export function emitPatchActivity(runId: string, file: string, description: string): void {
  emitActivity(runId, 'fixer', 'patch', `Patching ${file}: ${description}`);
}

export function emitDeployActivity(runId: string, status: string, url?: string): void {
  emitActivity(runId, 'verifier', 'deploy', status, url ? { url } : undefined);
}

// ============================================================================
// Enhanced Event Emitters for Live Viewing
// ============================================================================

export function emitAgentThinking(runId: string, agent: AgentType, thought: string): void {
  emitActivity(runId, agent, 'llm_call', thought);
}

export function emitStepProgress(
  runId: string,
  stepIndex: number,
  totalSteps: number,
  description?: string
): void {
  const message = description
    ? `Step ${stepIndex + 1}/${totalSteps}: ${description}`
    : `Executing step ${stepIndex + 1} of ${totalSteps}`;
  emitActivity(runId, 'tester', 'test_step', message, {
    testStep: { step: stepIndex + 1, action: description || '' },
  });
}

export function emitBrowserAction(
  runId: string,
  action: 'click' | 'type' | 'navigate' | 'wait' | 'observe',
  element?: string,
  value?: string
): void {
  let message = '';
  switch (action) {
    case 'click':
      message = `Clicking ${element || 'element'}`;
      break;
    case 'type':
      message = `Typing ${value ? `"${value}"` : ''} into ${element || 'input'}`;
      break;
    case 'navigate':
      message = `Navigating to ${element || 'page'}`;
      break;
    case 'wait':
      message = `Waiting for ${element || 'condition'}`;
      break;
    case 'observe':
      message = `Observing ${element || 'page state'}`;
      break;
    default:
      message = `Performing ${action}`;
  }
  emitActivity(runId, 'tester', 'navigation', message, { url: element });
}

export function emitSessionStarted(runId: string, sessionId: string): void {
  sseEmitter.emit({
    type: 'status',
    timestamp: new Date(),
    runId,
    data: { sessionId, message: 'Browser session started' },
  });
}

// ============================================================================
// Diagnostics Emitters
// ============================================================================

export function emitDiagnostics(runId: string, diagnostics: Partial<DiagnosticsData>): void {
  sseEmitter.emit({
    type: 'diagnostics' as RunEvent['type'],
    timestamp: new Date(),
    runId,
    data: diagnostics,
  });
}

export function emitTestFailureDiagnostics(
  runId: string,
  testFailure: DiagnosticsData['testFailure']
): void {
  emitDiagnostics(runId, { testFailure });
}

export function emitTriageDiagnostics(
  runId: string,
  triage: DiagnosticsData['triage']
): void {
  emitDiagnostics(runId, { triage });
}

export function emitPatchDiagnostics(
  runId: string,
  patch: DiagnosticsData['patch']
): void {
  emitDiagnostics(runId, { patch });
}

export function emitVerificationDiagnostics(
  runId: string,
  verification: DiagnosticsData['verification']
): void {
  emitDiagnostics(runId, { verification });
}
