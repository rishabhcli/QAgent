/**
 * Unit tests for GitHub Patches Integration
 * Tests branch creation, patch application, and PR workflow
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPatch, createMockOctokit } from './test-utils';

// Mock Octokit
const mockOctokit = createMockOctokit();

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => mockOctokit),
}));

// Mock global fetch for Vercel API
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocks
import {
  parseRepoName,
  createOctokitClient,
  getDefaultBranch,
  getBranchSha,
  createBranch,
  getFileContent,
  applyPatchToContent,
  commitPatch,
  createPullRequest,
  mergePullRequest,
  createPatchPR,
  getVercelPreviewUrl,
  triggerVercelDeployment,
} from '@/lib/github/patches';

describe('GitHub Patches', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock implementations
    mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        content: Buffer.from('const x = 1;\nconst y = 2;\nexport default x;').toString('base64'),
        sha: 'abc123',
      },
    });
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({
      data: { commit: { sha: 'commit123' } },
    });
    mockOctokit.git.getRef.mockResolvedValue({ data: { object: { sha: 'sha123' } } });
    mockOctokit.git.createRef.mockResolvedValue({});
    mockOctokit.pulls.create.mockResolvedValue({
      data: { html_url: 'https://github.com/owner/repo/pull/1', number: 1 },
    });
    mockOctokit.pulls.merge.mockResolvedValue({
      data: { merged: true, sha: 'merge123', message: 'Pull Request successfully merged' },
    });
  });

  describe('parseRepoName()', () => {
    it('should parse valid repo name "owner/repo"', () => {
      const result = parseRepoName('octocat/hello-world');

      expect(result.owner).toBe('octocat');
      expect(result.repo).toBe('hello-world');
    });

    it('should throw for invalid format (no slash)', () => {
      expect(() => parseRepoName('invalid-repo-name')).toThrow('Invalid repository name');
    });

    it('should throw for empty owner', () => {
      expect(() => parseRepoName('/repo')).toThrow('Invalid repository name');
    });

    it('should throw for empty repo', () => {
      expect(() => parseRepoName('owner/')).toThrow('Invalid repository name');
    });
  });

  describe('createOctokitClient()', () => {
    it('should create client with access token', () => {
      const client = createOctokitClient('test-token');

      expect(client).toBeDefined();
    });
  });

  describe('getDefaultBranch()', () => {
    it('should return default branch from API', async () => {
      const result = await getDefaultBranch(mockOctokit as any, 'owner', 'repo');

      expect(result).toBe('main');
      expect(mockOctokit.repos.get).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo' });
    });

    it('should handle API errors', async () => {
      mockOctokit.repos.get.mockRejectedValueOnce(new Error('Not found'));

      await expect(getDefaultBranch(mockOctokit as any, 'owner', 'repo')).rejects.toThrow(
        'Not found'
      );
    });
  });

  describe('getBranchSha()', () => {
    it('should return SHA from git ref', async () => {
      const result = await getBranchSha(mockOctokit as any, 'owner', 'repo', 'main');

      expect(result).toBe('sha123');
      expect(mockOctokit.git.getRef).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        ref: 'heads/main',
      });
    });

    it('should handle missing branch', async () => {
      mockOctokit.git.getRef.mockRejectedValueOnce(new Error('Reference not found'));

      await expect(getBranchSha(mockOctokit as any, 'owner', 'repo', 'nonexistent')).rejects.toThrow(
        'Reference not found'
      );
    });
  });

  describe('createBranch()', () => {
    it('should create ref with correct parameters', async () => {
      await createBranch(mockOctokit as any, 'owner', 'repo', 'feature-branch', 'sha123');

      expect(mockOctokit.git.createRef).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        ref: 'refs/heads/feature-branch',
        sha: 'sha123',
      });
    });

    it('should handle branch creation errors', async () => {
      mockOctokit.git.createRef.mockRejectedValueOnce(new Error('Reference already exists'));

      await expect(
        createBranch(mockOctokit as any, 'owner', 'repo', 'existing-branch', 'sha123')
      ).rejects.toThrow('Reference already exists');
    });
  });

  describe('getFileContent()', () => {
    it('should return decoded content and SHA', async () => {
      const result = await getFileContent(mockOctokit as any, 'owner', 'repo', 'src/test.ts', 'main');

      expect(result.content).toContain('const x = 1');
      expect(result.sha).toBe('abc123');
    });

    it('should throw for directory paths', async () => {
      mockOctokit.repos.getContent.mockResolvedValueOnce({
        data: [{ type: 'file', name: 'test.ts' }], // Array indicates directory
      });

      await expect(
        getFileContent(mockOctokit as any, 'owner', 'repo', 'src/', 'main')
      ).rejects.toThrow('is not a file');
    });

    it('should handle file not found', async () => {
      mockOctokit.repos.getContent.mockRejectedValueOnce(new Error('Not Found'));

      await expect(
        getFileContent(mockOctokit as any, 'owner', 'repo', 'nonexistent.ts', 'main')
      ).rejects.toThrow('Not Found');
    });
  });

  describe('applyPatchToContent()', () => {
    const originalContent = `const x = 1;
const y = 2;
export default x;`;

    it('should apply simple patch correctly', () => {
      const patch = createMockPatch({
        diff: `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const z = 3;
 const y = 2;`,
      });

      const result = applyPatchToContent(originalContent, patch);

      expect(result).toContain('const z = 3');
    });

    it('should handle multi-line additions', () => {
      const patch = createMockPatch({
        diff: `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,1 +1,4 @@
+// Header
+import { foo } from 'bar';
+
 const x = 1;`,
      });

      const result = applyPatchToContent(originalContent, patch);

      expect(result).toContain('// Header');
      expect(result).toContain("import { foo }");
    });

    it('should throw for invalid patch format (no start line)', () => {
      const patch = createMockPatch({
        diff: 'no valid diff markers here',
      });

      expect(() => applyPatchToContent(originalContent, patch)).toThrow('Invalid patch format');
    });

    it('should preserve lines before and after patch', () => {
      const patch = createMockPatch({
        diff: `--- a/src/test.ts
+++ b/src/test.ts
@@ -2,1 +2,2 @@
 const y = 2;
+const z = 3;`,
      });

      const result = applyPatchToContent(originalContent, patch);

      expect(result).toContain('const x = 1');
      expect(result).toContain('export default x');
    });
  });

  describe('commitPatch()', () => {
    it('should create commit with correct message', async () => {
      const patch = createMockPatch({ description: 'Fix button handler' });

      const result = await commitPatch(
        mockOctokit as any,
        'owner',
        'repo',
        'feature-branch',
        patch,
        'file-sha',
        'new content'
      );

      expect(result).toBe('commit123');
      expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Fix button handler'),
        })
      );
    });

    it('should return commit SHA', async () => {
      const patch = createMockPatch();

      const result = await commitPatch(
        mockOctokit as any,
        'owner',
        'repo',
        'branch',
        patch,
        'sha',
        'content'
      );

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('createPullRequest()', () => {
    it('should create PR with correct parameters', async () => {
      const result = await createPullRequest(
        mockOctokit as any,
        'owner',
        'repo',
        'feature-branch',
        'main',
        'Fix: Button handler',
        'This PR fixes the button handler'
      );

      expect(result.url).toBe('https://github.com/owner/repo/pull/1');
      expect(result.number).toBe(1);
    });

    it('should return PR URL and number', async () => {
      const result = await createPullRequest(
        mockOctokit as any,
        'owner',
        'repo',
        'head',
        'base',
        'title',
        'body'
      );

      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('number');
    });
  });

  describe('mergePullRequest()', () => {
    it('should merge a PR with the requested method', async () => {
      const result = await mergePullRequest(
        mockOctokit as any,
        'owner',
        'repo',
        1,
        'squash'
      );

      expect(result.merged).toBe(true);
      expect(result.sha).toBe('merge123');
      expect(mockOctokit.pulls.merge).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        pull_number: 1,
        merge_method: 'squash',
      });
    });
  });

  describe('createPatchPR() - Full Workflow', () => {
    it('should complete full PR creation workflow', async () => {
      const patch = createMockPatch({
        file: 'src/test.ts',
        description: 'Fix bug',
      });

      const diagnosis = {
        rootCause: 'Missing handler',
        confidence: 0.9,
        suggestedFix: 'Add handler',
      };

      const result = await createPatchPR('token', 'owner/repo', patch, diagnosis, {
        autoMerge: true,
      });

      expect(result).toHaveProperty('branchName');
      expect(result).toHaveProperty('commitSha');
      expect(result).toHaveProperty('prUrl');
      expect(result).toHaveProperty('prNumber');
      expect(result.merged).toBe(true);
      expect(result.mergeCommitSha).toBe('merge123');
      expect(result.branchName).toContain('qagent');
    });

    it('should handle errors at any step', async () => {
      mockOctokit.repos.get.mockRejectedValueOnce(new Error('API Error'));

      const patch = createMockPatch();
      const diagnosis = { rootCause: 'test', confidence: 0.5, suggestedFix: 'fix' };

      await expect(createPatchPR('token', 'owner/repo', patch, diagnosis)).rejects.toThrow(
        'API Error'
      );
    });

    it('should keep the PR open when merge fails', async () => {
      mockOctokit.pulls.merge.mockRejectedValueOnce(new Error('Branch protection blocked merge'));

      const patch = createMockPatch();
      const diagnosis = { rootCause: 'test', confidence: 0.5, suggestedFix: 'fix' };

      const result = await createPatchPR('token', 'owner/repo', patch, diagnosis, {
        autoMerge: true,
      });

      expect(result.prUrl).toBe('https://github.com/owner/repo/pull/1');
      expect(result.merged).toBe(false);
      expect(result.mergeError).toContain('Branch protection blocked merge');
    });
  });

  describe('getVercelPreviewUrl()', () => {
    it('should return preview URL when deployment is ready', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            deployments: [
              { meta: { githubCommitRef: 'feature-branch' }, state: 'READY', url: 'preview.vercel.app' },
            ],
          }),
      });

      const result = await getVercelPreviewUrl('token', 'project-id', 'feature-branch');

      expect(result).toBe('https://preview.vercel.app');
    });

    it('should return null on timeout', async () => {
      // Always return no matching deployment
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ deployments: [] }),
      });

      // Use fake timers to speed up test
      vi.useFakeTimers();

      const promise = getVercelPreviewUrl('token', 'project-id', 'branch');

      // Fast-forward through all polling attempts
      for (let i = 0; i < 30; i++) {
        await vi.advanceTimersByTimeAsync(5000);
      }

      const result = await promise;

      expect(result).toBeNull();

      vi.useRealTimers();
    });
  });

  describe('triggerVercelDeployment()', () => {
    it('should trigger deployment and return result', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: 'deploy-123', url: 'deploy.vercel.app' }),
        })
        .mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ readyState: 'READY', url: 'deploy.vercel.app' }),
        });

      const result = await triggerVercelDeployment('token', 'project-id', 'main');

      expect(result).toHaveProperty('deploymentId');
      expect(result).toHaveProperty('url');
    });

    it('should return null on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve('Unauthorized'),
      });

      const result = await triggerVercelDeployment('token', 'project-id', 'main');

      expect(result).toBeNull();
    });
  });
});
