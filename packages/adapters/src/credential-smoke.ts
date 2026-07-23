import { randomUUID } from 'node:crypto';
import type { Integration, QAgentConfig } from '@qagent/contracts';
import { z } from 'zod';
import { createModelProvider } from './model.js';
import { redactForTelemetry } from './telemetry.js';

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
  probeRedis(url: string): Promise<void>;
  probeWeave(project: string): Promise<void>;
}

interface WeaveSmokeModule {
  init(project: string): Promise<{ waitForBatchProcessing(): Promise<void> }>;
  op<T extends (input: Record<string, unknown>) => Promise<Record<string, unknown>>>(
    fn: T,
    options: {
      name: string;
      postprocessInputs: (inputs: unknown) => unknown;
      postprocessOutput: (output: unknown) => unknown;
    }
  ): T;
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
  probeWeave: async (project) => {
    const weave = (await import('weave')) as unknown as WeaveSmokeModule;
    const client = await weave.init(project);
    const operation = weave.op(async (input: Record<string, unknown>) => input, {
      name: 'qagent.adapter.smoke',
      postprocessInputs: (input) => redactForTelemetry(input),
      postprocessOutput: (output) => redactForTelemetry(output),
    });
    await operation({ schemaVersion: 1, probe: 'credential-backed' });
    await client.waitForBatchProcessing();
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

  integrations.push(
    await httpProbe({
      provider: 'github',
      required: ['GITHUB_TOKEN', 'GITHUB_REPOSITORY'],
      url: `https://api.github.com/repos/${environment.GITHUB_REPOSITORY ?? ''}`,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${environment.GITHUB_TOKEN ?? ''}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      success: 'Authenticated repository metadata was reachable',
      checkedAt,
      environment,
      dependencies,
    })
  );
  integrations.push(
    await httpProbe({
      provider: 'browserbase',
      required: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'],
      url: `https://api.browserbase.com/v1/projects/${environment.BROWSERBASE_PROJECT_ID ?? ''}`,
      headers: { 'X-BB-API-Key': environment.BROWSERBASE_API_KEY ?? '' },
      success: 'Authenticated Browserbase project metadata was reachable',
      checkedAt,
      environment,
      dependencies,
    })
  );

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
    integrations.push(
      await liveProbe(
        'weave',
        'A redacted operation was accepted and flushed by Weave',
        checkedAt,
        environment,
        async () =>
          withTimeout(
            dependencies.probeWeave(environment.WEAVE_PROJECT ?? 'qagent-adapter-smoke'),
            60_000,
            'Weave probe timed out'
          ),
        'end-to-end-verified'
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
  success: string,
  checkedAt: string,
  environment: NodeJS.ProcessEnv,
  probe: () => Promise<void>,
  status: Integration['status'] = 'healthy'
): Promise<Integration> {
  try {
    await probe();
    return integration(provider, status, success, checkedAt);
  } catch (error) {
    return integration(
      provider,
      'error',
      `Probe failed: ${redactedError(error, environment)}`,
      checkedAt
    );
  }
}

function integration(
  provider: string,
  status: Integration['status'],
  detail: string,
  checkedAt: string
): Integration {
  return {
    id: randomUUID(),
    provider,
    status,
    detail,
    provenance: { source: 'provider', provider, capturedAt: checkedAt },
    updatedAt: checkedAt,
  };
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
