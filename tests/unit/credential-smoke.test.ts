import { runCredentialBackedSmoke, type AdapterSmokeDependencies } from '@qagent/adapters';
import { describe, expect, it, vi } from 'vitest';

const checkedAt = new Date('2026-07-22T12:00:00.000Z');

function dependencies(): AdapterSmokeDependencies {
  return {
    now: () => checkedAt,
    fetch: vi.fn(async () => new Response(null, { status: 200 })),
    probeModel: vi.fn(async () => undefined),
    probeRedis: vi.fn(async () => undefined),
    probeWeave: vi.fn(async () => undefined),
  };
}

describe('credential-backed adapter smoke report', () => {
  it('labels absent integrations as unconfigured without making provider calls', async () => {
    const probes = dependencies();
    const report = await runCredentialBackedSmoke({}, probes);

    expect(report).toMatchObject({ schemaVersion: 1, checkedAt: checkedAt.toISOString() });
    expect(report.integrations).toHaveLength(10);
    expect(report.integrations.every((item) => item.status === 'unconfigured')).toBe(true);
    expect(probes.fetch).not.toHaveBeenCalled();
    expect(probes.probeModel).not.toHaveBeenCalled();
  });

  it('distinguishes healthy probes, explicit disclosure, and configured-only adapters', async () => {
    const probes = dependencies();
    const report = await runCredentialBackedSmoke(
      {
        OPENAI_API_KEY: 'openai-test',
        ANTHROPIC_API_KEY: 'anthropic-test',
        GOOGLE_API_KEY: 'google-test',
        QAGENT_OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
        QAGENT_OPENAI_MODEL: 'qwen-test',
        GITHUB_TOKEN: 'github-test',
        GITHUB_REPOSITORY: 'qagent/example',
        BROWSERBASE_API_KEY: 'browserbase-test',
        BROWSERBASE_PROJECT_ID: 'project-test',
        WANDB_API_KEY: 'weave-test',
        QAGENT_SMOKE_WEAVE_DISCLOSURE_ACCEPTED: 'true',
        REDIS_URL: 'redis://127.0.0.1:6379',
        VERCEL_TOKEN: 'vercel-test',
        VERCEL_PROJECT_ID: 'vercel-project',
        DAYTONA_API_KEY: 'daytona-test',
      },
      probes
    );

    expect(
      Object.fromEntries(report.integrations.map((item) => [item.provider, item.status]))
    ).toEqual({
      openai: 'healthy',
      anthropic: 'healthy',
      google: 'healthy',
      'openai-compatible': 'healthy',
      github: 'healthy',
      browserbase: 'healthy',
      weave: 'end-to-end-verified',
      redis: 'healthy',
      vercel: 'healthy',
      daytona: 'configured',
    });
    expect(probes.probeModel).toHaveBeenCalledTimes(4);
    expect(probes.fetch).toHaveBeenCalledTimes(3);
    expect(probes.probeRedis).toHaveBeenCalledOnce();
    expect(probes.probeWeave).toHaveBeenCalledOnce();
  });

  it('does not send Weave data until scheduled disclosure is explicit', async () => {
    const probes = dependencies();
    const report = await runCredentialBackedSmoke({ WANDB_API_KEY: 'configured' }, probes);

    expect(report.integrations.find((item) => item.provider === 'weave')).toMatchObject({
      status: 'configured',
      provenance: { source: 'provider', provider: 'weave' },
    });
    expect(probes.probeWeave).not.toHaveBeenCalled();
  });

  it('redacts provider failures and marks them as errors rather than zero values', async () => {
    const probes = dependencies();
    const secret = 'private-test-token';
    probes.fetch = vi.fn(async () => {
      throw new Error(`Authorization: Bearer ${secret}`);
    });
    const report = await runCredentialBackedSmoke(
      { GITHUB_TOKEN: secret, GITHUB_REPOSITORY: 'qagent/example' },
      probes
    );
    const github = report.integrations.find((item) => item.provider === 'github');

    expect(github).toMatchObject({ status: 'error' });
    expect(github?.detail).toContain('[REDACTED]');
    expect(github?.detail).not.toContain(secret);
  });
});
