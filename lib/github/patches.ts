/**
 * GitHub Patches Integration
 *
 * Handles creating branches, committing patches, creating PRs,
 * and optionally merging them for the cloud-first PatchPilot workflow.
 */

import { Octokit } from '@octokit/rest';
import type { Patch } from '@/lib/types';

export interface GitHubRepo {
  owner: string;
  repo: string;
  defaultBranch: string;
}

export interface PatchBranchResult {
  branchName: string;
  commitSha: string;
  prUrl?: string;
  prNumber?: number;
  merged?: boolean;
  mergeMethod?: GitHubMergeMethod;
  mergeCommitSha?: string;
  mergeError?: string;
}

export type GitHubMergeMethod = 'merge' | 'squash' | 'rebase';

export interface PatchPRWorkflowOptions {
  autoMerge?: boolean;
  mergeMethod?: GitHubMergeMethod;
}

/**
 * Parse a full repository name into owner and repo
 */
export function parseRepoName(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid repository name: ${fullName}`);
  }
  return { owner, repo };
}

/**
 * Create an Octokit client with the given access token
 */
export function createOctokitClient(accessToken: string): Octokit {
  return new Octokit({ auth: accessToken });
}

/**
 * Get the default branch of a repository
 */
export async function getDefaultBranch(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<string> {
  const { data } = await octokit.repos.get({ owner, repo });
  return data.default_branch;
}

/**
 * Get the SHA of a branch
 */
export async function getBranchSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string
): Promise<string> {
  const { data } = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  return data.object.sha;
}

/**
 * Create a new branch from the default branch
 */
export async function createBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
  baseSha: string
): Promise<void> {
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });
}

/**
 * Get file content from a repository
 */
export async function getFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  branch: string
): Promise<{ content: string; sha: string }> {
  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path,
    ref: branch,
  });

  if (Array.isArray(data) || data.type !== 'file') {
    throw new Error(`Path ${path} is not a file`);
  }

  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { content, sha: data.sha };
}

/**
 * Apply a patch to file content
 */
export function applyPatchToContent(originalContent: string, patch: Patch): string {
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
    throw new Error('Invalid patch format: no start line found');
  }

  const lines = originalContent.split('\n');
  const beforeLines = lines.slice(0, startLine - 1);
  const afterLines = lines.slice(startLine - 1 + removeCount);

  return [...beforeLines, ...addedLines, ...afterLines].join('\n');
}

/**
 * Commit a patch to a branch
 */
export async function commitPatch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  patch: Patch,
  fileSha: string,
  newContent: string
): Promise<string> {
  const message = `fix: ${patch.description}\n\nApplied automatically by PatchPilot`;

  const { data } = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: patch.file,
    message,
    content: Buffer.from(newContent).toString('base64'),
    sha: fileSha,
    branch,
  });

  return data.commit.sha || '';
}

/**
 * Create a pull request
 */
export async function createPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<{ url: string; number: number }> {
  const { data } = await octokit.pulls.create({
    owner,
    repo,
    title,
    body,
    head,
    base,
  });

  return {
    url: data.html_url,
    number: data.number,
  };
}

/**
 * Merge an open pull request.
 */
export async function mergePullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  mergeMethod: GitHubMergeMethod = 'squash'
): Promise<{ merged: boolean; sha?: string; message?: string }> {
  const { data } = await octokit.pulls.merge({
    owner,
    repo,
    pull_number: pullNumber,
    merge_method: mergeMethod,
  });

  return {
    merged: data.merged,
    sha: data.sha,
    message: data.message,
  };
}

/**
 * Full workflow: Create branch, apply patch, commit, and create PR
 */
export async function createPatchPR(
  accessToken: string,
  repoFullName: string,
  patch: Patch,
  diagnosis: {
    rootCause: string;
    confidence: number;
    suggestedFix: string;
  },
  options: PatchPRWorkflowOptions = {}
): Promise<PatchBranchResult> {
  const octokit = createOctokitClient(accessToken);
  const { owner, repo } = parseRepoName(repoFullName);
  const mergeMethod = options.mergeMethod || 'squash';

  // 1. Get default branch and its SHA
  const defaultBranch = await getDefaultBranch(octokit, owner, repo);
  const baseSha = await getBranchSha(octokit, owner, repo, defaultBranch);

  // 2. Generate branch name
  const timestamp = Date.now();
  const safePatchDesc = patch.description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 30);
  const branchName = `patchpilot/fix-${safePatchDesc}-${timestamp}`;

  // 3. Create branch
  await createBranch(octokit, owner, repo, branchName, baseSha);

  // 4. Get original file content
  const { content: originalContent, sha: fileSha } = await getFileContent(
    octokit,
    owner,
    repo,
    patch.file,
    branchName
  );

  // 5. Apply patch
  const newContent = applyPatchToContent(originalContent, patch);

  // 6. Commit changes
  const commitSha = await commitPatch(
    octokit,
    owner,
    repo,
    branchName,
    patch,
    fileSha,
    newContent
  );

  // 7. Create PR
  const prTitle = `[PatchPilot] Fix: ${patch.description}`;
  const prBody = `## 🐛 Bug Detected

**Root Cause:** ${diagnosis.rootCause}

**Confidence:** ${Math.round(diagnosis.confidence * 100)}%

## 🔧 Fix Applied

${patch.description}

### Changes

\`\`\`diff
${patch.diff}
\`\`\`

---

*This PR was automatically generated by PatchPilot, a self-healing QA agent.*
`;

  const { url: prUrl, number: prNumber } = await createPullRequest(
    octokit,
    owner,
    repo,
    branchName,
    defaultBranch,
    prTitle,
    prBody
  );

  let merged = false;
  let mergeCommitSha: string | undefined;
  let mergeError: string | undefined;

  if (options.autoMerge) {
    try {
      const mergeResult = await mergePullRequest(
        octokit,
        owner,
        repo,
        prNumber,
        mergeMethod
      );
      merged = mergeResult.merged;
      mergeCommitSha = mergeResult.sha;
      if (!mergeResult.merged) {
        mergeError = mergeResult.message || 'GitHub did not merge the pull request';
      }
    } catch (error) {
      mergeError = error instanceof Error ? error.message : 'Failed to merge pull request';
    }
  }

  return {
    branchName,
    commitSha,
    prUrl,
    prNumber,
    merged,
    mergeMethod: options.autoMerge ? mergeMethod : undefined,
    mergeCommitSha,
    mergeError,
  };
}

/**
 * Get the deployed Vercel preview URL for a branch
 * This relies on Vercel's GitHub integration auto-deploying branches
 */
export async function getVercelPreviewUrl(
  vercelToken: string,
  projectId: string,
  branch: string
): Promise<string | null> {
  const maxAttempts = 30; // 2.5 minutes max
  const pollInterval = 5000; // 5 seconds

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(
        `https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=5`,
        {
          headers: {
            Authorization: `Bearer ${vercelToken}`,
          },
        }
      );

      const data = await response.json();
      
      // Find deployment for our branch
      const deployment = data.deployments?.find(
        (d: { meta?: { githubCommitRef?: string }; state: string }) =>
          d.meta?.githubCommitRef === branch && d.state === 'READY'
      );

      if (deployment) {
        return `https://${deployment.url}`;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error checking Vercel deployment:', error);
    }
  }

  return null;
}

/**
 * Trigger a Vercel deployment for a GitHub repo
 */
export async function triggerVercelDeployment(
  vercelToken: string,
  projectId: string,
  gitRef: string = 'main'
): Promise<{ deploymentId: string; url: string } | null> {
  try {
    const response = await fetch(
      `https://api.vercel.com/v13/deployments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${vercelToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: projectId,
          gitSource: {
            ref: gitRef,
            type: 'github',
          },
          target: 'preview',
        }),
      }
    );

    if (!response.ok) {
      // eslint-disable-next-line no-console
      console.error('Failed to trigger Vercel deployment:', await response.text());
      return null;
    }

    const data = await response.json();
    
    // Wait for deployment to be ready
    const deploymentUrl = await waitForVercelDeployment(
      vercelToken,
      data.id
    );

    return {
      deploymentId: data.id,
      url: deploymentUrl || `https://${data.url}`,
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Error triggering Vercel deployment:', error);
    return null;
  }
}

/**
 * Wait for a Vercel deployment to be ready
 */
async function waitForVercelDeployment(
  vercelToken: string,
  deploymentId: string
): Promise<string | null> {
  const maxAttempts = 60; // 5 minutes max
  const pollInterval = 5000; // 5 seconds

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(
        `https://api.vercel.com/v13/deployments/${deploymentId}`,
        {
          headers: {
            Authorization: `Bearer ${vercelToken}`,
          },
        }
      );

      const data = await response.json();

      if (data.readyState === 'READY') {
        return `https://${data.url}`;
      }

      if (data.readyState === 'ERROR' || data.readyState === 'CANCELED') {
        // eslint-disable-next-line no-console
        console.error('Vercel deployment failed:', data.readyState);
        return null;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error checking deployment status:', error);
    }
  }

  return null;
}
