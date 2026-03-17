import type { TestSpec } from '@/lib/types';
import { getRedisClient, isRedisAvailable } from '@/lib/redis/client';

const TEST_KEY_PREFIX = 'tests:data:';
const ALL_TESTS_KEY = 'tests:all';

const globalForTests = globalThis as unknown as {
  testsMap?: Map<string, TestSpec>;
};

const testSpecs = globalForTests.testsMap ?? new Map<string, TestSpec>();
globalForTests.testsMap = testSpecs;

async function persistSpec(spec: TestSpec): Promise<void> {
  testSpecs.set(spec.id, spec);

  if (!(await isRedisAvailable())) {
    return;
  }

  const redis = await getRedisClient();
  await redis.set(`${TEST_KEY_PREFIX}${spec.id}`, JSON.stringify(spec));
  await redis.sAdd(ALL_TESTS_KEY, spec.id);
}

export async function getAllTestSpecs(): Promise<TestSpec[]> {
  const cached = Array.from(testSpecs.values());

  if (!(await isRedisAvailable())) {
    return cached;
  }

  const redis = await getRedisClient();
  const ids = await redis.sMembers(ALL_TESTS_KEY);
  const result = new Map<string, TestSpec>();

  for (const id of ids) {
    const data = await redis.get(`${TEST_KEY_PREFIX}${id}`);
    if (typeof data === 'string') {
      const spec = JSON.parse(data) as TestSpec;
      testSpecs.set(spec.id, spec);
      result.set(spec.id, spec);
    }
  }

  for (const spec of cached) {
    result.set(spec.id, spec);
  }

  return Array.from(result.values());
}

export async function getTestSpec(id: string): Promise<TestSpec | null> {
  const cached = testSpecs.get(id);
  if (cached) {
    return cached;
  }

  if (!(await isRedisAvailable())) {
    return null;
  }

  const redis = await getRedisClient();
  const data = await redis.get(`${TEST_KEY_PREFIX}${id}`);
  if (typeof data !== 'string') {
    return null;
  }

  const spec = JSON.parse(data) as TestSpec;
  testSpecs.set(spec.id, spec);
  return spec;
}

export async function addTestSpec(spec: TestSpec): Promise<void> {
  await persistSpec(spec);
}

export async function updateTestSpec(id: string, updates: Partial<TestSpec>): Promise<boolean> {
  const spec = await getTestSpec(id);
  if (!spec) {
    return false;
  }

  Object.assign(spec, updates);
  await persistSpec(spec);
  return true;
}

export async function deleteTestSpec(id: string): Promise<boolean> {
  const existing = await getTestSpec(id);
  const existed = testSpecs.delete(id);

  if (!(await isRedisAvailable())) {
    return Boolean(existing || existed);
  }

  const redis = await getRedisClient();
  await redis.del(`${TEST_KEY_PREFIX}${id}`);
  await redis.sRem(ALL_TESTS_KEY, id);
  return Boolean(existing || existed);
}
