import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/notifications/send/route';
import { deviceTokens } from '@/lib/notifications/push';

const mockFetch = vi.fn();

describe('POST /api/notifications/send', () => {
  const originalInternalKey = process.env.INTERNAL_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    deviceTokens.clear();
    process.env.INTERNAL_API_KEY = 'test-internal-key';
    global.fetch = mockFetch as typeof fetch;
  });

  afterAll(() => {
    process.env.INTERNAL_API_KEY = originalInternalKey;
  });

  it('rejects arbitrary bearer tokens', async () => {
    const request = new NextRequest('http://localhost/api/notifications/send', {
      method: 'POST',
      headers: {
        authorization: 'Bearer definitely-not-the-internal-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        userId: 1,
        title: 'Test notification',
        body: 'This should be rejected',
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 503 when the internal API key is not configured', async () => {
    delete process.env.INTERNAL_API_KEY;

    const request = new NextRequest('http://localhost/api/notifications/send', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-internal-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        userId: 1,
        title: 'Test notification',
        body: 'Missing configuration',
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Notification delivery is not configured',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends notifications when the internal API key matches', async () => {
    deviceTokens.set('ExponentPushToken[abc123]', {
      token: 'ExponentPushToken[abc123]',
      platform: 'ios',
      userId: 42,
      registeredAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'ticket-1', status: 'ok' }],
      }),
    });

    const request = new NextRequest('http://localhost/api/notifications/send', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-internal-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        userId: 42,
        title: 'Run completed',
        body: 'A run finished successfully',
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      sent: 1,
      tickets: [{ id: 'ticket-1', status: 'ok' }],
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      expect.objectContaining({
        method: 'POST',
      })
    );
  });
});
