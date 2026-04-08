import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getConfigsDueForRun: vi.fn(),
  recordMonitoringRun: vi.fn(),
  enqueueRun: vi.fn(),
  dequeueRun: vi.fn(),
  getQueueStatus: vi.fn(),
  processQueuedRun: vi.fn(),
  cleanupExpiredRuns: vi.fn(),
  cleanupStaleProcessing: vi.fn(),
}));

vi.mock('@/lib/redis/monitoring-config', () => ({
  getConfigsDueForRun: mocks.getConfigsDueForRun,
  recordMonitoringRun: mocks.recordMonitoringRun,
}));

vi.mock('@/lib/redis/queue', () => ({
  enqueueRun: mocks.enqueueRun,
  dequeueRun: mocks.dequeueRun,
  getQueueStatus: mocks.getQueueStatus,
  cleanupStaleProcessing: mocks.cleanupStaleProcessing,
}));

vi.mock('@/lib/queue/processor', () => ({
  processQueuedRun: mocks.processQueuedRun,
}));

vi.mock('@/lib/redis/runs-store', () => ({
  cleanupExpiredRuns: mocks.cleanupExpiredRuns,
}));

import { GET as monitoringCronRoute } from '@/app/api/cron/monitoring/route';
import { GET as cleanupCronRoute } from '@/app/api/cron/cleanup/route';

describe('Cron route authorization', () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'test-cron-secret';
    mocks.getConfigsDueForRun.mockResolvedValue([]);
    mocks.recordMonitoringRun.mockResolvedValue(undefined);
    mocks.enqueueRun.mockResolvedValue(null);
    mocks.dequeueRun.mockResolvedValue(null);
    mocks.getQueueStatus.mockResolvedValue({ pending: 0, processing: 0 });
    mocks.processQueuedRun.mockResolvedValue(undefined);
    mocks.cleanupExpiredRuns.mockResolvedValue(2);
    mocks.cleanupStaleProcessing.mockResolvedValue(1);
  });

  afterEach(() => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  it('returns 503 when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;

    const response = await monitoringCronRoute(
      new NextRequest('http://localhost/api/cron/monitoring')
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'CRON_SECRET is not configured',
    });
  });

  it('rejects spoofed x-vercel-cron headers without the bearer secret', async () => {
    const response = await monitoringCronRoute(
      new NextRequest('http://localhost/api/cron/monitoring', {
        headers: {
          'x-vercel-cron': '1',
        },
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('allows cron execution with the configured bearer secret', async () => {
    const response = await monitoringCronRoute(
      new NextRequest('http://localhost/api/cron/monitoring', {
        headers: {
          authorization: 'Bearer test-cron-secret',
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      scheduled: 0,
      processed: 0,
    });
  });

  it('requires the bearer secret for cleanup cron as well', async () => {
    const response = await cleanupCronRoute(
      new NextRequest('http://localhost/api/cron/cleanup', {
        headers: {
          'x-vercel-cron': '1',
        },
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });
});
