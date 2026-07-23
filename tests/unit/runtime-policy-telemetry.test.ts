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
import { afterEach, describe, expect, it } from 'vitest';
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

  it('reports local, disabled, and undisclosed Weave states without blocking', async () => {
    await expect(new LocalTraceSink().send(event)).resolves.toBe('local');
    await expect(new DisabledTraceSink().send(event)).resolves.toBe('disabled');
    delete process.env.WANDB_API_KEY;
    await expect(new WeaveTraceSink('qagent-test', true).send(event)).resolves.toBe('disabled');
    process.env.WANDB_API_KEY = 'not-used';
    await expect(new WeaveTraceSink('qagent-test', false).send(event)).resolves.toBe('disabled');
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
  });
});

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
