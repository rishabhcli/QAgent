import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  isRepoAllowed: vi.fn(),
  getAllMonitoringConfigs: vi.fn(),
  getMonitoringConfig: vi.fn(),
  createMonitoringConfig: vi.fn(),
  updateMonitoringConfig: vi.fn(),
  deleteMonitoringConfig: vi.fn(),
  generateWebhookSecret: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  getSession: mocks.getSession,
}));

vi.mock('@/lib/auth/repo-access', () => ({
  isRepoAllowed: mocks.isRepoAllowed,
}));

vi.mock('@/lib/redis/monitoring-config', () => ({
  getAllMonitoringConfigs: mocks.getAllMonitoringConfigs,
  getMonitoringConfig: mocks.getMonitoringConfig,
  createMonitoringConfig: mocks.createMonitoringConfig,
  updateMonitoringConfig: mocks.updateMonitoringConfig,
  deleteMonitoringConfig: mocks.deleteMonitoringConfig,
}));

vi.mock('@/lib/github/webhook-validator', () => ({
  generateWebhookSecret: mocks.generateWebhookSecret,
}));

import {
  GET as listMonitoringConfigsRoute,
  POST as createMonitoringConfigRoute,
} from '@/app/api/monitoring/configs/route';
import {
  GET as getMonitoringConfigRoute,
  PATCH as updateMonitoringConfigRouteHandler,
  DELETE as deleteMonitoringConfigRouteHandler,
} from '@/app/api/monitoring/configs/[repoId]/route';

describe('Monitoring route authorization', () => {
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
    mocks.isRepoAllowed.mockResolvedValue(true);
    mocks.getAllMonitoringConfigs.mockResolvedValue([
      {
        ownerId: 42,
        repoId: '123',
        repoFullName: 'owner/repo',
        enabled: true,
        schedule: 'on_push',
        testSpecs: [],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        ownerId: 99,
        repoId: '999',
        repoFullName: 'other/repo',
        enabled: true,
        schedule: 'daily',
        testSpecs: [],
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]);
    mocks.getMonitoringConfig.mockResolvedValue({
      ownerId: 42,
      repoId: '123',
      repoFullName: 'owner/repo',
      enabled: true,
      schedule: 'on_push',
      testSpecs: [],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    mocks.createMonitoringConfig.mockResolvedValue({
      ownerId: 42,
      repoId: '123',
      repoFullName: 'owner/repo',
      enabled: true,
      schedule: 'on_push',
      testSpecs: [],
      webhookSecret: 'secret',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    mocks.updateMonitoringConfig.mockResolvedValue({
      ownerId: 42,
      repoId: '123',
      repoFullName: 'owner/repo',
      enabled: false,
      schedule: 'on_push',
      testSpecs: [],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    mocks.deleteMonitoringConfig.mockResolvedValue(true);
    mocks.generateWebhookSecret.mockReturnValue('generated-secret');
  });

  it('returns 401 when listing configs without a session', async () => {
    mocks.getSession.mockResolvedValueOnce(null);

    const response = await listMonitoringConfigsRoute();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('returns only configs owned by the current user', async () => {
    const response = await listMonitoringConfigsRoute();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.configs).toHaveLength(1);
    expect(body.configs[0]).toMatchObject({
      ownerId: 42,
      repoId: '123',
    });
  });

  it('returns 403 when creating a config for a disallowed repository', async () => {
    mocks.getMonitoringConfig.mockResolvedValueOnce(null);
    mocks.isRepoAllowed.mockResolvedValueOnce(false);

    const response = await createMonitoringConfigRoute(
      new NextRequest('http://localhost/api/monitoring/configs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repoId: '123',
          repoFullName: 'owner/repo',
          schedule: 'on_push',
          testSpecs: [],
        }),
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Repository access is not authorized',
    });
    expect(mocks.createMonitoringConfig).not.toHaveBeenCalled();
  });

  it('returns 409 when another owner already configured the repository', async () => {
    mocks.getMonitoringConfig.mockResolvedValueOnce({
      ownerId: 99,
      repoId: '123',
      repoFullName: 'owner/repo',
      enabled: true,
      schedule: 'on_push',
      testSpecs: [],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const response = await createMonitoringConfigRoute(
      new NextRequest('http://localhost/api/monitoring/configs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repoId: '123',
          repoFullName: 'owner/repo',
          schedule: 'on_push',
          testSpecs: [],
        }),
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Monitoring is already configured for this repository',
    });
    expect(mocks.createMonitoringConfig).not.toHaveBeenCalled();
  });

  it('returns 404 for a config owned by another user', async () => {
    mocks.getMonitoringConfig.mockResolvedValueOnce({
      ownerId: 99,
      repoId: '123',
      repoFullName: 'owner/repo',
      enabled: true,
      schedule: 'on_push',
      testSpecs: [],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const response = await getMonitoringConfigRoute(
      new NextRequest('http://localhost/api/monitoring/configs/123'),
      { params: Promise.resolve({ repoId: '123' }) }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Config not found' });
  });

  it('returns 403 when updating a config for a disallowed repository', async () => {
    mocks.isRepoAllowed.mockResolvedValueOnce(false);

    const response = await updateMonitoringConfigRouteHandler(
      new NextRequest('http://localhost/api/monitoring/configs/123', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
      { params: Promise.resolve({ repoId: '123' }) }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Repository access is not authorized',
    });
    expect(mocks.updateMonitoringConfig).not.toHaveBeenCalled();
  });

  it('returns 403 when deleting a config for a disallowed repository', async () => {
    mocks.isRepoAllowed.mockResolvedValueOnce(false);

    const response = await deleteMonitoringConfigRouteHandler(
      new NextRequest('http://localhost/api/monitoring/configs/123', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ repoId: '123' }) }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Repository access is not authorized',
    });
    expect(mocks.deleteMonitoringConfig).not.toHaveBeenCalled();
  });
});
