import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  createRun: vi.fn(),
  getAllRunsAsync: vi.fn(),
  getRunAsync: vi.fn(),
  cancelRun: vi.fn(),
  deleteRun: vi.fn(),
  updateRunStatus: vi.fn(),
  cancelQueuedRunByActualRunId: vi.fn(),
  enqueueRun: vi.fn(),
  isRedisAvailable: vi.fn(),
  scheduleQueueProcessing: vi.fn(),
  executeAdHocRun: vi.fn(),
  emitRunError: vi.fn(),
  subscribe: vi.fn(),
  getBufferedEvents: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  getSession: mocks.getSession,
}));

vi.mock('@/lib/dashboard/run-store', () => ({
  createRun: mocks.createRun,
  getAllRunsAsync: mocks.getAllRunsAsync,
  getRunAsync: mocks.getRunAsync,
  cancelRun: mocks.cancelRun,
  deleteRun: mocks.deleteRun,
  updateRunStatus: mocks.updateRunStatus,
}));

vi.mock('@/lib/redis/queue', () => ({
  cancelQueuedRunByActualRunId: mocks.cancelQueuedRunByActualRunId,
  enqueueRun: mocks.enqueueRun,
}));

vi.mock('@/lib/redis/client', () => ({
  isRedisAvailable: mocks.isRedisAvailable,
}));

vi.mock('@/lib/queue/dispatcher', () => ({
  scheduleQueueProcessing: mocks.scheduleQueueProcessing,
}));

vi.mock('@/lib/queue/ad-hoc-runner', () => ({
  executeAdHocRun: mocks.executeAdHocRun,
}));

vi.mock('@/lib/dashboard/sse-emitter', () => ({
  emitRunError: mocks.emitRunError,
  sseEmitter: {
    subscribe: mocks.subscribe,
    getBufferedEvents: mocks.getBufferedEvents,
  },
}));

vi.mock('@/lib/auth/repo-access', () => ({
  isRepoAllowed: vi.fn(),
}));

import { GET as listRunsRoute, POST as createRunRoute } from '@/app/api/runs/route';
import { GET as getRunRoute, DELETE as deleteRunRoute } from '@/app/api/runs/[runId]/route';
import { GET as getRunStreamRoute } from '@/app/api/runs/[runId]/stream/route';
import { isRepoAllowed } from '@/lib/auth/repo-access';

describe('Run route authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      user: { id: 42, login: 'owner' },
      accessToken: 'token',
      repos: [],
      selectedRepoIds: [],
    });
    mocks.createRun.mockReturnValue({
      id: 'run-created',
      ownerId: 42,
      repoId: '123',
      repoName: 'owner/repo',
      status: 'queued',
      currentAgent: 'orchestrator',
      iteration: 0,
      maxIterations: 5,
      testSpecs: [],
      patches: [],
      testResults: [],
      startedAt: new Date('2026-01-03T00:00:00.000Z'),
    });
    mocks.getAllRunsAsync.mockResolvedValue([
      {
        id: 'run-owner',
        ownerId: 42,
        repoId: '123',
        repoName: 'owner/repo',
        status: 'completed',
        currentAgent: null,
        iteration: 2,
        maxIterations: 5,
        testSpecs: [{}],
        patches: [{}],
        testResults: [{ passed: true }],
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        completedAt: new Date('2026-01-01T00:10:00.000Z'),
      },
      {
        id: 'run-other',
        ownerId: 99,
        repoId: '999',
        repoName: 'other/repo',
        status: 'failed',
        currentAgent: null,
        iteration: 1,
        maxIterations: 5,
        testSpecs: [{}],
        patches: [],
        testResults: [{ passed: false }],
        startedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]);
    mocks.getRunAsync.mockResolvedValue({
      id: 'run-1',
      ownerId: 42,
      repoId: '123',
      repoName: 'owner/repo',
      status: 'completed',
      currentAgent: null,
      iteration: 1,
      maxIterations: 5,
      testSpecs: [],
      patches: [],
      testResults: [],
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    mocks.cancelRun.mockReturnValue(false);
    mocks.cancelQueuedRunByActualRunId.mockResolvedValue(false);
    mocks.deleteRun.mockReturnValue(true);
    mocks.enqueueRun.mockResolvedValue({
      id: 'queue-1',
    });
    mocks.isRedisAvailable.mockResolvedValue(true);
    (isRepoAllowed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    mocks.subscribe.mockReturnValue(() => {});
    mocks.getBufferedEvents.mockReturnValue([]);
  });

  it('returns 401 for the runs list when the user is not authenticated', async () => {
    mocks.getSession.mockResolvedValueOnce(null);

    const response = await listRunsRoute(new NextRequest('http://localhost/api/runs'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('returns only runs owned by the current user in the runs list stats', async () => {
    const response = await listRunsRoute(new NextRequest('http://localhost/api/runs'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      id: 'run-owner',
      repoId: '123',
      repoName: 'owner/repo',
    });
    expect(body.stats).toEqual({
      totalRuns: 1,
      passRate: 100,
      patchesApplied: 1,
      avgIterations: 2,
    });
  });

  it('blocks creating a cloud run for a repository outside the allowed selection', async () => {
    (isRepoAllowed as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    const response = await createRunRoute(
      new NextRequest('http://localhost/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repoId: '999',
          repoName: 'other/repo',
          cloudMode: true,
          testSpecs: [],
        }),
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Repository access is not authorized',
    });
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  it('creates a run for an allowed repository', async () => {
    mocks.getSession.mockResolvedValueOnce({
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

    const response = await createRunRoute(
      new NextRequest('http://localhost/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repoId: '123',
          repoName: 'owner/repo',
          cloudMode: true,
          testSpecs: [],
        }),
      })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      queued: true,
      queueId: 'queue-1',
      run: expect.objectContaining({
        id: 'run-created',
        ownerId: 42,
      }),
    });
    expect(mocks.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 42,
        repoId: '123',
        repoName: 'owner/repo',
      })
    );
    expect(mocks.scheduleQueueProcessing).toHaveBeenCalledTimes(1);
  });

  it('returns 401 for run details when the user is not authenticated', async () => {
    mocks.getSession.mockResolvedValueOnce(null);

    const response = await getRunRoute(new NextRequest('http://localhost/api/runs/run-1'), {
      params: Promise.resolve({ runId: 'run-1' }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('returns 404 when a run belongs to another user', async () => {
    mocks.getRunAsync.mockResolvedValueOnce({
      id: 'run-1',
      ownerId: 99,
    });

    const response = await getRunRoute(new NextRequest('http://localhost/api/runs/run-1'), {
      params: Promise.resolve({ runId: 'run-1' }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Run not found' });
  });

  it('returns run details for the owner', async () => {
    const response = await getRunRoute(new NextRequest('http://localhost/api/runs/run-1'), {
      params: Promise.resolve({ runId: 'run-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      run: expect.objectContaining({ id: 'run-1', ownerId: 42 }),
    });
  });

  it('prevents deleting a run owned by another user', async () => {
    mocks.getRunAsync.mockResolvedValueOnce({
      id: 'run-1',
      ownerId: 99,
    });

    const response = await deleteRunRoute(
      new NextRequest('http://localhost/api/runs/run-1', { method: 'DELETE' }),
      { params: Promise.resolve({ runId: 'run-1' }) }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Run not found' });
    expect(mocks.deleteRun).not.toHaveBeenCalled();
  });

  it('allows deleting a completed run owned by the caller', async () => {
    const response = await deleteRunRoute(
      new NextRequest('http://localhost/api/runs/run-1', { method: 'DELETE' }),
      { params: Promise.resolve({ runId: 'run-1' }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ message: 'Run deleted' });
    expect(mocks.deleteRun).toHaveBeenCalledWith('run-1');
  });

  it('returns 401 for the run stream when the user is not authenticated', async () => {
    mocks.getSession.mockResolvedValueOnce(null);

    const response = await getRunStreamRoute(
      new NextRequest('http://localhost/api/runs/run-1/stream'),
      { params: Promise.resolve({ runId: 'run-1' }) }
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe('Unauthorized');
  });

  it('returns 404 for the run stream when a run belongs to another user', async () => {
    mocks.getRunAsync.mockResolvedValueOnce({
      id: 'run-1',
      ownerId: 99,
    });

    const response = await getRunStreamRoute(
      new NextRequest('http://localhost/api/runs/run-1/stream'),
      { params: Promise.resolve({ runId: 'run-1' }) }
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe('Run not found');
  });
});
