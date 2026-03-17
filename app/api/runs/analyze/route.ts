import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  createRun,
  updateRunStatus,
  updateRunAgent,
  addRunPatch,
} from '@/lib/dashboard/run-store';
import {
  emitRunStarted,
  emitAgentStarted,
  emitPatchGenerated,
  emitRunCompleted,
  emitRunError,
  sseEmitter,
} from '@/lib/dashboard/sse-emitter';
import { createPatchPR } from '@/lib/github/patches';
import type { Patch } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes for code analysis

/**
 * POST /api/runs/analyze - Analyze a GitHub repository and fix issues
 *
 * This is the CodeRabbit-style flow:
 * 1. Fetch code from GitHub repo
 * 2. Analyze code for issues (bugs, security, best practices)
 * 3. Generate fixes
 * 4. Create PRs with the fixes
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { repoId, repoName, maxIterations = 5 } = body;

    if (!repoName) {
      return NextResponse.json(
        { error: 'Repository name is required' },
        { status: 400 }
      );
    }

    // Get GitHub access token from session
    const session = await getSession();
    const githubToken = session?.accessToken || undefined;

    if (!githubToken) {
      return NextResponse.json(
        { error: 'GitHub authentication required' },
        { status: 401 }
      );
    }

    // Create the run
    const run = createRun({
      ownerId: session?.user?.id,
      repoId: repoId || repoName,
      repoName,
      testSpecs: [], // No test specs for code analysis
      maxIterations,
    });

    // Emit SSE event - run starting
    emitRunStarted(run.id);
    updateRunStatus(run.id, 'running');

    // Start code analysis in background
    analyzeRepository(run.id, repoName, githubToken, maxIterations);

    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    console.error('Error creating analysis run:', error);
    return NextResponse.json(
      { error: 'Failed to create analysis run' },
      { status: 500 }
    );
  }
}

/**
 * Analyze a GitHub repository for issues and create fix PRs
 */
async function analyzeRepository(
  runId: string,
  repoFullName: string,
  githubToken: string,
  maxIterations: number
) {
  try {
    console.log(`\n🔍 Starting code analysis for ${repoFullName}`);

    // Emit status
    sseEmitter.emit({
      type: 'status',
      timestamp: new Date(),
      runId,
      data: { status: 'analyzing', message: 'Fetching repository code...' },
    });

    emitAgentStarted(runId, 'tester');
    updateRunAgent(runId, 'tester');

    // 1. Fetch repository contents from GitHub
    const repoContents = await fetchRepoContents(repoFullName, githubToken);

    sseEmitter.emit({
      type: 'status',
      timestamp: new Date(),
      runId,
      data: { status: 'analyzing', message: `Found ${repoContents.length} files to analyze...` },
    });

    // 2. Analyze code for issues
    emitAgentStarted(runId, 'triage');
    updateRunAgent(runId, 'triage');

    const issues = await analyzeCode(repoContents, githubToken);

    console.log(`Found ${issues.length} issues in ${repoFullName}`);

    if (issues.length === 0) {
      console.log('No issues found, marking as complete');
      updateRunStatus(runId, 'completed');
      emitRunCompleted(runId, true);
      return;
    }

    // 3. Generate fixes for each issue
    emitAgentStarted(runId, 'fixer');
    updateRunAgent(runId, 'fixer');

    const patches: Patch[] = [];
    for (const issue of issues.slice(0, maxIterations)) {
      const patch = await generateFix(issue, repoContents);
      if (patch) {
        patches.push(patch);

        // 4. Create PR for the fix
        try {
          console.log(`\n📝 Creating PR for fix: ${patch.description}`);

          const result = await createPatchPR(
            githubToken,
            repoFullName,
            patch,
            {
              rootCause: issue.description,
              confidence: issue.confidence,
              suggestedFix: patch.description,
            }
          );

          console.log(`✓ PR created: ${result.prUrl}`);

          // Emit PR creation event
          sseEmitter.emit({
            type: 'patch',
            timestamp: new Date(),
            runId,
            data: {
              patch,
              prUrl: result.prUrl,
              prNumber: result.prNumber,
              status: 'pr_created',
            },
          });

          addRunPatch(runId, patch);
          emitPatchGenerated(runId, patch);
        } catch (error) {
          console.error('Failed to create PR:', error);
        }
      }
    }

    // 5. Complete the run
    updateRunStatus(runId, 'completed');
    emitRunCompleted(runId, true);

    console.log(`\n✅ Analysis complete. Created ${patches.length} fix PRs.`);

  } catch (error) {
    console.error(`Error analyzing repository ${repoFullName}:`, error);
    updateRunStatus(runId, 'failed');
    emitRunError(runId, error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Fetch repository contents from GitHub
 */
async function fetchRepoContents(
  repoFullName: string,
  githubToken: string
): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];

  try {
    // Get the default branch
    const repoRes = await fetch(`https://api.github.com/repos/${repoFullName}`, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!repoRes.ok) {
      throw new Error(`Failed to fetch repo: ${repoRes.status}`);
    }

    const repoData = await repoRes.json();
    const defaultBranch = repoData.default_branch || 'main';

    // Get the tree
    const treeRes = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/trees/${defaultBranch}?recursive=1`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!treeRes.ok) {
      throw new Error(`Failed to fetch tree: ${treeRes.status}`);
    }

    const treeData = await treeRes.json();

    // Filter for code files
    const codeFiles = treeData.tree.filter((item: { type: string; path: string }) =>
      item.type === 'blob' &&
      (item.path.endsWith('.ts') ||
        item.path.endsWith('.tsx') ||
        item.path.endsWith('.js') ||
        item.path.endsWith('.jsx')) &&
      !item.path.includes('node_modules') &&
      !item.path.includes('.next') &&
      !item.path.includes('dist')
    );

    // Fetch content for each file (limit to 20 files for performance)
    for (const file of codeFiles.slice(0, 20)) {
      try {
        const contentRes = await fetch(
          `https://api.github.com/repos/${repoFullName}/contents/${file.path}`,
          {
            headers: {
              Authorization: `Bearer ${githubToken}`,
              Accept: 'application/vnd.github.v3+json',
            },
          }
        );

        if (contentRes.ok) {
          const contentData = await contentRes.json();
          if (contentData.content) {
            const content = Buffer.from(contentData.content, 'base64').toString('utf-8');
            files.push({ path: file.path, content });
          }
        }
      } catch {
        // Skip files that fail to fetch
      }
    }

  } catch (error) {
    console.error('Error fetching repo contents:', error);
  }

  return files;
}

interface CodeIssue {
  file: string;
  line: number;
  type: 'bug' | 'security' | 'performance' | 'style';
  description: string;
  confidence: number;
}

/**
 * Analyze code for issues using pattern matching and heuristics
 */
async function analyzeCode(
  files: Array<{ path: string; content: string }>,
  _githubToken: string
): Promise<CodeIssue[]> {
  const issues: CodeIssue[] = [];

  for (const file of files) {
    const lines = file.content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Check for common issues

      // 1. Console.log in production code
      if (line.includes('console.log') && !file.path.includes('test')) {
        issues.push({
          file: file.path,
          line: lineNum,
          type: 'style',
          description: 'Remove console.log statement from production code',
          confidence: 0.8,
        });
      }

      // 2. Hardcoded secrets
      if (line.match(/(['"])(?:password|secret|api_key|apikey|token)\1\s*[=:]/i) &&
          !line.includes('process.env')) {
        issues.push({
          file: file.path,
          line: lineNum,
          type: 'security',
          description: 'Potential hardcoded secret detected',
          confidence: 0.7,
        });
      }

      // 3. TODO/FIXME comments
      if (line.match(/\/\/\s*(TODO|FIXME|HACK|XXX)/i)) {
        issues.push({
          file: file.path,
          line: lineNum,
          type: 'bug',
          description: 'Unresolved TODO/FIXME comment',
          confidence: 0.5,
        });
      }

      // 4. Empty catch blocks
      if (line.match(/catch\s*\([^)]*\)\s*\{\s*\}/) ||
          (line.includes('catch') && lines[i + 1]?.trim() === '}')) {
        issues.push({
          file: file.path,
          line: lineNum,
          type: 'bug',
          description: 'Empty catch block swallows errors',
          confidence: 0.9,
        });
      }

      // 5. == instead of ===
      if (line.match(/[^=!]==[^=]/) && !line.includes('===')) {
        issues.push({
          file: file.path,
          line: lineNum,
          type: 'bug',
          description: 'Use === instead of == for strict equality',
          confidence: 0.85,
        });
      }
    }
  }

  // Sort by confidence
  return issues.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Generate a fix for an issue
 */
async function generateFix(
  issue: CodeIssue,
  files: Array<{ path: string; content: string }>
): Promise<Patch | null> {
  const file = files.find(f => f.path === issue.file);
  if (!file) return null;

  const lines = file.content.split('\n');
  const originalLine = lines[issue.line - 1];

  let fixedLine = originalLine;
  let description = issue.description;

  // Generate fix based on issue type
  switch (issue.type) {
    case 'style':
      if (issue.description.includes('console.log')) {
        // Comment out console.log
        fixedLine = originalLine.replace(/console\.log/, '// console.log');
        description = 'Comment out console.log statement';
      }
      break;

    case 'bug':
      if (issue.description.includes('===')) {
        // Replace == with ===
        fixedLine = originalLine.replace(/([^=!])={2}([^=])/g, '$1===$2');
        description = 'Replace == with === for strict equality';
      } else if (issue.description.includes('catch')) {
        // Add error logging to empty catch
        fixedLine = originalLine.replace(/\{\s*\}/, '{ console.error(e); }');
        description = 'Add error logging to catch block';
      }
      break;

    case 'security':
      // Don't auto-fix security issues, just report
      return null;

    default:
      break;
  }

  if (fixedLine === originalLine) {
    return null;
  }

  // Create the diff
  const diff = `@@ -${issue.line},1 +${issue.line},1 @@
-${originalLine}
+${fixedLine}`;

  return {
    id: `patch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    file: issue.file,
    diff,
    description,
    diagnosisId: `issue-${issue.line}`,
    metadata: {
      linesAdded: 1,
      linesRemoved: 1,
      llmModel: 'pattern-matcher',
      promptTokens: 0,
    },
  };
}
