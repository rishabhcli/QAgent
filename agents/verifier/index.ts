/**
 * Verifier Agent
 *
 * Applies patches to GitHub repositories and verifies fixes work.
 * Re-runs the failing test to confirm the bug is fixed.
 *
 * NOTE: Does NOT deploy to Vercel. Fixes are applied directly to the codebase.
 *
 * Instrumented with W&B Weave for observability.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  Patch,
  TestSpec,
  VerificationResult,
  FailureReport,
  VerifierAgent as IVerifierAgent,
} from '@/lib/types';
import { TesterAgent } from '@/agents/tester';
import { getKnowledgeBase, isRedisAvailable } from '@/lib/redis';
import { op, isWeaveEnabled } from '@/lib/weave';

export interface VerifierOptions {
  useRedis?: boolean;
  targetUrl?: string;
  autoCommit?: boolean;
}

export class VerifierAgent implements IVerifierAgent {
  private projectRoot: string;
  private testerAgent: TesterAgent | null = null;
  private ownsTesterAgent: boolean = false;
  private useRedis: boolean;
  private targetUrl: string;
  private autoCommit: boolean;
  private currentFailureReport?: FailureReport;

  private static readonly COMMIT_MESSAGE_MAX_LENGTH = 200;

  constructor(projectRoot: string = process.cwd(), options: VerifierOptions = {}) {
    this.projectRoot = projectRoot;
    this.useRedis = options.useRedis ?? true;
    this.targetUrl = options.targetUrl || process.env.TARGET_URL || 'http://localhost:3000';
    this.autoCommit = options.autoCommit ?? true;
  }

  /**
   * Get the configured target URL
   */
  getTargetUrl(): string {
    return this.targetUrl;
  }

  /**
   * Set the target URL for testing
   */
  setTargetUrl(url: string): void {
    this.targetUrl = url;
  }

  /**
   * Set an external tester agent to reuse (avoids concurrent session limits)
   */
  setTesterAgent(tester: TesterAgent): void {
    this.testerAgent = tester;
    this.ownsTesterAgent = false;
  }

  /**
   * Set the current failure report for learning
   */
  setFailureReport(failure: FailureReport): void {
    this.currentFailureReport = failure;
  }

  /**
   * Verify a patch by applying it, deploying, and re-running tests
   * Traced by W&B Weave for observability
   */
  verify = isWeaveEnabled()
    ? op(this._verify.bind(this), { name: 'VerifierAgent.verify' })
    : this._verify.bind(this);

  private async _verify(patch: Patch, testSpec: TestSpec): Promise<VerificationResult> {
    try {
      // 1. Create a backup of the original file
      const backupPath = await this.backupFile(patch.file);

      try {
        // 2. Apply the patch
        const applied = await this.applyPatch(patch);
        if (!applied) {
          return {
            success: false,
            error: 'Failed to apply patch',
          };
        }

        // 3. Run local validation (syntax check)
        const syntaxValid = await this.validateSyntax(patch.file);
        if (!syntaxValid) {
          await this.restoreFile(patch.file, backupPath);
          return {
            success: false,
            error: 'Patch introduces syntax errors',
          };
        }

        // 4. Commit the fix to git (if autoCommit is enabled)
        if (this.autoCommit) {
          await this.commitFix(patch);
        }

        // 5. Use configured target URL for testing
        const targetUrl = this.targetUrl;

        // 6. Re-run the failing test
        // Use shared tester if available, otherwise create our own
        const needsOwnTester = !this.testerAgent;
        if (needsOwnTester) {
          this.testerAgent = new TesterAgent();
          this.ownsTesterAgent = true;
          await this.testerAgent.init();
        }

        const testResult = await this.testerAgent!.runTest({
          ...testSpec,
          url: testSpec.url.replace(
            /https?:\/\/[^/]+/,
            targetUrl
          ),
        });

        // Only close if we created our own tester
        if (this.ownsTesterAgent && this.testerAgent) {
          await this.testerAgent.close();
          this.testerAgent = null;
        }

        // 7. Record fix and return result
        this.cleanupBackup(backupPath);

        if (testResult.passed) {
          // Store successful fix in knowledge base for learning
          await this.recordFixInKnowledgeBase(patch, true);

          return {
            success: true,
            testResult,
          };
        } else {
          // Store the fix attempt - don't restore, keep the patch applied
          await this.recordFixInKnowledgeBase(patch, false);

          return {
            success: false,
            testResult,
            error: 'Test still fails after applying patch',
          };
        }
      } catch (error) {
        // Restore on any error
        await this.restoreFile(patch.file, backupPath);
        throw error;
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Verification failed',
      };
    }
  }

  /**
   * Commit the fix to git
   */
  private async commitFix(patch: Patch): Promise<void> {
    try {
      const safeFilePath = this.getValidatedFilePath(patch.file);
      const commitMessage = `fix: ${this.sanitizeCommitDescription(patch.description)}\n\nApplied by QAgent`;

      execFileSync('git', ['add', '--', safeFilePath], {
        cwd: this.projectRoot,
        stdio: 'pipe',
      });
      execFileSync('git', ['commit', '-m', commitMessage], {
        cwd: this.projectRoot,
        stdio: 'pipe',
      });
      console.log(`[VerifierAgent] Committed fix: ${patch.description}`);
    } catch (error) {
      // Git commit may fail if nothing to commit or other issues
      console.log('[VerifierAgent] Git commit skipped or failed:', error);
    }
  }

  /**
   * Apply a patch to the filesystem
   */
  private async applyPatch(patch: Patch): Promise<boolean> {
    try {
      const fullPath = this.getValidatedFilePath(patch.file);
      const sourceCode = fs.readFileSync(fullPath, 'utf-8');

      // Parse the diff to get the change details
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
        console.log('Patch parse failed: no start line found in diff');
        return false;
      }

      // Apply the patch
      const lines = sourceCode.split('\n');
      const beforeLines = lines.slice(0, startLine - 1);
      const afterLines = lines.slice(startLine - 1 + removeCount);

      console.log(`Applying patch to ${patch.file}: replacing lines ${startLine}-${startLine + removeCount - 1} with ${addedLines.length} new lines`);

      const newContent = [...beforeLines, ...addedLines, ...afterLines].join('\n');
      fs.writeFileSync(fullPath, newContent, 'utf-8');

      return true;
    } catch (error) {
      console.error('Failed to apply patch:', error);
      return false;
    }
  }

  /**
   * Create a backup of a file
   */
  private async backupFile(filePath: string): Promise<string> {
    const fullPath = this.getValidatedFilePath(filePath);
    const backupPath = `${fullPath}.backup.${Date.now()}`;
    fs.copyFileSync(fullPath, backupPath);
    return backupPath;
  }

  /**
   * Restore a file from backup
   */
  private async restoreFile(filePath: string, backupPath: string): Promise<void> {
    const fullPath = this.getValidatedFilePath(filePath);
    fs.copyFileSync(backupPath, fullPath);
    this.cleanupBackup(backupPath);
  }

  /**
   * Clean up a backup file
   */
  private cleanupBackup(backupPath: string): void {
    try {
      fs.unlinkSync(backupPath);
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Validate syntax by attempting to compile
   */
  private async validateSyntax(filePath: string): Promise<boolean> {
    try {
      const fullPath = this.getValidatedFilePath(filePath);
      const content = fs.readFileSync(fullPath, 'utf-8');

      // Basic bracket balance check
      const openBraces = (content.match(/\{/g) || []).length;
      const closeBraces = (content.match(/\}/g) || []).length;
      const openParens = (content.match(/\(/g) || []).length;
      const closeParens = (content.match(/\)/g) || []).length;
      const openBrackets = (content.match(/\[/g) || []).length;
      const closeBrackets = (content.match(/\]/g) || []).length;

      if (openBraces !== closeBraces) {
        console.log(`Syntax error in ${filePath}: unbalanced braces (${openBraces} open, ${closeBraces} close)`);
        return false;
      }
      if (openParens !== closeParens) {
        console.log(`Syntax error in ${filePath}: unbalanced parentheses (${openParens} open, ${closeParens} close)`);
        return false;
      }
      if (openBrackets !== closeBrackets) {
        console.log(`Syntax error in ${filePath}: unbalanced brackets (${openBrackets} open, ${closeBrackets} close)`);
        return false;
      }

      // Try to run TypeScript check using project config
      try {
        // Use project's tsconfig to ensure JSX and other settings are applied
        execFileSync('npx', ['tsc', '--noEmit', '--project', 'tsconfig.json'], {
          cwd: this.projectRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        // Log TypeScript output for debugging but check if it's a syntax error
        if (error instanceof Error && 'stdout' in error) {
          const stdout = (error as { stdout?: Buffer }).stdout;
          if (stdout) {
            const output = stdout.toString();
            // Filter out npm warnings and unrelated files
            const filteredOutput = output
              .split('\n')
              .filter((line) =>
                !line.includes('npm warn') &&
                !line.includes('npm WARN') &&
                line.includes(filePath))
              .join('\n')
              .trim();

            // Only fail on actual syntax errors (TS1xxxx and TS17xxx are parse/JSX errors)
            if (filteredOutput.includes('error TS1') || filteredOutput.includes('error TS17')) {
              console.log(`Syntax error in ${filePath}:`, filteredOutput.slice(0, 300));
              return false;
            }
            // Type errors are OK - the patch might be syntactically correct but have type issues
            if (filteredOutput.length > 0) {
              console.log(`TypeScript type errors in ${filePath} (allowing):`, filteredOutput.slice(0, 200));
            }
          }
        }
      }

      return true;
    } catch (error) {
      console.error(`Failed to validate syntax for ${filePath}:`, error);
      return false;
    }
  }

  /**
   * Record a fix attempt in the knowledge base for learning
   */
  private async recordFixInKnowledgeBase(patch: Patch, success: boolean): Promise<void> {
    if (!this.useRedis || !this.currentFailureReport) {
      return;
    }

    try {
      const available = await isRedisAvailable();
      if (!available) {
        console.log('Redis not available, skipping knowledge base update');
        return;
      }

      const kb = getKnowledgeBase();
      await kb.init();

      // Store the failure with its fix
      const failureId = await kb.storeFailure(this.currentFailureReport, patch, success);

      if (success) {
        console.log(`Stored successful fix in knowledge base: ${failureId}`);
      } else {
        console.log(`Stored failed fix attempt in knowledge base: ${failureId}`);
      }
    } catch (error) {
      console.error('Error recording fix in knowledge base:', error);
    }
  }

  /**
   * Resolve and validate that patch file paths stay within the repository.
   */
  private getValidatedFilePath(filePath: string): string {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid patch file path');
    }

    const normalizedPath = path.normalize(filePath);
    if (path.isAbsolute(normalizedPath)) {
      throw new Error('Absolute file paths are not allowed in patches');
    }

    const resolvedPath = path.resolve(this.projectRoot, normalizedPath);
    const rootPath = path.resolve(this.projectRoot);

    if (resolvedPath !== rootPath && !resolvedPath.startsWith(`${rootPath}${path.sep}`)) {
      throw new Error('Patch file path resolves outside project root');
    }

    return resolvedPath;
  }

  /**
   * Keep commit subjects safe, readable, and bounded.
   */
  private sanitizeCommitDescription(description: string): string {
    const fallback = 'Bug fix';
    const normalized = description.trim().replace(/[\r\n]+/g, ' ');
    if (!normalized) {
      return fallback;
    }
    return normalized.slice(0, VerifierAgent.COMMIT_MESSAGE_MAX_LENGTH);
  }
}

export default VerifierAgent;
