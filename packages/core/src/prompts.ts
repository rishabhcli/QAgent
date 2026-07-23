import { z } from 'zod';

export const DiagnosisOutputSchema = z.object({
  summary: z.string().min(1),
  rootCause: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const PatchOutputSchema = z.object({
  summary: z.string().min(1),
  unifiedDiff: z.string().min(1),
});

export function diagnosisPrompt(failure: string): string {
  return `Diagnose the following failing web-project checks. Ground every claim in the supplied output. Do not invent files, test results, or external state.\n\n${failure.slice(-40_000)}`;
}

export function patchPrompt(options: {
  failure: string;
  diagnosis: string;
  context: string;
  previousAttempt?: string;
}): string {
  return `Create the smallest safe unified Git diff that fixes the diagnosed defect. The patch must apply from the repository root. Do not modify secrets, .git, CI workflows, authentication, dependency manifests, lockfiles, migrations, or QAgent policy unless the failure requires it. Do not claim verification.\n\nDiagnosis:\n${options.diagnosis}\n\nFailure output:\n${options.failure.slice(-30_000)}\n\nRepository context:\n${options.context}\n${options.previousAttempt ? `\nPrevious attempt feedback:\n${options.previousAttempt}` : ''}`;
}

export const TRIAGE_SYSTEM_PROMPT =
  'You are QAgent triage. Return evidence-grounded structured data only.';
export const PATCH_SYSTEM_PROMPT =
  'You are QAgent repair. Return a minimal, syntactically valid unified diff in structured data only.';
