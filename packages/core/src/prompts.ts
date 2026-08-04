import { z } from 'zod';

export const DiagnosisOutputSchema = z.object({
  summary: z.string().min(1),
  rootCause: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const PatchOutputSchema = z.object({
  summary: z.string().min(1),
  unifiedDiff: z
    .string()
    .min(1)
    .describe(
      'A complete Git unified diff accepted by git apply. Every hunk header uses explicit decimal old and new start/count ranges, and the declared counts exactly match the hunk body.'
    ),
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
  return `Create the smallest safe unified Git diff that fixes the diagnosed defect. The patch must apply from the repository root. Return the diff only inside the unifiedDiff field, without Markdown fences or prose. Modify only files shown in Repository context. Begin each file with "diff --git a/<path> b/<path>", followed by "--- a/<path>" and "+++ b/<path>". Repository source lines have 1-based "000001|" metadata prefixes; use them to derive hunk starts, but never copy those prefixes into the diff. Prefer a zero-context replacement hunk such as:
@@ -7,1 +7,1 @@
-return oldValue;
+return newValue;
Do not copy 7: derive each start from the numbered source. Every hunk header must use explicit decimal starts and counts. Before returning, count the body: old count equals context plus deleted lines, and new count equals context plus added lines. A bare "@@", placeholders, or counts that disagree with the body are invalid. Do not modify secrets, .git, CI workflows, authentication, dependency manifests, lockfiles, migrations, or QAgent policy unless the failure requires it. Do not claim verification.\n\nDiagnosis:\n${options.diagnosis}\n\nFailure output:\n${options.failure.slice(-30_000)}\n\nRepository context:\n${options.context}\n${options.previousAttempt ? `\nPrevious attempt feedback:\n${options.previousAttempt}` : ''}`;
}

export const TRIAGE_SYSTEM_PROMPT =
  'You are QAgent triage. Return evidence-grounded structured data only.';
export const PATCH_SYSTEM_PROMPT =
  'You are QAgent repair. Return structured data only. The unifiedDiff value must be a complete Git unified diff accepted by git apply. Every hunk header must be exactly "@@ -OLD_START,OLD_COUNT +NEW_START,NEW_COUNT @@" with base-10 integers and explicit counts. OLD_COUNT equals context plus deleted lines; NEW_COUNT equals context plus added lines. Never emit a bare "@@", placeholders, Markdown fences, or prose in unifiedDiff.';
