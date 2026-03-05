/**
 * Token Store
 *
 * Manages refresh tokens and session blacklist.
 * Uses Redis when available, falls back to in-memory Map.
 */

import { getRedisClient, isRedisAvailable } from '@/lib/redis/client';

const REFRESH_PREFIX = 'auth:refresh:';
const BLACKLIST_PREFIX = 'auth:blacklist:';
const REFRESH_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days
const BLACKLIST_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours (matches JWT expiry)

// In-memory fallback
const memoryStore = new Map<string, { value: string; expiresAt: number }>();

function cleanExpired(): void {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    if (entry.expiresAt < now) memoryStore.delete(key);
  }
}

export async function createRefreshToken(
  userId: number,
  sessionData: string
): Promise<string> {
  const token = crypto.randomUUID();
  const key = `${REFRESH_PREFIX}${token}`;
  const value = JSON.stringify({ userId, sessionData });

  if (await isRedisAvailable()) {
    const redis = await getRedisClient();
    await redis.set(key, value, { EX: REFRESH_EXPIRY_SECONDS });
  } else {
    memoryStore.set(key, {
      value,
      expiresAt: Date.now() + REFRESH_EXPIRY_SECONDS * 1000,
    });
  }

  return token;
}

export async function validateRefreshToken(
  token: string
): Promise<{ userId: number; sessionData: string } | null> {
  const key = `${REFRESH_PREFIX}${token}`;

  if (await isRedisAvailable()) {
    const redis = await getRedisClient();
    const data = await redis.get(key);
    if (!data) return null;
    return JSON.parse(data);
  }

  cleanExpired();
  const entry = memoryStore.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    memoryStore.delete(key);
    return null;
  }
  return JSON.parse(entry.value);
}

export async function revokeRefreshToken(token: string): Promise<void> {
  const key = `${REFRESH_PREFIX}${token}`;

  if (await isRedisAvailable()) {
    const redis = await getRedisClient();
    await redis.del(key);
  } else {
    memoryStore.delete(key);
  }
}

export async function blacklistSession(jti: string): Promise<void> {
  const key = `${BLACKLIST_PREFIX}${jti}`;

  if (await isRedisAvailable()) {
    const redis = await getRedisClient();
    await redis.set(key, '1', { EX: BLACKLIST_EXPIRY_SECONDS });
  } else {
    memoryStore.set(key, {
      value: '1',
      expiresAt: Date.now() + BLACKLIST_EXPIRY_SECONDS * 1000,
    });
  }
}

export async function isSessionBlacklisted(jti: string): Promise<boolean> {
  const key = `${BLACKLIST_PREFIX}${jti}`;

  if (await isRedisAvailable()) {
    const redis = await getRedisClient();
    return (await redis.exists(key)) === 1;
  }

  cleanExpired();
  const entry = memoryStore.get(key);
  return !!entry && entry.expiresAt >= Date.now();
}
