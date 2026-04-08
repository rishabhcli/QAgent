import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  verifyWebhookSignature: vi.fn(),
  getWebhookEventType: vi.fn(),
  getWebhookDeliveryId: vi.fn(),
  isTriggeringEvent: vi.fn(),
  isTriggeringPRAction: vi.fn(),
  enqueueRun: vi.fn(),
  getMonitoringConfig: vi.fn(),
}));

vi.mock('@/lib/github/webhook-validator', () => ({
  verifyWebhookSignature: mocks.verifyWebhookSignature,
  getWebhookEventType: mocks.getWebhookEventType,
  getWebhookDeliveryId: mocks.getWebhookDeliveryId,
  isTriggeringEvent: mocks.isTriggeringEvent,
  isTriggeringPRAction: mocks.isTriggeringPRAction,
}));

vi.mock('@/lib/redis/queue', () => ({
  enqueueRun: mocks.enqueueRun,
}));

vi.mock('@/lib/redis/monitoring-config', () => ({
  getMonitoringConfig: mocks.getMonitoringConfig,
}));

import { POST as webhookRoute } from '@/app/api/webhooks/github/route';

describe('GitHub webhook authorization', () => {
  const originalWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_WEBHOOK_SECRET = 'legacy-secret';
    mocks.getWebhookEventType.mockReturnValue('push');
    mocks.getWebhookDeliveryId.mockReturnValue('delivery-1');
    mocks.isTriggeringEvent.mockReturnValue(true);
    mocks.isTriggeringPRAction.mockReturnValue(true);
    mocks.verifyWebhookSignature.mockReturnValue(true);
    mocks.enqueueRun.mockResolvedValue(null);
    mocks.getMonitoringConfig.mockResolvedValue({
      repoId: '123',
      repoFullName: 'owner/repo',
      enabled: false,
      schedule: 'on_push',
      testSpecs: [],
      webhookSecret: 'repo-secret',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  afterEach(() => {
    if (originalWebhookSecret === undefined) {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    } else {
      process.env.GITHUB_WEBHOOK_SECRET = originalWebhookSecret;
    }
  });

  it('verifies signatures with the repo-specific webhook secret when available', async () => {
    const response = await webhookRoute(
      new NextRequest('http://localhost/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'delivery-1',
          'x-hub-signature-256': 'sha256=signature',
        },
        body: JSON.stringify({
          ref: 'refs/heads/main',
          after: 'commit-sha',
          repository: {
            id: 123,
            full_name: 'owner/repo',
            default_branch: 'main',
          },
          pusher: {
            name: 'owner',
          },
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.verifyWebhookSignature).toHaveBeenCalledWith(
      expect.any(String),
      'sha256=signature',
      'repo-secret'
    );
  });

  it('falls back to the legacy global webhook secret when the repo config has none', async () => {
    mocks.getMonitoringConfig.mockResolvedValueOnce({
      repoId: '123',
      repoFullName: 'owner/repo',
      enabled: false,
      schedule: 'on_push',
      testSpecs: [],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await webhookRoute(
      new NextRequest('http://localhost/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'delivery-1',
          'x-hub-signature-256': 'sha256=signature',
        },
        body: JSON.stringify({
          ref: 'refs/heads/main',
          after: 'commit-sha',
          repository: {
            id: 123,
            full_name: 'owner/repo',
            default_branch: 'main',
          },
          pusher: {
            name: 'owner',
          },
        }),
      })
    );

    expect(mocks.verifyWebhookSignature).toHaveBeenCalledWith(
      expect.any(String),
      'sha256=signature',
      'legacy-secret'
    );
  });

  it('returns 500 when no webhook secret is configured anywhere', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    mocks.getMonitoringConfig.mockResolvedValueOnce(null);

    const response = await webhookRoute(
      new NextRequest('http://localhost/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'delivery-1',
          'x-hub-signature-256': 'sha256=signature',
        },
        body: JSON.stringify({
          ref: 'refs/heads/main',
          after: 'commit-sha',
          repository: {
            id: 123,
            full_name: 'owner/repo',
            default_branch: 'main',
          },
          pusher: {
            name: 'owner',
          },
        }),
      })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Webhook secret not configured',
    });
    expect(mocks.verifyWebhookSignature).not.toHaveBeenCalled();
  });
});
