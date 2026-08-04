import { randomUUID } from 'node:crypto';
import {
  IntegrationSchema,
  type Integration,
  type QAgentConfig,
  type RunEvent,
} from '@qagent/contracts';
import { z } from 'zod';
import { probeBrowserbaseProject } from './browser.js';
import { GitRepository } from './git.js';
import {
  GitHubPublisher,
  type GitHubPullRequestInspection,
  type GitHubRepositoryProbe,
  type GitHubRepositoryRef,
} from './github.js';
import { createModelProvider } from './model.js';
import { redactForTelemetry, WeaveTraceSink } from './telemetry.js';

export interface AdapterSmokeReport {
  schemaVersion: 1;
  checkedAt: string;
  integrations: Integration[];
}

export interface AdapterSmokeDependencies {
  now(): Date;
  fetch: typeof globalThis.fetch;
  probeModel(
    config: QAgentConfig['model'],
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal
  ): Promise<void>;
  probeGitHub(
    token: string,
    repository: GitHubRepositoryRef,
    pullNumber: number | null,
    signal: AbortSignal
  ): Promise<{
    repository: GitHubRepositoryProbe;
    pullRequest: GitHubPullRequestInspection | null;
  }>;
  probeBrowserbase(apiKey: string, projectId: string, signal: AbortSignal): Promise<void>;
  probeRedis(url: string): Promise<void>;
  probeWeave(apiKey: string, project: string, signal: AbortSignal): Promise<string>;
}

const defaultDependencies: AdapterSmokeDependencies = {
  now: () => new Date(),
  fetch: globalThis.fetch,
  probeModel: async (config, environment, signal) => {
    const provider = createModelProvider(config, {
      openai: environment.OPENAI_API_KEY,
      anthropic: environment.ANTHROPIC_API_KEY,
      google: environment.GOOGLE_API_KEY,
      openaiCompatible: environment.OPENAI_API_KEY,
    });
    await provider.complete({
      purpose: 'other',
      system: 'Return the requested JSON and nothing else.',
      prompt: 'Return {"ok":true}.',
      schemaName: 'qagent_adapter_smoke',
      schema: z.object({ ok: z.literal(true) }),
      signal,
    });
  },
  probeGitHub: async (token, repository, pullNumber, signal) => {
    const publisher = new GitHubPublisher(token, new GitRepository());
    const probe = await publisher.probeRepository(repository, undefined, signal);
    const pullRequest =
      pullNumber === null
        ? null
        : await publisher.inspectPullRequest(repository, pullNumber, signal);
    return { repository: probe, pullRequest };
  },
  probeBrowserbase: async (apiKey, projectId, signal) => {
    await probeBrowserbaseProject(apiKey, projectId, signal);
  },
  probeRedis: async (url) => {
    const { createClient } = await import('redis');
    const client = createClient({
      url,
      socket: { connectTimeout: 15_000, reconnectStrategy: false },
    });
    try {
      await client.connect();
      await client.ping();
    } finally {
      if (client.isOpen) await client.quit();
    }
  },
  probeWeave: async (apiKey, project, signal) => {
    const timestamp = new Date().toISOString();
    const event = {
      schemaVersion: 1,
      id: randomUUID(),
      runId: randomUUID(),
      sequence: 1,
      stage: 'preflight',
      kind: 'run.created',
      occurredAt: timestamp,
      provenance: { source: 'system', capturedAt: timestamp },
      artifactIds: [],
      payload: { message: 'Credential-backed adapter smoke' },
    } satisfies RunEvent;
    const sink = new WeaveTraceSink(project, true, { apiKey });
    const state = await sink.send(event, signal);
    if (state !== 'synced' || sink.queuedCount !== 0 || !sink.resolvedProject) {
      throw new Error(sink.lastError ?? `Weave trace delivery ended in ${state} state`);
    }
    return sink.resolvedProject;
  },
};

export async function runCredentialBackedSmoke(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<AdapterSmokeDependencies> = {}
): Promise<AdapterSmokeReport> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const checkedAt = dependencies.now().toISOString();
  const integrations: Integration[] = [];

  for (const definition of [
    {
      provider: 'openai',
      credential: 'OPENAI_API_KEY',
      model: environment.QAGENT_SMOKE_OPENAI_MODEL ?? 'gpt-5.6-luna',
    },
    {
      provider: 'anthropic',
      credential: 'ANTHROPIC_API_KEY',
      model: environment.QAGENT_SMOKE_ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
    },
    {
      provider: 'google',
      credential: 'GOOGLE_API_KEY',
      model: environment.QAGENT_SMOKE_GOOGLE_MODEL ?? 'gemini-3.5-flash-lite',
    },
  ] as const) {
    if (!environment[definition.credential]) {
      integrations.push(
        integration(
          definition.provider,
          'unconfigured',
          `${definition.credential} is not configured`,
          checkedAt
        )
      );
      continue;
    }
    integrations.push(
      await liveProbe(
        definition.provider,
        `Structured output validated with ${definition.model}`,
        checkedAt,
        environment,
        async () =>
          dependencies.probeModel(
            { provider: definition.provider, model: definition.model },
            environment,
            AbortSignal.timeout(60_000)
          )
      )
    );
  }

  const compatibleUrl = environment.QAGENT_OPENAI_BASE_URL;
  const compatibleModel = environment.QAGENT_OPENAI_MODEL;
  if (!compatibleUrl || !compatibleModel) {
    integrations.push(
      integration(
        'openai-compatible',
        'unconfigured',
        'QAGENT_OPENAI_BASE_URL and QAGENT_OPENAI_MODEL are required for a live probe',
        checkedAt
      )
    );
  } else {
    integrations.push(
      await liveProbe(
        'openai-compatible',
        `Structured output validated with ${compatibleModel}`,
        checkedAt,
        environment,
        async () =>
          dependencies.probeModel(
            { provider: 'openai-compatible', model: compatibleModel, baseUrl: compatibleUrl },
            environment,
            AbortSignal.timeout(60_000)
          )
      )
    );
  }

  const githubToken = environment.GITHUB_TOKEN;
  const githubRepository = environment.GITHUB_REPOSITORY;
  if (!githubToken || !githubRepository) {
    integrations.push(
      integration(
        'github',
        'unconfigured',
        `Missing ${[!githubToken && 'GITHUB_TOKEN', !githubRepository && 'GITHUB_REPOSITORY']
          .filter(Boolean)
          .join(', ')}`,
        checkedAt
      )
    );
  } else {
    let detail = 'GitHub repository capability probe did not complete';
    let sourceUrl: string | undefined;
    const pullRequestConfigured = Boolean(environment.QAGENT_SMOKE_GITHUB_PR_NUMBER);
    integrations.push(
      await liveProbe(
        'github',
        () => detail,
        checkedAt,
        environment,
        async () => {
          const repository = parseRepository(githubRepository);
          sourceUrl = `https://github.com/${repository.owner}/${repository.repo}`;
          const result = await dependencies.probeGitHub(
            githubToken,
            repository,
            optionalPositiveInteger(
              environment.QAGENT_SMOKE_GITHUB_PR_NUMBER,
              'QAGENT_SMOKE_GITHUB_PR_NUMBER'
            ),
            AbortSignal.timeout(30_000)
          );
          const probe = result.repository;
          assertGitHubPublicationCapabilities(probe);
          if (pullRequestConfigured && !result.pullRequest) {
            throw new Error('GitHub pull-request final-state inspection did not complete');
          }
          detail = [
            `Authenticated as ${probe.identity.login}`,
            `${probe.repository.fullName} role ${probe.permissions.role}`,
            'push and pull-request write verified',
            `${probe.rules.active.length} active branch rules`,
            `classic protection ${probe.rules.classicProtection}`,
            `${probe.checks.checkRuns} check runs`,
            `${probe.checks.statusContexts} status contexts (${probe.checks.combinedStatus})`,
            `merge queue ${probe.merge.mergeQueueRequired ? 'required' : 'not required'}`,
            result.pullRequest
              ? `PR #${result.pullRequest.number} ${result.pullRequest.finalState}; eligibility ${
                  result.pullRequest.mergeEligible ? 'eligible' : 'not eligible'
                }; reviews ${result.pullRequest.reviewDecision ?? 'unavailable'}; checks ${
                  result.pullRequest.checksState ?? 'unavailable'
                }; queue ${result.pullRequest.mergeQueueState ?? 'not queued'}`
              : 'repository capabilities verified; pull-request final-state inspection is required for healthy status',
          ].join('; ');
        },
        pullRequestConfigured ? 'healthy' : 'configured',
        () => sourceUrl
      )
    );
  }

  const browserbaseKey = environment.BROWSERBASE_API_KEY;
  const browserbaseProject = environment.BROWSERBASE_PROJECT_ID;
  if (!browserbaseKey || !browserbaseProject) {
    integrations.push(
      integration(
        'browserbase',
        'unconfigured',
        `Missing ${[
          !browserbaseKey && 'BROWSERBASE_API_KEY',
          !browserbaseProject && 'BROWSERBASE_PROJECT_ID',
        ]
          .filter(Boolean)
          .join(', ')}`,
        checkedAt
      )
    );
  } else {
    integrations.push(
      await liveProbe(
        'browserbase',
        `Authenticated Browserbase project ${browserbaseProject} was schema-validated`,
        checkedAt,
        environment,
        async () =>
          dependencies.probeBrowserbase(
            browserbaseKey,
            browserbaseProject,
            AbortSignal.timeout(30_000)
          ),
        'healthy',
        () => `https://api.browserbase.com/v1/projects/${encodeURIComponent(browserbaseProject)}`
      )
    );
  }

  const weaveKey = environment.WANDB_API_KEY;
  if (!weaveKey) {
    integrations.push(
      integration('weave', 'unconfigured', 'WANDB_API_KEY is not configured', checkedAt)
    );
  } else if (!truthy(environment.QAGENT_SMOKE_WEAVE_DISCLOSURE_ACCEPTED)) {
    integrations.push(
      integration(
        'weave',
        'configured',
        'Credential present; set QAGENT_SMOKE_WEAVE_DISCLOSURE_ACCEPTED=true to send a redacted probe',
        checkedAt
      )
    );
  } else {
    let resolvedProject: string | undefined;
    integrations.push(
      await liveProbe(
        'weave',
        'A redacted operation was acknowledged and the Weave queue was flushed',
        checkedAt,
        environment,
        async () => {
          resolvedProject = await dependencies.probeWeave(
            weaveKey,
            environment.WEAVE_PROJECT ?? 'qagent-adapter-smoke',
            AbortSignal.timeout(60_000)
          );
        },
        'end-to-end-verified',
        () => (resolvedProject ? weaveProjectUrl(resolvedProject) : undefined)
      )
    );
  }

  if (!environment.REDIS_URL) {
    integrations.push(
      integration('redis', 'unconfigured', 'REDIS_URL is not configured', checkedAt)
    );
  } else {
    integrations.push(
      await liveProbe(
        'redis',
        'Authenticated Redis PING succeeded',
        checkedAt,
        environment,
        async () =>
          withTimeout(
            dependencies.probeRedis(environment.REDIS_URL as string),
            30_000,
            'Redis probe timed out'
          )
      )
    );
  }

  integrations.push(
    await httpProbe({
      provider: 'vercel',
      required: ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID'],
      url: `https://api.vercel.com/v9/projects/${environment.VERCEL_PROJECT_ID ?? ''}`,
      headers: { Authorization: `Bearer ${environment.VERCEL_TOKEN ?? ''}` },
      success: 'Authenticated Vercel project metadata was reachable',
      checkedAt,
      environment,
      dependencies,
    })
  );

  integrations.push(
    environment.DAYTONA_API_KEY
      ? integration(
          'daytona',
          'configured',
          'Credential present; Daytona is not a certified v0.2 runtime adapter',
          checkedAt
        )
      : integration('daytona', 'unconfigured', 'DAYTONA_API_KEY is not configured', checkedAt)
  );

  return { schemaVersion: 1, checkedAt, integrations };
}

async function httpProbe(options: {
  provider: string;
  required: string[];
  url: string;
  headers: Record<string, string>;
  success: string;
  checkedAt: string;
  environment: NodeJS.ProcessEnv;
  dependencies: AdapterSmokeDependencies;
}): Promise<Integration> {
  const missing = options.required.filter((name) => !options.environment[name]);
  if (missing.length > 0) {
    return integration(
      options.provider,
      'unconfigured',
      `Missing ${missing.join(', ')}`,
      options.checkedAt
    );
  }
  return liveProbe(
    options.provider,
    options.success,
    options.checkedAt,
    options.environment,
    async () => {
      const response = await options.dependencies.fetch(options.url, {
        headers: options.headers,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
    }
  );
}

async function liveProbe(
  provider: string,
  success: string | (() => string),
  checkedAt: string,
  environment: NodeJS.ProcessEnv,
  probe: () => Promise<unknown>,
  status: Integration['status'] = 'healthy',
  sourceUrl?: () => string | undefined
): Promise<Integration> {
  try {
    await probe();
    const detail = typeof success === 'function' ? success() : success;
    return integration(provider, status, detail, checkedAt, sourceUrl?.());
  } catch (error) {
    return integration(
      provider,
      'error',
      `Probe failed: ${redactedError(error, environment)}`,
      checkedAt
    );
  }
}

function parseRepository(value: string): GitHubRepositoryRef {
  const match = value.match(
    /^([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)\/([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)$/i
  );
  if (!match?.[1] || !match[2]) {
    throw new Error('GITHUB_REPOSITORY must be an owner/repository name');
  }
  return { owner: match[1], repo: match[2] };
}

function optionalPositiveInteger(value: string | undefined, label: string): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function assertGitHubPublicationCapabilities(probe: GitHubRepositoryProbe): void {
  if (probe.repository.archived || probe.repository.disabled) {
    throw new Error('GitHub repository is archived or disabled');
  }
  if (!probe.permissions.canPull || !probe.permissions.canPush) {
    throw new Error('GitHub repository pull and push permissions were not both verified');
  }
  if (probe.permissions.pullRequests !== 'write') {
    throw new Error('GitHub pull-request write permission was not verified');
  }
  if (probe.rules.classicProtection === 'unavailable') {
    throw new Error('GitHub classic branch-protection state was unavailable');
  }
  if (probe.merge.allowedMethods.length === 0) {
    throw new Error('GitHub repository has no allowed merge method');
  }
}

function integration(
  provider: string,
  status: Integration['status'],
  detail: string,
  checkedAt: string,
  sourceUrl?: string
): Integration {
  const sanitizedSourceUrl = sourceUrl ? sanitizedEvidenceUrl(sourceUrl) : undefined;
  return IntegrationSchema.parse({
    id: randomUUID(),
    provider,
    status,
    detail,
    ...(sanitizedSourceUrl
      ? {
          evidence: [
            {
              sourceUrl: sanitizedSourceUrl,
              capturedAt: checkedAt,
              kind: status === 'end-to-end-verified' ? 'end-to-end-workflow' : 'provider-probe',
              authorization: 'verified',
              summary: detail.slice(0, 2_000),
            },
          ],
        }
      : {}),
    provenance: {
      source: 'provider',
      provider,
      capturedAt: checkedAt,
      ...(sanitizedSourceUrl ? { sourceUrl: sanitizedSourceUrl } : {}),
    },
    updatedAt: checkedAt,
  });
}

function weaveProjectUrl(project: string): string {
  const segments = project.split('/');
  if (segments.length !== 2 || segments.some((segment) => !segment)) {
    throw new Error('Weave did not return a valid entity/project identifier');
  }
  return `https://wandb.ai/${segments.map((segment) => encodeURIComponent(segment)).join('/')}/weave`;
}

function sanitizedEvidenceUrl(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('Integration evidence URL was not a sanitized HTTPS URL');
  }
  return parsed.toString();
}

function redactedError(error: unknown, environment: NodeJS.ProcessEnv): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [key, value] of Object.entries(environment)) {
    if (!value || !/(key|token|secret|password|authorization|credential|url)/i.test(key)) continue;
    message = message.replaceAll(value, '[REDACTED]');
  }
  return String(redactForTelemetry(message));
}

function truthy(value: string | undefined): boolean {
  return Boolean(value && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()));
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
