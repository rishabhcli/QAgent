/**
 * Code Analyzer Agent
 *
 * Analyzes code for issues:
 * - TypeScript/JavaScript errors
 * - ESLint violations
 * - Build failures
 * - Common bug patterns
 *
 * This is the CODE-FOCUSED agent - no browser needed.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { DiagnosisReport, FailureType } from '@/lib/types';
import { v4 as uuidv4 } from 'uuid';

export interface CodeIssue {
  id: string;
  type: 'typescript' | 'eslint' | 'build' | 'runtime';
  severity: 'error' | 'warning';
  file: string;
  line: number;
  column: number;
  message: string;
  rule?: string;
  codeSnippet?: string;
}

export interface AnalysisResult {
  success: boolean;
  issues: CodeIssue[];
  summary: {
    errors: number;
    warnings: number;
    filesAnalyzed: number;
  };
}

export class CodeAnalyzerAgent {
  private projectRoot: string;
  private allowBuildScripts: boolean;

  constructor(projectRoot: string, allowBuildScripts: boolean = true) {
    this.projectRoot = projectRoot;
    this.allowBuildScripts = allowBuildScripts;
  }

  /**
   * Run full code analysis
   */
  async analyze(): Promise<AnalysisResult> {
    const issues: CodeIssue[] = [];

    console.log('[CodeAnalyzer] Starting code analysis...');
    console.log(`[CodeAnalyzer] Project root: ${this.projectRoot}`);

    // 1. TypeScript errors
    const tsIssues = await this.runTypeScriptCheck();
    issues.push(...tsIssues);

    // 2. ESLint errors
    const eslintIssues = await this.runESLintCheck();
    issues.push(...eslintIssues);

    // 3. Build check
    if (this.allowBuildScripts) {
      const buildIssues = await this.runBuildCheck();
      issues.push(...buildIssues);
    } else {
      console.log('[CodeAnalyzer] Build check skipped for untrusted repository');
    }

    const errors = issues.filter(i => i.severity === 'error').length;
    const warnings = issues.filter(i => i.severity === 'warning').length;

    console.log(`[CodeAnalyzer] Found ${errors} errors, ${warnings} warnings`);

    return {
      success: errors === 0,
      issues,
      summary: {
        errors,
        warnings,
        filesAnalyzed: new Set(issues.map(i => i.file)).size,
      },
    };
  }

  /**
   * Run TypeScript type checking
   */
  private async runTypeScriptCheck(): Promise<CodeIssue[]> {
    const issues: CodeIssue[] = [];

    // Check if this is a TypeScript project
    const hasTsConfig = fs.existsSync(path.join(this.projectRoot, 'tsconfig.json'));
    if (!hasTsConfig) {
      console.log('[CodeAnalyzer] No tsconfig.json found, skipping TypeScript check');
      return issues;
    }

    try {
      console.log('[CodeAnalyzer] Running TypeScript check...');

      execSync('npx tsc --noEmit --pretty false 2>&1', {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      console.log('[CodeAnalyzer] TypeScript: No errors');
    } catch (error) {
      if (error instanceof Error && 'stdout' in error) {
        const output = (error as { stdout?: string }).stdout || '';
        const lines = output.split('\n');

        for (const line of lines) {
          // Parse TypeScript error format: file(line,col): error TSxxxx: message
          const match = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/);
          if (match) {
            issues.push({
              id: uuidv4(),
              type: 'typescript',
              severity: match[4] as 'error' | 'warning',
              file: match[1],
              line: parseInt(match[2], 10),
              column: parseInt(match[3], 10),
              message: match[6],
              rule: match[5],
            });
          }
        }

        console.log(`[CodeAnalyzer] TypeScript: ${issues.length} issues`);
      }
    }

    return issues;
  }

  /**
   * Run ESLint check
   */
  private async runESLintCheck(): Promise<CodeIssue[]> {
    const issues: CodeIssue[] = [];

    try {
      console.log('[CodeAnalyzer] Running ESLint check...');

      // Check if eslint is available
      const hasEslint = fs.existsSync(path.join(this.projectRoot, 'node_modules/.bin/eslint'));
      if (!hasEslint) {
        console.log('[CodeAnalyzer] ESLint not found, skipping');
        return issues;
      }

      const output = execSync('npx eslint . --format json 2>/dev/null || true', {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      try {
        const results = JSON.parse(output);
        for (const file of results) {
          for (const msg of file.messages || []) {
            issues.push({
              id: uuidv4(),
              type: 'eslint',
              severity: msg.severity === 2 ? 'error' : 'warning',
              file: file.filePath.replace(this.projectRoot + '/', ''),
              line: msg.line || 1,
              column: msg.column || 1,
              message: msg.message,
              rule: msg.ruleId,
            });
          }
        }
      } catch {
        // JSON parse failed, likely no output
      }

      console.log(`[CodeAnalyzer] ESLint: ${issues.length} issues`);
    } catch (error) {
      console.log('[CodeAnalyzer] ESLint check failed:', error);
    }

    return issues;
  }

  /**
   * Run build check
   */
  private async runBuildCheck(): Promise<CodeIssue[]> {
    const issues: CodeIssue[] = [];

    // Check if package.json exists with a build script
    const packageJsonPath = path.join(this.projectRoot, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      console.log('[CodeAnalyzer] No package.json found, skipping build check');
      return issues;
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      if (!packageJson.scripts?.build) {
        console.log('[CodeAnalyzer] No build script found, skipping build check');
        return issues;
      }
    } catch {
      console.log('[CodeAnalyzer] Could not parse package.json, skipping build check');
      return issues;
    }

    try {
      console.log('[CodeAnalyzer] Running build check...');

      // Detect package manager
      const pm = this.detectPackageManager();
      const buildCmd = pm === 'npm' ? 'npm run build' : `${pm} build`;

      execSync(`${buildCmd} 2>&1`, {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
        env: { ...process.env, CI: 'true' },
      });

      console.log('[CodeAnalyzer] Build: Success');
    } catch (error) {
      if (error instanceof Error && 'stdout' in error) {
        const output = (error as { stdout?: string }).stdout || '';

        // Try to parse build errors
        const lines = output.split('\n');
        for (const line of lines) {
          // Look for file:line:col patterns
          const match = line.match(/([^:\s]+\.[tj]sx?):(\d+):(\d+)/);
          if (match && line.toLowerCase().includes('error')) {
            issues.push({
              id: uuidv4(),
              type: 'build',
              severity: 'error',
              file: match[1],
              line: parseInt(match[2], 10),
              column: parseInt(match[3], 10),
              message: line.trim(),
            });
          }
        }

        if (issues.length === 0) {
          // Generic build error
          issues.push({
            id: uuidv4(),
            type: 'build',
            severity: 'error',
            file: 'package.json',
            line: 1,
            column: 1,
            message: 'Build failed: ' + output.slice(0, 500),
          });
        }

        console.log(`[CodeAnalyzer] Build: ${issues.length} errors`);
      }
    }

    return issues;
  }

  /**
   * Convert a code issue to a diagnosis report for the fixer
   */
  issueToDiagnosis(issue: CodeIssue): DiagnosisReport {
    let failureType: FailureType = 'UI_BUG';

    if (issue.type === 'typescript') {
      failureType = 'BACKEND_ERROR';
    } else if (issue.type === 'build') {
      failureType = 'BACKEND_ERROR';
    }

    // Read the code snippet if we can
    let codeSnippet = '';
    try {
      const filePath = path.join(this.projectRoot, issue.file);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const start = Math.max(0, issue.line - 3);
        const end = Math.min(lines.length, issue.line + 3);
        codeSnippet = lines.slice(start, end).join('\n');
      }
    } catch {
      // Ignore
    }

    return {
      failureId: issue.id,
      failureType,
      rootCause: `${issue.type.toUpperCase()} ${issue.severity}: ${issue.message}`,
      localization: {
        file: issue.file,
        startLine: issue.line,
        endLine: issue.line,
        codeSnippet,
      },
      similarIssues: [],
      suggestedFix: `Fix the ${issue.type} ${issue.severity} at ${issue.file}:${issue.line} - ${issue.message}`,
      confidence: 0.9,
    };
  }

  /**
   * Detect the package manager
   */
  private detectPackageManager(): 'npm' | 'yarn' | 'pnpm' {
    if (fs.existsSync(path.join(this.projectRoot, 'pnpm-lock.yaml'))) {
      return 'pnpm';
    }
    if (fs.existsSync(path.join(this.projectRoot, 'yarn.lock'))) {
      return 'yarn';
    }
    return 'npm';
  }
}

export default CodeAnalyzerAgent;
