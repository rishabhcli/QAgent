import { Orchestrator } from '@/agents/orchestrator';
import { CrawlerAgent } from '@/agents/crawler';
import { CodeAnalyzerAgent } from '@/agents/analyzer';
import { FixerAgent } from '@/agents/fixer';
import { createPatchPR, type GitHubMergeMethod } from '@/lib/github/patches';
import { cloneAndInstall, cleanupRepo } from '@/lib/git';
import { updatePatchStatus } from '@/lib/dashboard/patch-store';
import {
  addRunPatch,
  getRunAsync,
  updateRunAgent,
  updateRunSession,
  updateRunStatus,
} from '@/lib/dashboard/run-store';
import {
  emitAgentCompleted,
  emitAgentStarted,
  emitPatchGenerated,
  emitRunCompleted,
  emitRunError,
  emitRunStarted,
  emitSessionStarted,
  sseEmitter,
} from '@/lib/dashboard/sse-emitter';
import { createStoredRun } from '@/lib/redis/runs-store';
import type {
  AdHocRunConfig,
  AgentType,
  ClonedRepo,
  DiagnosisReport,
  Patch,
} from '@/lib/types';

interface CodeIssue {
  file: string;
  line: number;
  type: 'bug' | 'security' | 'performance' | 'style';
  description: string;
  confidence: number;
}

function getPatchMergeMethod(): GitHubMergeMethod {
  const mergeMethod = process.env.PATCH_PR_MERGE_METHOD;
  if (mergeMethod === 'merge' || mergeMethod === 'rebase' || mergeMethod === 'squash') {
    return mergeMethod;
  }
  return 'squash';
}

function getPatchPRWorkflowOptions() {
  return {
    autoMerge: process.env.AUTO_MERGE_PATCH_PRS !== 'false',
    mergeMethod: getPatchMergeMethod(),
  };
}

async function ensureRunRecord(
  repoId: string,
  repoName: string,
  config: AdHocRunConfig
): Promise<void> {
  const existingRun = await getRunAsync(config.runId);
  if (existingRun) {
    return;
  }

  await createStoredRun({
    id: config.runId,
    repoId,
    repoName,
    testSpecs: config.testSpecs || [],
    maxIterations: config.maxIterations,
  });
}

export async function executeAdHocRun(params: {
  repoId: string;
  repoName: string;
  config: AdHocRunConfig;
}): Promise<boolean> {
  const { repoId, repoName, config } = params;
  await ensureRunRecord(repoId, repoName, config);

  emitRunStarted(config.runId);
  updateRunStatus(config.runId, 'running');

  try {
    switch (config.mode) {
      case 'code':
        await runCodeFirst(config.runId, repoName, config.maxIterations, config.githubToken, config.targetUrl);
        return true;
      case 'analyze':
        await runAnalyzeRepository(config.runId, repoId, repoName, config.maxIterations, config.githubToken);
        return true;
      case 'local':
      default:
        await runLocal(config.runId, config.testSpecs || [], config.maxIterations, config.targetUrl);
        return true;
    }
  } catch (error) {
    updateRunStatus(config.runId, 'failed');
    emitRunError(config.runId, error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
}

async function runCodeFirst(
  runId: string,
  repoFullName: string,
  maxIterations: number,
  githubToken?: string,
  targetUrl?: string
): Promise<void> {
  if (!githubToken) {
    throw new Error('GitHub authentication required for code-first runs');
  }

  let clonedRepo: ClonedRepo | null = null;
  const browserTestUrl = targetUrl;

  try {
    sseEmitter.emit({
      type: 'status',
      timestamp: new Date(),
      runId,
      data: { status: 'running', message: 'Cloning repository...' },
    });

    clonedRepo = await cloneAndInstall(repoFullName, githubToken);

    sseEmitter.emit({
      type: 'status',
      timestamp: new Date(),
      runId,
      data: { status: 'running', message: 'Analyzing code...' },
    });

    emitAgentStarted(runId, 'tester');
    updateRunAgent(runId, 'tester');

    const analyzer = new CodeAnalyzerAgent(clonedRepo.repoPath);
    const analysisResult = await analyzer.analyze();

    emitAgentCompleted(runId, 'tester');

    const allPatches: Patch[] = [];

    if (analysisResult.issues.length > 0) {
      sseEmitter.emit({
        type: 'status',
        timestamp: new Date(),
        runId,
        data: {
          status: 'running',
          message: `Fixing ${analysisResult.issues.length} code issues...`,
        },
      });

      emitAgentStarted(runId, 'triage');
      updateRunAgent(runId, 'triage');

      const errors = analysisResult.issues.filter((issue) => issue.severity === 'error');
      const issuesToFix = errors.slice(0, maxIterations);

      emitAgentCompleted(runId, 'triage');
      emitAgentStarted(runId, 'fixer');
      updateRunAgent(runId, 'fixer');

      const fixer = new FixerAgent(clonedRepo.repoPath);

      for (const issue of issuesToFix) {
        try {
          const diagnosis = analyzer.issueToDiagnosis(issue);
          const patchResult = await fixer.generatePatch(diagnosis);

          if (patchResult.success && patchResult.patch) {
            allPatches.push(patchResult.patch);
            addRunPatch(runId, patchResult.patch);
            emitPatchGenerated(runId, patchResult.patch);
          }
        } catch (error) {
          console.error('[AdHocRunner] Failed to fix issue:', error);
        }
      }

      emitAgentCompleted(runId, 'fixer');
    }

    if (allPatches.length > 0) {
      sseEmitter.emit({
        type: 'status',
        timestamp: new Date(),
        runId,
        data: { status: 'running', message: 'Creating pull requests...' },
      });

      emitAgentStarted(runId, 'verifier');
      updateRunAgent(runId, 'verifier');

      for (const patch of allPatches) {
        try {
          const result = await createPatchPR(githubToken, repoFullName, patch, {
            rootCause: `Code issue: ${patch.description}`,
            confidence: 0.9,
            suggestedFix: patch.description,
          }, getPatchPRWorkflowOptions());

          await updatePatchStatus(
            patch.id,
            result.merged ? 'applied' : 'pending',
            {
              prUrl: result.prUrl,
              prNumber: result.prNumber,
              merged: result.merged,
              mergeMethod: result.mergeMethod,
              mergeCommitSha: result.mergeCommitSha,
              mergeError: result.mergeError,
            }
          );

          sseEmitter.emit({
            type: 'patch',
            timestamp: new Date(),
            runId,
            data: {
              patch,
              prUrl: result.prUrl,
              prNumber: result.prNumber,
              merged: result.merged,
              mergeCommitSha: result.mergeCommitSha,
              mergeError: result.mergeError,
              status: result.merged ? 'pr_merged' : 'pr_created',
            },
          });
        } catch (error) {
          console.error('[AdHocRunner] Failed to create PR:', error);
        }
      }

      emitAgentCompleted(runId, 'verifier');
    }

    if (browserTestUrl) {
      await runOptionalBrowserTests(runId, repoFullName, githubToken, clonedRepo.repoPath, browserTestUrl);
    }

    const success = analysisResult.summary.errors === 0 || allPatches.length > 0;
    updateRunStatus(runId, success ? 'completed' : 'failed');
    emitRunCompleted(runId, success);
  } catch (error) {
    updateRunStatus(runId, 'failed');
    emitRunError(runId, error instanceof Error ? error.message : 'Unknown error');
    throw error;
  } finally {
    if (clonedRepo) {
      try {
        await cleanupRepo(clonedRepo);
      } catch (cleanupError) {
        console.error('[AdHocRunner] Failed to cleanup cloned repo:', cleanupError);
      }
    }
  }
}

async function runOptionalBrowserTests(
  runId: string,
  repoFullName: string,
  githubToken: string,
  projectRoot: string,
  browserTestUrl: string
): Promise<void> {
  sseEmitter.emit({
    type: 'status',
    timestamp: new Date(),
    runId,
    data: { status: 'running', message: 'Running browser tests...' },
  });

  try {
    const crawler = new CrawlerAgent();
    await crawler.init();

    const crawlerSessionId = crawler.getSessionId();
    if (crawlerSessionId) {
      updateRunSession(runId, crawlerSessionId);
      emitSessionStarted(runId, crawlerSessionId);
    }

    const flows = await crawler.discoverFlows(browserTestUrl, { maxPages: 3, maxDepth: 2 });
    const crawledSessionId = crawler.getSessionId();
    if (crawledSessionId) {
      updateRunSession(runId, crawledSessionId);
      emitSessionStarted(runId, crawledSessionId);
    }

    const testSpecs = crawler.flowsToTestSpecs(flows);
    await crawler.close();

    if (testSpecs.length === 0) {
      return;
    }

    const orchestrator = new Orchestrator({
      projectRoot,
      targetUrl: browserTestUrl,
      autoCommit: false,
      onSessionStarted: (sessionId) => {
        updateRunSession(runId, sessionId);
        emitSessionStarted(runId, sessionId);
      },
    });

    orchestrator.onPatchGenerated = async (patch: Patch, diagnosis: DiagnosisReport) => {
      addRunPatch(runId, patch);

      const result = await createPatchPR(githubToken, repoFullName, patch, {
        rootCause: diagnosis.rootCause,
        confidence: diagnosis.confidence,
        suggestedFix: diagnosis.suggestedFix,
      }, getPatchPRWorkflowOptions());

      await updatePatchStatus(
        patch.id,
        result.merged ? 'applied' : 'pending',
        {
          prUrl: result.prUrl,
          prNumber: result.prNumber,
          merged: result.merged,
          mergeMethod: result.mergeMethod,
          mergeCommitSha: result.mergeCommitSha,
          mergeError: result.mergeError,
        }
      );

      sseEmitter.emit({
        type: 'patch',
        timestamp: new Date(),
        runId,
        data: {
          patch,
          prUrl: result.prUrl,
          prNumber: result.prNumber,
          merged: result.merged,
          mergeCommitSha: result.mergeCommitSha,
          mergeError: result.mergeError,
          status: result.merged ? 'pr_merged' : 'pr_created',
        },
      });
    };

    await orchestrator.run({
      maxIterations: 3,
      testSpecs,
      targetUrl: browserTestUrl,
    });
  } catch (error) {
    console.error('[AdHocRunner] Optional browser tests failed:', error);
  }
}

async function runLocal(
  runId: string,
  testSpecs: Array<{
    id: string;
    name: string;
    url: string;
    steps: Array<{ action: string; expected?: string }>;
  }>,
  maxIterations: number,
  targetUrl?: string
): Promise<void> {
  const appTargetUrl = targetUrl || process.env.TARGET_URL || 'http://localhost:3002';

  try {
    const emitAgentProgress = (agent: AgentType, status: 'started' | 'completed') => {
      if (status === 'started') {
        updateRunAgent(runId, agent);
        emitAgentStarted(runId, agent);
        return;
      }

      emitAgentCompleted(runId, agent);
    };

    emitAgentProgress('tester', 'started');

    const orchestrator = new Orchestrator({
      onSessionStarted: (sessionId) => {
        updateRunSession(runId, sessionId);
        emitSessionStarted(runId, sessionId);
      },
    });

    const result = await orchestrator.run({
      maxIterations,
      testSpecs,
      targetUrl: appTargetUrl,
    });

    if (result.success) {
      updateRunStatus(runId, 'completed');
      emitRunCompleted(runId, true);
    } else {
      updateRunStatus(runId, 'failed');
      emitRunCompleted(runId, false);
    }

    for (const patch of result.patches || []) {
      addRunPatch(runId, patch);
      emitPatchGenerated(runId, patch);
    }
  } catch (error) {
    updateRunStatus(runId, 'failed');
    emitRunError(runId, error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}

async function runAnalyzeRepository(
  runId: string,
  repoId: string,
  repoFullName: string,
  maxIterations: number,
  githubToken?: string
): Promise<void> {
  if (!githubToken) {
    throw new Error('GitHub authentication required for repository analysis');
  }

  try {
    sseEmitter.emit({
      type: 'status',
      timestamp: new Date(),
      runId,
      data: { status: 'analyzing', message: 'Fetching repository code...' },
    });

    emitAgentStarted(runId, 'tester');
    updateRunAgent(runId, 'tester');

    const repoContents = await fetchRepoContents(repoFullName, githubToken);

    sseEmitter.emit({
      type: 'status',
      timestamp: new Date(),
      runId,
      data: {
        status: 'analyzing',
        message: `Found ${repoContents.length} files to analyze...`,
      },
    });

    emitAgentStarted(runId, 'triage');
    updateRunAgent(runId, 'triage');

    const issues = await analyzeCode(repoContents);

    if (issues.length === 0) {
      updateRunStatus(runId, 'completed');
      emitRunCompleted(runId, true);
      return;
    }

    emitAgentStarted(runId, 'fixer');
    updateRunAgent(runId, 'fixer');

    for (const issue of issues.slice(0, maxIterations)) {
      const patch = await generateFix(issue, repoContents);
      if (!patch) {
        continue;
      }

      try {
        const result = await createPatchPR(githubToken, repoFullName, patch, {
          rootCause: issue.description,
          confidence: issue.confidence,
          suggestedFix: patch.description,
        }, getPatchPRWorkflowOptions());

        addRunPatch(runId, patch);
        await updatePatchStatus(
          patch.id,
          result.merged ? 'applied' : 'pending',
          {
            prUrl: result.prUrl,
            prNumber: result.prNumber,
            merged: result.merged,
            mergeMethod: result.mergeMethod,
            mergeCommitSha: result.mergeCommitSha,
            mergeError: result.mergeError,
          }
        );
        emitPatchGenerated(runId, patch);

        sseEmitter.emit({
          type: 'patch',
          timestamp: new Date(),
          runId,
          data: {
            patch,
            prUrl: result.prUrl,
            prNumber: result.prNumber,
            merged: result.merged,
            mergeCommitSha: result.mergeCommitSha,
            mergeError: result.mergeError,
            status: result.merged ? 'pr_merged' : 'pr_created',
          },
        });
      } catch (error) {
        console.error('[AdHocRunner] Failed to create PR for analysis fix:', error);
      }
    }

    updateRunStatus(runId, 'completed');
    emitRunCompleted(runId, true);
  } catch (error) {
    console.error(`[AdHocRunner] Error analyzing repository ${repoId}:`, error);
    updateRunStatus(runId, 'failed');
    emitRunError(runId, error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}

async function fetchRepoContents(
  repoFullName: string,
  githubToken: string
): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];

  try {
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
    const codeFiles = treeData.tree.filter(
      (item: { type: string; path: string }) =>
        item.type === 'blob' &&
        (item.path.endsWith('.ts') ||
          item.path.endsWith('.tsx') ||
          item.path.endsWith('.js') ||
          item.path.endsWith('.jsx')) &&
        !item.path.includes('node_modules') &&
        !item.path.includes('.next') &&
        !item.path.includes('dist')
    );

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

        if (!contentRes.ok) {
          continue;
        }

        const contentData = await contentRes.json();
        if (contentData.content) {
          const content = Buffer.from(contentData.content, 'base64').toString('utf-8');
          files.push({ path: file.path, content });
        }
      } catch {
        continue;
      }
    }
  } catch (error) {
    console.error('[AdHocRunner] Error fetching repo contents:', error);
  }

  return files;
}

async function analyzeCode(
  files: Array<{ path: string; content: string }>
): Promise<CodeIssue[]> {
  const issues: CodeIssue[] = [];

  for (const file of files) {
    const lines = file.content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (line.includes('console.log') && !file.path.includes('test')) {
        issues.push({
          file: file.path,
          line: lineNum,
          type: 'style',
          description: 'Remove console.log statement from production code',
          confidence: 0.8,
        });
      }

      if (
        line.match(/(['"])(?:password|secret|api_key|apikey|token)\1\s*[=:]/i) &&
        !line.includes('process.env')
      ) {
        issues.push({
          file: file.path,
          line: lineNum,
          type: 'security',
          description: 'Potential hardcoded secret detected',
          confidence: 0.7,
        });
      }

      if (line.match(/\/\/\s*(TODO|FIXME|HACK|XXX)/i)) {
        issues.push({
          file: file.path,
          line: lineNum,
          type: 'bug',
          description: 'Unresolved TODO/FIXME comment',
          confidence: 0.5,
        });
      }

      if (line.match(/catch\s*\([^)]*\)\s*\{\s*\}/) || (line.includes('catch') && lines[i + 1]?.trim() === '}')) {
        issues.push({
          file: file.path,
          line: lineNum,
          type: 'bug',
          description: 'Empty catch block swallows errors',
          confidence: 0.9,
        });
      }

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

  return issues.sort((a, b) => b.confidence - a.confidence);
}

async function generateFix(
  issue: CodeIssue,
  files: Array<{ path: string; content: string }>
): Promise<Patch | null> {
  const file = files.find((candidate) => candidate.path === issue.file);
  if (!file) {
    return null;
  }

  const lines = file.content.split('\n');
  const originalLine = lines[issue.line - 1];
  let fixedLine = originalLine;
  let description = issue.description;

  switch (issue.type) {
    case 'style':
      if (issue.description.includes('console.log')) {
        fixedLine = originalLine.replace(/console\.log/, '// console.log');
        description = 'Comment out console.log statement';
      }
      break;
    case 'bug':
      if (issue.description.includes('===')) {
        fixedLine = originalLine.replace(/([^=!])={2}([^=])/g, '$1===$2');
        description = 'Replace == with === for strict equality';
      } else if (issue.description.includes('catch')) {
        fixedLine = originalLine.replace(/\{\s*\}/, '{ console.error(e); }');
        description = 'Add error logging to catch block';
      }
      break;
    case 'security':
      return null;
    default:
      break;
  }

  if (fixedLine === originalLine) {
    return null;
  }

  return {
    id: `patch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    file: issue.file,
    diff: `@@ -${issue.line},1 +${issue.line},1 @@\n-${originalLine}\n+${fixedLine}`,
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
