import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getAllPatches: vi.fn(),
  getPatch: vi.fn(),
  updatePatchStatus: vi.fn(),
  isRepoAllowed: vi.fn(),
  createPatchPR: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  getSession: mocks.getSession,
}));

vi.mock('@/lib/dashboard/patch-store', () => ({
  getAllPatches: mocks.getAllPatches,
  getPatch: mocks.getPatch,
  updatePatchStatus: mocks.updatePatchStatus,
}));

vi.mock('@/lib/auth/repo-access', () => ({
  isRepoAllowed: mocks.isRepoAllowed,
}));

vi.mock('@/lib/github/patches', () => ({
  createPatchPR: mocks.createPatchPR,
}));

import { GET as listPatchesRoute } from '@/app/api/patches/route';
import { POST as applyPatchRoute } from '@/app/api/patches/[patchId]/apply/route';

describe('Patch route authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      user: { id: 42, login: 'owner' },
      accessToken: 'token',
      repos: [
        {
          id: 123,
          name: 'repo',
          fullName: 'owner/repo',
          url: 'https://github.com/owner/repo',
          defaultBranch: 'main',
        },
      ],
      selectedRepoIds: [123],
    });
    mocks.getAllPatches.mockResolvedValue([
      {
        id: 'patch-owner',
        ownerId: 42,
        file: 'src/owned.ts',
        description: 'Owned patch',
        diff: 'diff-owner',
        metadata: { linesAdded: 1, linesRemoved: 0, llmModel: 'gpt', promptTokens: 10 },
        status: 'pending',
        runId: 'run-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        diagnosis: { type: 'UI_BUG', confidence: 0.8, rootCause: 'Owned cause' },
      },
      {
        id: 'patch-other',
        ownerId: 99,
        file: 'src/other.ts',
        description: 'Other patch',
        diff: 'diff-other',
        metadata: { linesAdded: 1, linesRemoved: 0, llmModel: 'gpt', promptTokens: 10 },
        status: 'pending',
        runId: 'run-2',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        diagnosis: { type: 'UI_BUG', confidence: 0.6, rootCause: 'Other cause' },
      },
    ]);
    mocks.getPatch.mockResolvedValue({
      id: 'patch-owner',
      ownerId: 42,
      file: 'src/owned.ts',
      description: 'Owned patch',
      diff: 'diff-owner',
      metadata: { linesAdded: 1, linesRemoved: 0, llmModel: 'gpt', promptTokens: 10 },
      status: 'pending',
      runId: 'run-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      diagnosis: { type: 'UI_BUG', confidence: 0.8, rootCause: 'Owned cause' },
    });
    mocks.isRepoAllowed.mockResolvedValue(true);
    mocks.createPatchPR.mockResolvedValue({
      branchName: 'qagent/fix',
      commitSha: 'commit-sha',
      prUrl: 'https://github.com/owner/repo/pull/1',
      prNumber: 1,
      merged: false,
      mergeMethod: undefined,
      mergeCommitSha: undefined,
      mergeError: undefined,
    });
    mocks.updatePatchStatus.mockResolvedValue(true);
  });

  it('returns 401 when listing patches without a session', async () => {
    mocks.getSession.mockResolvedValueOnce(null);

    const response = await listPatchesRoute();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('returns only patches owned by the current user', async () => {
    const response = await listPatchesRoute();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.patches).toHaveLength(1);
    expect(body.patches[0]).toMatchObject({
      id: 'patch-owner',
      description: 'Owned patch',
    });
  });

  it('returns 404 when applying a patch owned by another user', async () => {
    mocks.getPatch.mockResolvedValueOnce({
      id: 'patch-other',
      ownerId: 99,
      status: 'pending',
    });

    const response = await applyPatchRoute(
      new NextRequest('http://localhost/api/patches/patch-other/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repoOwner: 'owner',
          repoName: 'repo',
        }),
      }),
      { params: Promise.resolve({ patchId: 'patch-other' }) }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Patch not found' });
    expect(mocks.createPatchPR).not.toHaveBeenCalled();
  });

  it('returns 403 when the target repository is not allowed', async () => {
    mocks.isRepoAllowed.mockResolvedValueOnce(false);

    const response = await applyPatchRoute(
      new NextRequest('http://localhost/api/patches/patch-owner/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repoOwner: 'other',
          repoName: 'repo',
        }),
      }),
      { params: Promise.resolve({ patchId: 'patch-owner' }) }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Repository access is not authorized',
    });
    expect(mocks.createPatchPR).not.toHaveBeenCalled();
  });

  it('applies a patch when the owner and repository are authorized', async () => {
    const response = await applyPatchRoute(
      new NextRequest('http://localhost/api/patches/patch-owner/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repoOwner: 'owner',
          repoName: 'repo',
          autoMerge: false,
        }),
      }),
      { params: Promise.resolve({ patchId: 'patch-owner' }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      prUrl: 'https://github.com/owner/repo/pull/1',
    });
    expect(mocks.createPatchPR).toHaveBeenCalledTimes(1);
    expect(mocks.updatePatchStatus).toHaveBeenCalledWith(
      'patch-owner',
      'pending',
      expect.objectContaining({
        prUrl: 'https://github.com/owner/repo/pull/1',
        prNumber: 1,
      })
    );
  });
});
