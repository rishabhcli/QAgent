/**
 * Redis-backed Monitoring Configuration Storage
 *
 * Stores per-repository monitoring settings.
 */

import { getRedisClient, isRedisAvailable } from './client';
import type { MonitoringConfig, MonitoringSchedule, TestSpec } from '@/lib/types';

// Redis key prefix
const CONFIG_PREFIX = 'monitoring:config:';
const ALL_CONFIGS_KEY = 'monitoring:all';

/**
 * Serialize config for storage
 */
function serializeConfig(config: MonitoringConfig): string {
  return JSON.stringify({
    ...config,
    lastRunAt: config.lastRunAt instanceof Date ? config.lastRunAt.toISOString() : config.lastRunAt,
    nextRunAt: config.nextRunAt instanceof Date ? config.nextRunAt.toISOString() : config.nextRunAt,
    createdAt: config.createdAt instanceof Date ? config.createdAt.toISOString() : config.createdAt,
    updatedAt: config.updatedAt instanceof Date ? config.updatedAt.toISOString() : config.updatedAt,
  });
}

/**
 * Deserialize config from storage
 */
function deserializeConfig(data: string): MonitoringConfig {
  const parsed = JSON.parse(data);
  return {
    ...parsed,
    lastRunAt: parsed.lastRunAt ? new Date(parsed.lastRunAt) : undefined,
    nextRunAt: parsed.nextRunAt ? new Date(parsed.nextRunAt) : undefined,
    createdAt: new Date(parsed.createdAt),
    updatedAt: new Date(parsed.updatedAt),
  };
}

/**
 * Get monitoring config for a repo
 */
export async function getMonitoringConfig(repoId: string): Promise<MonitoringConfig | null> {
  if (!(await isRedisAvailable())) {
    return null;
  }

  const redis = await getRedisClient();
  const key = `${CONFIG_PREFIX}${repoId}`;
  const data = await redis.get(key);

  if (!data || typeof data !== 'string') {
    return null;
  }

  return deserializeConfig(data);
}

/**
 * Save monitoring config for a repo
 */
export async function saveMonitoringConfig(config: MonitoringConfig): Promise<void> {
  if (!(await isRedisAvailable())) {
    console.warn('Redis not available, config will not be saved');
    return;
  }

  const redis = await getRedisClient();
  const key = `${CONFIG_PREFIX}${config.repoId}`;

  config.updatedAt = new Date();

  await redis.set(key, serializeConfig(config));
  await redis.sAdd(ALL_CONFIGS_KEY, config.repoId);
}

/**
 * Create a new monitoring config
 */
export async function createMonitoringConfig(params: {
  ownerId?: number;
  repoId: string;
  repoFullName: string;
  schedule?: MonitoringSchedule;
  testSpecs?: TestSpec[];
  webhookSecret?: string;
}): Promise<MonitoringConfig> {
  const now = new Date();
  const config: MonitoringConfig = {
    ownerId: params.ownerId,
    repoId: params.repoId,
    repoFullName: params.repoFullName,
    enabled: true,
    schedule: params.schedule || 'on_push',
    testSpecs: params.testSpecs || [],
    webhookSecret: params.webhookSecret,
    createdAt: now,
    updatedAt: now,
  };

  // Calculate next run time for scheduled configs
  if (config.schedule !== 'on_push') {
    config.nextRunAt = calculateNextRunTime(config.schedule);
  }

  await saveMonitoringConfig(config);
  return config;
}

/**
 * Update monitoring config
 */
export async function updateMonitoringConfig(
  repoId: string,
  updates: Partial<MonitoringConfig>
): Promise<MonitoringConfig | null> {
  const existing = await getMonitoringConfig(repoId);
  if (!existing) {
    return null;
  }

  const updated: MonitoringConfig = {
    ...existing,
    ...updates,
    repoId: existing.repoId, // Don't allow changing repoId
    createdAt: existing.createdAt, // Don't allow changing createdAt
    updatedAt: new Date(),
  };

  // Recalculate next run time if schedule changed
  if (updates.schedule && updates.schedule !== existing.schedule) {
    if (updates.schedule === 'on_push') {
      updated.nextRunAt = undefined;
    } else {
      updated.nextRunAt = calculateNextRunTime(updates.schedule);
    }
  }

  await saveMonitoringConfig(updated);
  return updated;
}

/**
 * Delete monitoring config
 */
export async function deleteMonitoringConfig(repoId: string): Promise<boolean> {
  if (!(await isRedisAvailable())) {
    return false;
  }

  const redis = await getRedisClient();
  const key = `${CONFIG_PREFIX}${repoId}`;

  await redis.del(key);
  await redis.sRem(ALL_CONFIGS_KEY, repoId);

  return true;
}

/**
 * Get all monitoring configs
 */
export async function getAllMonitoringConfigs(): Promise<MonitoringConfig[]> {
  if (!(await isRedisAvailable())) {
    return [];
  }

  const redis = await getRedisClient();
  const repoIds = await redis.sMembers(ALL_CONFIGS_KEY);

  const configs: MonitoringConfig[] = [];
  for (const repoId of repoIds) {
    const config = await getMonitoringConfig(repoId);
    if (config) {
      configs.push(config);
    }
  }

  return configs;
}

/**
 * Get enabled configs that are due for scheduled runs
 */
export async function getConfigsDueForRun(): Promise<MonitoringConfig[]> {
  const allConfigs = await getAllMonitoringConfigs();
  const now = new Date();

  return allConfigs.filter((config) => {
    if (!config.enabled) return false;
    if (config.schedule === 'on_push') return false;
    if (!config.nextRunAt) return false;
    return config.nextRunAt <= now;
  });
}

/**
 * Record that a run was completed for a config
 */
export async function recordMonitoringRun(repoId: string): Promise<void> {
  const config = await getMonitoringConfig(repoId);
  if (!config) return;

  const now = new Date();
  const updates: Partial<MonitoringConfig> = {
    lastRunAt: now,
  };

  // Calculate next run time for scheduled configs
  if (config.schedule !== 'on_push') {
    updates.nextRunAt = calculateNextRunTime(config.schedule);
  }

  await updateMonitoringConfig(repoId, updates);
}

/**
 * Calculate the next run time for a schedule
 */
export function calculateNextRunTime(schedule: MonitoringSchedule): Date {
  const now = new Date();
  const next = new Date(now);

  switch (schedule) {
    case 'hourly':
      next.setHours(next.getHours() + 1);
      next.setMinutes(0);
      next.setSeconds(0);
      next.setMilliseconds(0);
      break;

    case 'daily':
      next.setDate(next.getDate() + 1);
      next.setHours(0);
      next.setMinutes(0);
      next.setSeconds(0);
      next.setMilliseconds(0);
      break;

    case 'weekly':
      next.setDate(next.getDate() + 7);
      next.setHours(0);
      next.setMinutes(0);
      next.setSeconds(0);
      next.setMilliseconds(0);
      break;

    case 'on_push':
      // No scheduled run for on_push
      break;
  }

  return next;
}

/**
 * Toggle monitoring for a repo
 */
export async function toggleMonitoring(
  repoId: string,
  enabled: boolean
): Promise<MonitoringConfig | null> {
  return updateMonitoringConfig(repoId, { enabled });
}
