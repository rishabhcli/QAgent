import type { PatchInspection } from '@qagent/adapters';

export interface PublicationPolicy {
  mayPublish: boolean;
  mayAutoMerge: boolean;
  reason: string | null;
}

export function evaluatePublicationPolicy(options: {
  originalCheckoutDirty: boolean;
  patch: PatchInspection;
  configuredAutoMerge: boolean;
}): PublicationPolicy {
  if (options.originalCheckoutDirty) {
    return {
      mayPublish: false,
      mayAutoMerge: false,
      reason:
        'The source checkout is dirty; the verified worktree is preserved but publication is blocked.',
    };
  }
  if (options.patch.highRisk) {
    return {
      mayPublish: true,
      mayAutoMerge: false,
      reason: 'High-risk files require human review before merge.',
    };
  }
  return {
    mayPublish: true,
    mayAutoMerge: options.configuredAutoMerge,
    reason: options.configuredAutoMerge ? null : 'Auto-merge is disabled by project configuration.',
  };
}
