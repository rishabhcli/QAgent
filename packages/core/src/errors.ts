import type {
  CorrectiveAction,
  InterventionResolution,
  RunAction,
  RunAttentionReason,
} from '@qagent/contracts';

export class PolicyBlockedError extends Error {
  override readonly name = 'PolicyBlockedError';
}

export class RunCancelledError extends Error {
  override readonly name = 'RunCancelledError';
}

export class RuntimeShutdownError extends Error {
  override readonly name = 'RuntimeShutdownError';
}

export class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError';
}

export class RunAttentionError extends Error {
  override readonly name = 'RunAttentionError';

  constructor(
    message: string,
    readonly reason: RunAttentionReason,
    readonly requiredAction: CorrectiveAction,
    readonly resolutionOptions: InterventionResolution[],
    readonly availableActions: RunAction[] = ['resolve_intervention', 'cancel'],
    readonly evidenceArtifactIds: string[] = []
  ) {
    super(message);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
