export class PolicyBlockedError extends Error {
  override readonly name = 'PolicyBlockedError';
}

export class RunCancelledError extends Error {
  override readonly name = 'RunCancelledError';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
