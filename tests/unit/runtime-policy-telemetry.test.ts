import { join } from 'node:path';
import {
  DisabledTraceSink,
  LocalTraceSink,
  WeaveTraceSink,
  localIntegrationStatus,
  redactForTelemetry,
} from '@qagent/adapters';
import type { RunEvent } from '@qagent/contracts';
import { createLocalRuntime, evaluatePublicationPolicy, strictEnvFlag } from '@qagent/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { temporaryDirectory } from '../helpers.js';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe('strict environment flags', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['YES', true],
    ['on', true],
    ['0', false],
    ['false', false],
    ['NO', false],
    ['off', false],
  ])('parses %s as %s', (value, expected) => {
    process.env.QAGENT_TEST_FLAG = value;
    expect(strictEnvFlag('QAGENT_TEST_FLAG', !expected)).toBe(expected);
  });

  it('uses a fallback only when absent and rejects ambiguous strings', () => {
    delete process.env.QAGENT_TEST_FLAG;
    expect(strictEnvFlag('QAGENT_TEST_FLAG', true)).toBe(true);
    process.env.QAGENT_TEST_FLAG = 'truthy';
    expect(() => strictEnvFlag('QAGENT_TEST_FLAG', false)).toThrow(/must be true or false/);
  });
});

describe('publication policy', () => {
  it('blocks dirty checkout publication', () => {
    expect(
      evaluatePublicationPolicy({
        originalCheckoutDirty: true,
        patch: { files: ['src/app.ts'], highRisk: false },
        configuredAutoMerge: true,
      })
    ).toEqual({
      mayPublish: false,
      mayAutoMerge: false,
      reason:
        'The source checkout is dirty; the verified worktree is preserved but publication is blocked.',
    });
  });

  it('allows a high-risk PR but not auto-merge', () => {
    expect(
      evaluatePublicationPolicy({
        originalCheckoutDirty: false,
        patch: { files: ['.github/workflows/ci.yml'], highRisk: true },
        configuredAutoMerge: true,
      })
    ).toMatchObject({ mayPublish: true, mayAutoMerge: false, reason: expect.any(String) });
  });

  it('honors normal auto-merge configuration', () => {
    expect(
      evaluatePublicationPolicy({
        originalCheckoutDirty: false,
        patch: { files: ['src/app.ts'], highRisk: false },
        configuredAutoMerge: true,
      })
    ).toEqual({ mayPublish: true, mayAutoMerge: true, reason: null });
    expect(
      evaluatePublicationPolicy({
        originalCheckoutDirty: false,
        patch: { files: ['src/app.ts'], highRisk: false },
        configuredAutoMerge: false,
      }).mayAutoMerge
    ).toBe(false);
  });
});

describe('telemetry and integration provenance', () => {
  it('requires HTTPS for remote Weave endpoints and permits loopback HTTP', () => {
    expect(
      () =>
        new WeaveTraceSink('qagent-team/qagent', true, {
          apiKey: 'wandb-secret-value',
          wandbBaseUrl: 'http://wandb.example.test',
        })
    ).toThrow('credential-free HTTP(S) URL');
    expect(
      () =>
        new WeaveTraceSink('qagent-team/qagent', true, {
          apiKey: 'wandb-secret-value',
          traceBaseUrl: 'https://user:password@trace.example.test',
        })
    ).toThrow('credential-free HTTP(S) URL');
    expect(
      () =>
        new WeaveTraceSink('qagent-team/qagent', true, {
          apiKey: 'wandb-secret-value',
          wandbBaseUrl: 'http://127.0.0.1:8080',
          traceBaseUrl: 'http://localhost:8081',
        })
    ).not.toThrow();
  });

  const event = {
    schemaVersion: 1,
    id: 'fa85c98c-a170-4ec4-a6f2-e41647562111',
    runId: 'fa85c98c-a170-4ec4-a6f2-e41647562112',
    sequence: 1,
    stage: 'preflight',
    kind: 'run.created',
    occurredAt: '2026-07-22T12:00:00.000Z',
    provenance: { source: 'local', capturedAt: '2026-07-22T12:00:00.000Z' },
    artifactIds: [],
    payload: { message: 'created' },
  } satisfies RunEvent;

  it('redacts nested keys and secret-like values before delivery', () => {
    expect(
      redactForTelemetry({
        authorization: 'Bearer top-secret-token',
        nested: [{ apiKey: 'sk-abcdefghijklmnop' }, 'ghp_abcdefghijklmnop'],
        safe: 'visible',
        count: 2,
      })
    ).toEqual({
      authorization: '[REDACTED]',
      nested: [{ apiKey: '[REDACTED]' }, '[REDACTED]'],
      safe: 'visible',
      count: 2,
    });
  });

  it('preserves secret metadata scalars while redacting credential string content', () => {
    expect(
      redactForTelemetry({
        requirements: [
          {
            id: 'github-token',
            label: 'Access token',
            state: 'configured',
            secret: true,
          },
        ],
        credentials: {
          value: 'opaque-value-without-a-secret-prefix',
          nested: ['another-opaque-value'],
          configured: true,
          attempts: 2,
        },
        token: false,
        password: 0,
        cookie: null,
      })
    ).toEqual({
      requirements: [
        {
          id: 'github-token',
          label: 'Access token',
          state: 'configured',
          secret: true,
        },
      ],
      credentials: {
        value: '[REDACTED]',
        nested: ['[REDACTED]'],
        configured: true,
        attempts: 2,
      },
      token: false,
      password: 0,
      cookie: null,
    });
  });

  it('reports local, disabled, and undisclosed Weave states without blocking', async () => {
    await expect(new LocalTraceSink().send(event)).resolves.toBe('local');
    await expect(new LocalTraceSink().flush()).resolves.toBe('local');
    await expect(new DisabledTraceSink().send(event)).resolves.toBe('disabled');
    await expect(new DisabledTraceSink().flush()).resolves.toBe('disabled');
    delete process.env.WANDB_API_KEY;
    await expect(new WeaveTraceSink('qagent-test', true).send(event)).resolves.toBe('disabled');
    process.env.WANDB_API_KEY = 'not-used';
    await expect(new WeaveTraceSink('qagent-test', false).send(event)).resolves.toBe('disabled');
  });

  it('probes the configured Weave project and flushes a redacted acknowledged batch', async () => {
    const requests: Array<{ path: string; body: unknown; authorization: string | null }> = [];
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({
        path,
        body,
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      if (path === '/service/projects_info') {
        return jsonResponse([
          { external_project_id: 'qagent-team/qagent', internal_project_id: 'project-1' },
        ]);
      }
      if (path === '/call/upsert_batch') {
        const batch = body.batch as Array<{
          mode: string;
          req: { start?: { id: string; trace_id: string } };
        }>;
        return jsonResponse({
          res: batch.map((item) =>
            item.mode === 'start'
              ? { id: item.req.start?.id, trace_id: item.req.start?.trace_id }
              : {}
          ),
        });
      }
      throw new Error(`Unexpected provider path ${path}`);
    }) as unknown as typeof globalThis.fetch;
    const sink = new WeaveTraceSink('qagent-team/qagent', true, {
      apiKey: 'wandb-secret-value',
      fetch: providerFetch,
      timeoutMs: 1_000,
    });
    const secretEvent = {
      ...event,
      payload: {
        message:
          'Authorization: Bearer sk-abcdefghijklmnop api_key=another-secret-value; provider echoed wandb-secret-value exactly',
      },
    } satisfies RunEvent;

    await expect(sink.send(secretEvent)).resolves.toBe('synced');
    expect(sink).toMatchObject({
      state: 'synced',
      lastError: null,
      resolvedProject: 'qagent-team/qagent',
      evidenceSourceUrl: 'https://wandb.ai/qagent-team/qagent/weave',
      queuedCount: 0,
    });
    expect(requests.map((request) => request.path)).toEqual([
      '/service/projects_info',
      '/call/upsert_batch',
    ]);
    expect(requests.every((request) => request.authorization?.startsWith('Basic '))).toBe(true);

    const delivered = JSON.stringify(requests.at(-1)?.body);
    expect(delivered).toContain('[REDACTED]');
    expect(delivered).not.toContain('sk-abcdefghijklmnop');
    expect(delivered).not.toContain('another-secret-value');
    expect(delivered).not.toContain('wandb-secret-value');
  });

  it('resolves the default Weave entity and retains a failed batch for an explicit retry', async () => {
    let failBatch = true;
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === '/graphql') {
        return jsonResponse({
          data: { viewer: { defaultEntity: { name: 'default-team' } } },
        });
      }
      if (path === '/service/projects_info') {
        return jsonResponse([
          { external_project_id: 'default-team/qagent', internal_project_id: 'project-2' },
        ]);
      }
      if (path === '/call/upsert_batch' && failBatch) {
        return jsonResponse({ detail: 'temporarily unavailable' }, 503);
      }
      if (path === '/call/upsert_batch') {
        const batch = body.batch as Array<{
          mode: string;
          req: { start?: { id: string; trace_id: string } };
        }>;
        return jsonResponse({
          res: batch.map((item) =>
            item.mode === 'start'
              ? { id: item.req.start?.id, trace_id: item.req.start?.trace_id }
              : {}
          ),
        });
      }
      throw new Error(`Unexpected provider path ${path}`);
    }) as unknown as typeof globalThis.fetch;
    const sink = new WeaveTraceSink('qagent', true, {
      apiKey: 'wandb-secret-value',
      fetch: providerFetch,
      timeoutMs: 1_000,
    });

    await expect(sink.send(event)).resolves.toBe('failed');
    expect(sink.queuedCount).toBe(1);
    expect(sink.lastError).toBe('Weave /call/upsert_batch request failed with HTTP 503');
    expect(sink.lastError).not.toContain('wandb-secret-value');

    failBatch = false;
    await expect(sink.flush()).resolves.toBe('synced');
    expect(sink.queuedCount).toBe(0);
    expect(sink.resolvedProject).toBe('default-team/qagent');
  });

  it('honors Weave cancellation without rejecting or losing the queued event', async () => {
    const providerFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    ) as unknown as typeof globalThis.fetch;
    const sink = new WeaveTraceSink('qagent-team/qagent', true, {
      apiKey: 'wandb-secret-value',
      fetch: providerFetch,
      timeoutMs: 1_000,
    });
    const controller = new AbortController();
    const delivery = sink.send(event, controller.signal);
    controller.abort();

    await expect(delivery).resolves.toBe('failed');
    expect(sink.lastError).toBe('Weave delivery was cancelled');
    expect(sink.queuedCount).toBe(1);
  });

  it('distinguishes configured and unconfigured adapters with timestamps', () => {
    const statuses = localIntegrationStatus({
      GITHUB_TOKEN: 'configured',
      BROWSERBASE_API_KEY: 'one half',
    });
    expect(statuses.find((item) => item.provider === 'github')?.status).toBe('configured');
    expect(statuses.find((item) => item.provider === 'browserbase')).toMatchObject({
      status: 'unconfigured',
      provenance: { source: 'local' },
    });
    expect(statuses.find((item) => item.provider === 'browserbase')?.detail).toContain(
      'BROWSERBASE_PROJECT_ID'
    );
    expect(statuses.find((item) => item.provider === 'browserbase')?.requirements).toEqual([
      {
        id: 'browserbase-api-key',
        label: 'API key',
        state: 'configured',
        secret: true,
      },
      {
        id: 'browserbase-project-id',
        label: 'Project ID',
        state: 'missing',
        secret: false,
      },
    ]);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('local runtime', () => {
  it('persists project records beneath the requested home', async () => {
    const home = await temporaryDirectory('qagent-runtime-');
    process.env.QAGENT_WEAVE_ENABLED = 'false';
    const runtime = createLocalRuntime({ home });
    const project = runtime.storage.createProject({ name: 'Example', path: join(home, 'repo') });
    runtime.close();

    const reopened = createLocalRuntime({ home });
    expect(reopened.storage.getProject(project.id)?.name).toBe('Example');
    reopened.close();
  });
});
