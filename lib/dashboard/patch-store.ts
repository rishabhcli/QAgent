import type { Patch, FailureType } from '@/lib/types';
import type { GitHubMergeMethod } from '@/lib/github/patches';
import { getRedisClient, isRedisAvailable } from '@/lib/redis/client';

export interface PatchWithDetails extends Patch {
  status: 'pending' | 'applied' | 'rejected';
  runId: string;
  createdAt: Date;
  prUrl?: string;
  prNumber?: number;
  merged?: boolean;
  mergeMethod?: GitHubMergeMethod;
  mergeCommitSha?: string;
  mergeError?: string;
  diagnosis: {
    type: FailureType;
    confidence: number;
    rootCause: string;
  };
}

const PATCH_KEY_PREFIX = 'patches:data:';
const ALL_PATCHES_KEY = 'patches:all';

const globalForPatches = globalThis as unknown as {
  patchesMap?: Map<string, PatchWithDetails>;
};

const patches = globalForPatches.patchesMap ?? new Map<string, PatchWithDetails>();
globalForPatches.patchesMap = patches;

function serializePatch(patch: PatchWithDetails): string {
  return JSON.stringify({
    ...patch,
    createdAt: patch.createdAt instanceof Date ? patch.createdAt.toISOString() : patch.createdAt,
  });
}

function deserializePatch(data: string): PatchWithDetails {
  const parsed = JSON.parse(data) as PatchWithDetails & { createdAt: string };
  return {
    ...parsed,
    createdAt: new Date(parsed.createdAt),
  };
}

async function persistPatch(patch: PatchWithDetails): Promise<void> {
  patches.set(patch.id, patch);

  if (!(await isRedisAvailable())) {
    return;
  }

  const redis = await getRedisClient();
  await redis.set(`${PATCH_KEY_PREFIX}${patch.id}`, serializePatch(patch));
  await redis.zAdd(ALL_PATCHES_KEY, {
    score: patch.createdAt.getTime(),
    value: patch.id,
  });
}

export async function getAllPatches(): Promise<PatchWithDetails[]> {
  const cached = Array.from(patches.values());

  if (!(await isRedisAvailable())) {
    return cached.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  const redis = await getRedisClient();
  const patchIds = await redis.zRange(ALL_PATCHES_KEY, '+inf', '-inf', {
    BY: 'SCORE',
    REV: true,
  });

  const patchMap = new Map<string, PatchWithDetails>();

  for (const patchId of patchIds) {
    const data = await redis.get(`${PATCH_KEY_PREFIX}${patchId}`);
    if (typeof data === 'string') {
      const patch = deserializePatch(data);
      patches.set(patch.id, patch);
      patchMap.set(patch.id, patch);
    }
  }

  for (const patch of cached) {
    patchMap.set(patch.id, patch);
  }

  return Array.from(patchMap.values()).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
}

export async function getPatch(id: string): Promise<PatchWithDetails | null> {
  const cached = patches.get(id);
  if (cached) {
    return cached;
  }

  if (!(await isRedisAvailable())) {
    return null;
  }

  const redis = await getRedisClient();
  const data = await redis.get(`${PATCH_KEY_PREFIX}${id}`);
  if (typeof data !== 'string') {
    return null;
  }

  const patch = deserializePatch(data);
  patches.set(id, patch);
  return patch;
}

export async function addPatch(patch: PatchWithDetails): Promise<void> {
  await persistPatch(patch);
}

export async function addPatchFromRun(runId: string, patch: Patch): Promise<void> {
  const existing = await getPatch(patch.id);
  if (existing) {
    return;
  }

  await persistPatch({
    ...patch,
    mergeMethod: patch.mergeMethod as GitHubMergeMethod | undefined,
    runId,
    status: 'pending',
    createdAt: new Date(),
    diagnosis: {
      type: 'UNKNOWN',
      confidence: 0,
      rootCause: 'Awaiting diagnosis details.',
    },
  });
}

export async function updatePatchStatus(
  id: string,
  status: 'pending' | 'applied' | 'rejected',
  details?: {
    prUrl?: string;
    prNumber?: number;
    merged?: boolean;
    mergeMethod?: GitHubMergeMethod;
    mergeCommitSha?: string;
    mergeError?: string;
  }
): Promise<boolean> {
  const patch = await getPatch(id);
  if (!patch) {
    return false;
  }

  patch.status = status;
  if (details?.prUrl) {
    patch.prUrl = details.prUrl;
  }
  if (details?.prNumber !== undefined) {
    patch.prNumber = details.prNumber;
  }
  if (details?.merged !== undefined) {
    patch.merged = details.merged;
  }
  if (details?.mergeMethod) {
    patch.mergeMethod = details.mergeMethod;
  }
  if (details?.mergeCommitSha) {
    patch.mergeCommitSha = details.mergeCommitSha;
  }
  if (details?.mergeError !== undefined) {
    patch.mergeError = details.mergeError;
  }

  await persistPatch(patch);
  return true;
}
