/**
 * Fixer Agent
 *
 * Generates code patches to fix bugs based on diagnosis reports.
 * Uses LLM to generate minimal, targeted fixes.
 *
 * Instrumented with W&B Weave for observability.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  DiagnosisReport,
  Patch,
  PatchResult,
  FailedAttempt,
  FixerAgent as IFixerAgent,
} from '@/lib/types';
import { getKnowledgeBase, isRedisAvailable } from '@/lib/redis';
import { op, isWeaveEnabled, weaveInference } from '@/lib/weave';
import { extractJSON } from '@/lib/utils/json-repair';

interface LLMPatchResponse {
  file: string;
  startLine: number;
  endLine: number;
  newCode: string;
  description: string;
}

export class FixerAgent implements IFixerAgent {
  private projectRoot: string;
  private useRedis: boolean = true;

  constructor(projectRoot: string = process.cwd(), useRedis: boolean = true) {
    if (!process.env.GOOGLE_API_KEY && !process.env.OPENAI_API_KEY) {
      throw new Error('Either GOOGLE_API_KEY or OPENAI_API_KEY environment variable is required');
    }
    this.projectRoot = projectRoot;
    this.useRedis = useRedis;
  }

  /**
   * Call LLM via Weave Inference for tracing and cost tracking
   */
  private async callLLM(prompt: string): Promise<string> {
    const { withRetry } = await import('@/lib/utils/retry');
    return withRetry(
      () =>
        weaveInference(prompt, undefined, {
          model: process.env.GOOGLE_API_KEY ? 'gemini-2.0-flash' : 'gpt-4o',
          maxTokens: 1000,
          jsonMode: true,
        }),
      {
        maxRetries: 2,
        initialDelayMs: 1000,
        retryableErrors: [/rate limit/i, /timeout/i, /ECONNRESET/, /429/, /503/],
      }
    );
  }

  /**
   * Generate a patch to fix the diagnosed bug
   * Traced by W&B Weave for observability
   */
  generatePatch = isWeaveEnabled()
    ? op(this._generatePatch.bind(this), { name: 'FixerAgent.generatePatch' })
    : this._generatePatch.bind(this);

  private async _generatePatch(diagnosis: DiagnosisReport, failedAttempts?: FailedAttempt[]): Promise<PatchResult> {
    try {
      // 1. Read the source file
      const sourceCode = await this.readSourceFile(diagnosis.localization.file);
      if (!sourceCode) {
        return {
          success: false,
          error: `Could not read source file: ${diagnosis.localization.file}`,
        };
      }

      // 2. Get similar fixes from Redis knowledge base
      const similarFixes = await this.getSimilarFixes(diagnosis);

      // 3. Generate patch with LLM (include failed attempts for learning)
      const failedContext = failedAttempts && failedAttempts.length > 0
        ? '\n\n## PREVIOUS FAILED FIXES (DO NOT repeat these approaches)\n' +
          failedAttempts.map((a, i) =>
            `### Failed Fix ${i + 1} (Iteration ${a.iteration})\n` +
            `Description: ${a.patch.description}\n` +
            `Error: ${a.verificationError}\n` +
            `\`\`\`diff\n${a.patch.diff}\n\`\`\`\n` +
            `IMPORTANT: This fix was tried and FAILED. Take a DIFFERENT approach.`
          ).join('\n\n')
        : '';
      const llmPatch = await this.generateLLMPatch(diagnosis, sourceCode, similarFixes + failedContext);
      if (!llmPatch) {
        return {
          success: false,
          error: 'LLM failed to generate a valid patch',
        };
      }

      // 4. Validate the patch
      const validationResult = await this.validatePatch(llmPatch, sourceCode);
      if (!validationResult.valid) {
        return {
          success: false,
          error: `Patch validation failed: ${validationResult.error}`,
        };
      }

      // 5. Generate diff
      const diff = this.generateDiff(
        diagnosis.localization.file,
        sourceCode,
        llmPatch
      );

      // 6. Build patch object
      const patch: Patch = {
        id: `patch-${uuidv4()}`,
        diagnosisId: diagnosis.failureId,
        file: diagnosis.localization.file,
        diff,
        description: llmPatch.description,
        metadata: {
          linesAdded: llmPatch.newCode.split('\n').length,
          linesRemoved: llmPatch.endLine - llmPatch.startLine + 1,
          llmModel: process.env.GOOGLE_API_KEY ? 'gemini-2.0-flash' : 'gpt-4o',
          promptTokens: 0,
        },
      };

      return {
        success: true,
        patch,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error generating patch',
      };
    }
  }

  /**
   * Read source file contents
   */
  private async readSourceFile(filePath: string): Promise<string | null> {
    try {
      const fullPath = path.join(this.projectRoot, filePath);
      return fs.readFileSync(fullPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Get similar fixes from the Redis knowledge base
   */
  private async getSimilarFixes(diagnosis: DiagnosisReport): Promise<string> {
    // Check if Redis integration is enabled
    if (!this.useRedis) {
      return '';
    }

    try {
      // Check if Redis is available
      const available = await isRedisAvailable();
      if (!available) {
        console.log('Redis not available, skipping similar fixes lookup');
        return '';
      }

      // Query the knowledge base for similar issues with fixes
      const kb = getKnowledgeBase();
      await kb.init();

      // First, try to find similar failures
      const similarFromDiagnosis = diagnosis.similarIssues
        .filter((issue) => issue.diff)
        .map((issue, i) => `### Fix ${i + 1} (Similarity: ${(issue.similarity * 100).toFixed(0)}%)\n${issue.fix}\n\`\`\`diff\n${issue.diff}\n\`\`\``)
        .join('\n\n');

      if (similarFromDiagnosis) {
        console.log('Using similar fixes from diagnosis');
        return similarFromDiagnosis;
      }

      // Fallback: get fix patterns for this failure type
      const patterns = await kb.getFixPatterns(diagnosis.failureType, 3);
      if (patterns.length > 0) {
        console.log(`Found ${patterns.length} fix patterns for ${diagnosis.failureType}`);
        return patterns
          .map((p, i) => `### Fix Pattern ${i + 1}\n${p.description}\n\`\`\`diff\n${p.diff}\n\`\`\``)
          .join('\n\n');
      }

      return '';
    } catch (error) {
      console.error('Error getting similar fixes:', error);
      return '';
    }
  }

  /**
   * Generate patch using LLM with robust JSON parsing and retry
   */
  private async generateLLMPatch(
    diagnosis: DiagnosisReport,
    sourceCode: string,
    similarFixes: string
  ): Promise<LLMPatchResponse | null> {
    const language = diagnosis.localization.file.endsWith('.tsx')
      ? 'typescript'
      : diagnosis.localization.file.endsWith('.ts')
        ? 'typescript'
        : 'javascript';

    const isJSX = diagnosis.localization.file.endsWith('.tsx') || diagnosis.localization.file.endsWith('.jsx');

    // Determine what kind of fix is needed based on diagnosis
    const isClickHandlerFix = diagnosis.rootCause.toLowerCase().includes('onclick') ||
                              diagnosis.suggestedFix.toLowerCase().includes('onclick');
    const isNullReferenceFix = diagnosis.failureType === 'DATA_ERROR' ||
                               diagnosis.rootCause.toLowerCase().includes('undefined') ||
                               diagnosis.rootCause.toLowerCase().includes('null');
    const isApiRouteFix = diagnosis.rootCause.toLowerCase().includes('api') ||
                          diagnosis.rootCause.toLowerCase().includes('endpoint');

    let specificInstructions = '';
    if (isJSX && isClickHandlerFix) {
      specificInstructions = `
## CRITICAL - Adding onClick Handler
You are adding an onClick handler to an existing button. DO NOT rewrite the entire button.
ONLY change the lines that define the button's opening tag (usually 3-4 lines).
The fix is to add ONE line: onClick={handleCheckout}
Keep startLine and endLine to ONLY the button opening tag lines, NOT the button's content or closing tag.`;
    } else if (isNullReferenceFix) {
      specificInstructions = `
## CRITICAL - Fixing Null Reference
Use optional chaining (?.) or provide default values to handle undefined properties.
Keep the fix minimal - only change the specific line accessing the undefined property.`;
    } else if (isApiRouteFix) {
      specificInstructions = `
## CRITICAL - Fixing API Route
Either create the missing endpoint or modify the code to not require it.
For simple cases, inline the logic instead of making external API calls.`;
    }

    const basePrompt = `You are a senior developer fixing a bug in a Next.js application.

## Bug Diagnosis
- Failure Type: ${diagnosis.failureType}
- Root Cause: ${diagnosis.rootCause}
- Suggested Fix: ${diagnosis.suggestedFix}
- Confidence: ${diagnosis.confidence}

## Current Code (${diagnosis.localization.file})
\`\`\`${language}
${sourceCode}
\`\`\`

## Bug Location
- File: ${diagnosis.localization.file}
- Lines: ${diagnosis.localization.startLine} - ${diagnosis.localization.endLine}
- Code Snippet:
\`\`\`
${diagnosis.localization.codeSnippet}
\`\`\`

${similarFixes ? `## Similar Past Fixes\n${similarFixes}\n` : ''}
${specificInstructions}

## Instructions
1. Make the ABSOLUTE MINIMUM change needed to fix the bug
2. ${isJSX ? 'For JSX: ONLY modify the specific lines that need changing. DO NOT include the closing tag or content unless absolutely necessary.' : 'Keep changes minimal and focused.'}
3. ${isJSX ? 'NEVER rewrite entire JSX blocks. Only change attributes on existing elements.' : ''}
4. Match the EXACT indentation of the original code
5. ${isJSX ? 'Keep the same JSX tag balance - if original has N unclosed tags, new code must also have N unclosed tags.' : ''}

## Example: Adding onClick to a button (lines 109-111)
Original (lines 109-111):
\`\`\`
              <button
                id="checkout-button"
                disabled={isCheckingOut}
\`\`\`
Fixed (startLine=109, endLine=111):
\`\`\`
              <button
                onClick={handleCheckout}
                id="checkout-button"
                disabled={isCheckingOut}
\`\`\`
Note: We ONLY changed the button's opening tag, NOT its content or closing tag.

## Example: Fixing null reference (line 64)
Original:
\`\`\`
const msg = \`Welcome \${userData.name}! Newsletter: \${userData.preferences.newsletter}\`;
\`\`\`
Fixed:
\`\`\`
const msg = \`Welcome \${userData.name}! Newsletter: \${userData.preferences?.newsletter ?? false}\`;
\`\`\`

IMPORTANT: Respond with ONLY a valid JSON object, no markdown code blocks.
{
  "file": "${diagnosis.localization.file}",
  "startLine": <first line number to replace>,
  "endLine": <last line number to replace>,
  "newCode": "<complete replacement code for those lines>",
  "description": "<brief description>"
}`;

    const maxRetries = 3;
    const retryPrompts = [
      '',
      '\n\nIMPORTANT: Return ONLY valid JSON, no markdown formatting or extra text. Start with { and end with }.',
      '\n\nCRITICAL: Your previous response was not valid JSON. Return PURE JSON ONLY with file, startLine, endLine, newCode, and description fields.',
    ];

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const prompt = basePrompt + retryPrompts[attempt];
        const response = await this.callLLM(prompt);

        // Use robust JSON extraction
        const result = extractJSON<{
          file?: string;
          startLine?: number;
          endLine?: number;
          newCode?: string;
          description?: string;
        }>(response, {
          requiredFields: ['file', 'startLine', 'endLine', 'newCode'],
          lenient: false,
        });

        if (result && result.file && result.startLine && result.endLine && result.newCode) {
          return {
            file: result.file,
            startLine: result.startLine,
            endLine: result.endLine,
            newCode: result.newCode,
            description: result.description || 'Bug fix',
          };
        }

        if (attempt < maxRetries - 1) {
          console.log(`Fixer JSON parse failed (attempt ${attempt + 1}/${maxRetries}), retrying...`);
        }
      } catch (error) {
        console.error(`LLM patch generation attempt ${attempt + 1} failed:`, error);
      }
    }

    console.warn('All JSON parse attempts failed for patch generation');
    return null;
  }

  /**
   * Validate the generated patch
   */
  private async validatePatch(
    patch: LLMPatchResponse,
    sourceCode: string
  ): Promise<{ valid: boolean; error?: string }> {
    const lines = sourceCode.split('\n');

    // Check line numbers are valid
    if (patch.startLine < 1 || patch.endLine > lines.length) {
      return {
        valid: false,
        error: `Invalid line range: ${patch.startLine}-${patch.endLine} (file has ${lines.length} lines)`,
      };
    }

    if (patch.startLine > patch.endLine) {
      return {
        valid: false,
        error: `Start line (${patch.startLine}) is after end line (${patch.endLine})`,
      };
    }

    // Check new code is not empty
    if (!patch.newCode.trim()) {
      return {
        valid: false,
        error: 'New code is empty',
      };
    }

    // Check for dangerous patterns
    const dangerousPatterns = [
      /rm\s+-rf/,
      /eval\s*\(/,
      /exec\s*\(/,
      /child_process/,
      /require\s*\(\s*['"]fs['"]\s*\)/,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(patch.newCode)) {
        return {
          valid: false,
          error: 'Patch contains potentially dangerous code',
        };
      }
    }

    // Basic syntax check - try to detect obvious issues
    const openBraces = (patch.newCode.match(/\{/g) || []).length;
    const closeBraces = (patch.newCode.match(/\}/g) || []).length;
    const openParens = (patch.newCode.match(/\(/g) || []).length;
    const closeParens = (patch.newCode.match(/\)/g) || []).length;

    if (Math.abs(openBraces - closeBraces) > 2 || Math.abs(openParens - closeParens) > 2) {
      return {
        valid: false,
        error: 'Patch has unbalanced braces or parentheses',
      };
    }

    // Note: Detailed JSX validation is handled by TypeScript compiler check in Verifier
    // Basic checks above are sufficient for pre-validation

    return { valid: true };
  }

  /**
   * Generate a unified diff format
   */
  private generateDiff(
    filePath: string,
    originalCode: string,
    patch: LLMPatchResponse
  ): string {
    const lines = originalCode.split('\n');
    const removedLines = lines.slice(patch.startLine - 1, patch.endLine);
    const addedLines = patch.newCode.split('\n');

    let diff = `--- a/${filePath}\n`;
    diff += `+++ b/${filePath}\n`;
    diff += `@@ -${patch.startLine},${removedLines.length} +${patch.startLine},${addedLines.length} @@\n`;

    for (const line of removedLines) {
      diff += `-${line}\n`;
    }

    for (const line of addedLines) {
      diff += `+${line}\n`;
    }

    return diff;
  }

  /**
   * Apply a patch to the filesystem (for Verifier to use)
   */
  async applyPatch(patch: Patch): Promise<boolean> {
    try {
      const fullPath = path.join(this.projectRoot, patch.file);
      const sourceCode = fs.readFileSync(fullPath, 'utf-8');

      // Parse the diff to get the new code
      const diffLines = patch.diff.split('\n');
      const addedLines: string[] = [];
      let startLine = 0;
      let removeCount = 0;

      for (const line of diffLines) {
        if (line.startsWith('@@')) {
          const match = line.match(/@@ -(\d+),(\d+)/);
          if (match) {
            startLine = parseInt(match[1], 10);
            removeCount = parseInt(match[2], 10);
          }
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          addedLines.push(line.slice(1));
        }
      }

      if (startLine === 0) {
        return false;
      }

      // Apply the patch
      const lines = sourceCode.split('\n');
      const beforeLines = lines.slice(0, startLine - 1);
      const afterLines = lines.slice(startLine - 1 + removeCount);

      const newContent = [...beforeLines, ...addedLines, ...afterLines].join('\n');
      fs.writeFileSync(fullPath, newContent, 'utf-8');

      return true;
    } catch (error) {
      console.error('Failed to apply patch:', error);
      return false;
    }
  }
}

export default FixerAgent;
