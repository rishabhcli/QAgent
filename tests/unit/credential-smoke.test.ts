import { runCredentialBackedSmoke, type AdapterSmokeDependencies } from '@qagent/adapters';
import { describe, expect, it, vi } from 'vitest';

const checkedAt = new Date('2026-07-22T12:00:00.000Z');

function dependencies(): AdapterSmokeDependencies {
  return {
    now: () => checkedAt,
    fetch: vi.fn(async () => new Response(null, { status: 200 })),
    probeModel: vi.fn(async () => undefined),
    probeGitHub: vi.fn(async (_token, _repository, pullNumber) => ({
      repository: {
        capturedAt: checkedAt.toISOString(),
        identity: { login: 'qagent-smoke' },
        repository: {
          fullName: 'qagent/example',
          defaultBranch: 'main',
          archived: false,
          disabled: false,
        },
        permissions: {
          role: 'admin',
          canPull: true,
          canPush: true,
          canAdminister: true,
          pullRequests: 'write',
        },
        rules: { active: ['required_status_checks'], classicProtection: 'protected' },
        checks: { checkRuns: 2, combinedStatus: 'success', statusContexts: 1 },
        merge: {
          allowAutoMerge: true,
          allowedMethods: ['squash'],
          mergeQueueRequired: false,
        },
      },
      pullRequest:
        pullNumber === null
          ? null
          : {
              capturedAt: checkedAt.toISOString(),
              repositoryFullName: 'qagent/example',
              number: pullNumber,
              url: `https://github.com/qagent/example/pull/${pullNumber}`,
              providerState: 'OPEN',
              finalState: 'open',
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
              mergeEligible: true,
              reviewDecision: 'APPROVED',
              checksState: 'SUCCESS',
              mergeQueueState: null,
              autoMergeEnabled: false,
              mergeCommitSha: null,
              detail: 'GitHub reports the pull request remains open and mergeable.',
            },
    })),
    probeBrowserbase: vi.fn(async () => undefined),
    probeRedis: vi.fn(async () => undefined),
    probeWeave: vi.fn(async () => 'qagent/smoke'),
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
        QAGENT_SMOKE_GITHUB_PR_NUMBER: '42',
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
    expect(probes.probeGitHub).toHaveBeenCalledOnce();
    expect(probes.probeGitHub).toHaveBeenCalledWith(
      'github-test',
      { owner: 'qagent', repo: 'example' },
      42,
      expect.any(AbortSignal)
    );
    expect(probes.probeBrowserbase).toHaveBeenCalledOnce();
    expect(probes.fetch).toHaveBeenCalledOnce();
    expect(probes.probeRedis).toHaveBeenCalledOnce();
    expect(probes.probeWeave).toHaveBeenCalledOnce();
    expect(report.integrations.find((item) => item.provider === 'github')?.evidence).toEqual([
      {
        sourceUrl: 'https://github.com/qagent/example',
        capturedAt: checkedAt.toISOString(),
        kind: 'provider-probe',
        authorization: 'verified',
        summary: expect.stringContaining('Authenticated as qagent-smoke'),
      },
    ]);
    expect(report.integrations.find((item) => item.provider === 'browserbase')?.evidence).toEqual([
      {
        sourceUrl: 'https://api.browserbase.com/v1/projects/project-test',
        capturedAt: checkedAt.toISOString(),
        kind: 'provider-probe',
        authorization: 'verified',
        summary: expect.stringContaining('Authenticated Browserbase project'),
      },
    ]);
    expect(report.integrations.find((item) => item.provider === 'weave')?.evidence).toEqual([
      {
        sourceUrl: 'https://wandb.ai/qagent/smoke/weave',
        capturedAt: checkedAt.toISOString(),
        kind: 'end-to-end-workflow',
        authorization: 'verified',
        summary: expect.stringContaining('redacted operation'),
      },
    ]);
  });

  it('does not send Weave data until scheduled disclosure is explicit', async () => {
    const probes = dependencies();
    const report = await runCredentialBackedSmoke({ WANDB_API_KEY: 'configured' }, probes);

    expect(report.integrations.find((item) => item.provider === 'weave')).toMatchObject({
      status: 'configured',
      provenance: { source: 'provider', provider: 'weave' },
    });
    expect(report.integrations.find((item) => item.provider === 'weave')?.evidence).toBeUndefined();
    expect(probes.probeWeave).not.toHaveBeenCalled();
  });

  it('does not call a repository-only GitHub probe healthy without final-state inspection', async () => {
    const probes = dependencies();
    const report = await runCredentialBackedSmoke(
      {
        GITHUB_TOKEN: 'github-test',
        GITHUB_REPOSITORY: 'qagent/example',
      },
      probes
    );
    const github = report.integrations.find((item) => item.provider === 'github');

    expect(github).toMatchObject({
      status: 'configured',
      detail: expect.stringContaining('final-state inspection is required for healthy status'),
    });
    expect(probes.probeGitHub).toHaveBeenCalledWith(
      'github-test',
      { owner: 'qagent', repo: 'example' },
      null,
      expect.any(AbortSignal)
    );
  });

  it('fails a configured GitHub PR probe when final-state inspection is absent', async () => {
    const probes = dependencies();
    const repositoryProbe = await probes.probeGitHub(
      'github-test',
      { owner: 'qagent', repo: 'example' },
      null,
      AbortSignal.timeout(1_000)
    );
    probes.probeGitHub = vi.fn(async () => ({ ...repositoryProbe, pullRequest: null }));
    const report = await runCredentialBackedSmoke(
      {
        GITHUB_TOKEN: 'github-test',
        GITHUB_REPOSITORY: 'qagent/example',
        QAGENT_SMOKE_GITHUB_PR_NUMBER: '42',
      },
      probes
    );

    expect(report.integrations.find((item) => item.provider === 'github')).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('final-state inspection did not complete'),
    });
  });

  it('redacts provider failures and marks them as errors rather than zero values', async () => {
    const probes = dependencies();
    const secret = 'private-test-token';
    probes.probeGitHub = vi.fn(async () => {
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
    expect(github?.evidence).toBeUndefined();
  });
});
