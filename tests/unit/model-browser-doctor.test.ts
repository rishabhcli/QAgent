import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import {
  createModelProvider,
  detectBrowser,
  DOCTOR_MODEL_PROBE_TIMEOUT_MS,
  runDoctor,
  type DoctorDependencies,
  type ModelProvider,
} from '@qagent/adapters';
import { QAgentConfigSchema, type DoctorReport } from '@qagent/contracts';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { temporaryDirectory, temporaryFixtureRepository } from '../helpers.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
  );
});

describe('model adapters', () => {
  it.each([
    ['openai', 'OPENAI_API_KEY'],
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['google', 'GOOGLE_API_KEY'],
  ] as const)('fails visibly when %s credentials are unavailable', (provider, variable) => {
    const previous = process.env[variable];
    delete process.env[variable];
    try {
      expect(() => createModelProvider({ provider, model: 'model' }, {})).toThrow(variable);
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });

  it('validates structured output from an OpenAI-compatible local endpoint', async () => {
    const endpoint = await compatibleServer(
      JSON.stringify({ summary: 'Grounded response', confidence: 0.75 })
    );
    const provider = createModelProvider(
      { provider: 'openai-compatible', model: 'local-test', baseUrl: endpoint },
      { openaiCompatible: 'session-key' }
    );
    const schema = z.object({ summary: z.string(), confidence: z.number() });
    const completion = await provider.complete({
      purpose: 'triage',
      system: 'Return structured output.',
      prompt: 'Diagnose the fixture.',
      schemaName: 'diagnosis',
      schema,
    });

    expect(provider).toMatchObject({ provider: 'openai-compatible', model: 'local-test' });
    expect(completion).toEqual({
      value: { summary: 'Grounded response', confidence: 0.75 },
      inputTokens: 11,
      outputTokens: 6,
    });
  });

  it('rejects malformed or schema-invalid compatible responses', async () => {
    const malformed = createModelProvider(
      {
        provider: 'openai-compatible',
        model: 'local-test',
        baseUrl: await compatibleServer('not json'),
      },
      {}
    );
    await expect(completeSummary(malformed)).rejects.toThrow(/did not contain JSON/);

    const invalid = createModelProvider(
      {
        provider: 'openai-compatible',
        model: 'local-test',
        baseUrl: await compatibleServer(JSON.stringify({ unexpected: true })),
      },
      {}
    );
    await expect(completeSummary(invalid)).rejects.toThrow();
  });
});

describe('browser discovery and Doctor', () => {
  it('honors an existing configured browser path', async () => {
    await expect(detectBrowser(process.execPath)).resolves.toEqual({
      name: 'Configured browser',
      executablePath: process.execPath,
      source: 'configured',
    });
  });

  it('authenticates Browserbase without requiring a local Chrome installation', async () => {
    const config = QAgentConfigSchema.parse({
      version: 1,
      test: { commands: [{ executable: 'test' }] },
      browser: { provider: 'browserbase' },
      model: { provider: 'openai-compatible', model: 'local-test' },
      publish: { provider: 'local' },
    });
    let projectProbe = '';
    const report = await runDoctor({
      qagentHome: '/qagent',
      config,
      dependencies: doctorDependencies({
        environment: {
          BROWSERBASE_API_KEY: 'browserbase-key',
          BROWSERBASE_PROJECT_ID: 'browserbase-project',
        },
        detectBrowser: async () => {
          throw new Error('Browserbase Doctor must not inspect local Chrome');
        },
        probeBrowserbase: async (_apiKey, projectId) => {
          projectProbe = projectId;
        },
      }),
    });

    expect(projectProbe).toBe('browserbase-project');
    expect(report.checks.find((check) => check.id === 'browser')).toMatchObject({
      status: 'pass',
      code: 'browserbase.healthy',
      providerState: 'healthy',
    });
  });

  it('keeps Weave project access separate from trace disclosure', async () => {
    const config = QAgentConfigSchema.parse({
      version: 1,
      test: { commands: [{ executable: 'test' }] },
      model: { provider: 'openai-compatible', model: 'local-test' },
      publish: { provider: 'local' },
      telemetry: { weave: { enabled: true, project: 'entity/qagent' } },
    });
    const report = await runDoctor({
      qagentHome: '/qagent',
      config,
      dependencies: doctorDependencies({
        environment: { WANDB_API_KEY: 'weave-key' },
        probeWeave: async () => 'entity/qagent',
      }),
    });

    expect(report.status).toBe('degraded');
    expect(report.checks.find((check) => check.id === 'weave')).toMatchObject({
      status: 'warn',
      code: 'weave.disclosure-required',
      providerState: 'healthy',
    });
    expectActionableFailures(report);
  });

  it('reports grounded local readiness and a bad project path', async () => {
    const repository = await temporaryFixtureRepository();
    const home = await temporaryDirectory('qagent-doctor-');
    const config = QAgentConfigSchema.parse({
      version: 1,
      test: { commands: [{ executable: process.execPath, args: ['--version'] }] },
      browser: { executablePath: process.execPath },
      model: { provider: 'openai-compatible', model: 'local-test' },
      publish: { provider: 'local' },
    });
    const report = await runDoctor({
      projectPath: repository,
      qagentHome: home,
      config,
      dependencies: { probeModel: async () => undefined },
    });
    expect(report.status).not.toBe('blocked');
    expect(report.checks.map((check) => check.id)).toEqual([
      'node',
      'git',
      'browser',
      'project-config',
      'model',
    ]);
    expect(report.checks.every((check) => Date.parse(check.checkedAt) > 0)).toBe(true);
    expect(report.checks.find((check) => check.id === 'model')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'browser')).toMatchObject({
      status: 'pass',
      code: 'browser.configured',
      providerState: 'configured',
      detail: expect.stringContaining('end-to-end flow remain unverified'),
    });

    const invalid = await runDoctor({
      projectPath: join(home, 'missing'),
      qagentHome: home,
      config,
    });
    expect(invalid.status).toBe('blocked');
    expect(invalid.checks.find((check) => check.id === 'project-config')?.status).toBe('fail');
    expectActionableFailures(invalid);
  });

  it('distinguishes missing runtime dependencies and provider credentials', async () => {
    const config = QAgentConfigSchema.parse({
      version: 1,
      test: { commands: [{ executable: 'test' }] },
      model: { provider: 'openai', model: 'gpt-test' },
      publish: { provider: 'local' },
    });
    const report = await runDoctor({
      qagentHome: '/qagent',
      config,
      dependencies: doctorDependencies({
        nodeVersion: '23.9.0',
        environment: {},
        gitVersion: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
        detectBrowser: async () => null,
      }),
    });

    expect(report.status).toBe('blocked');
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'node', status: 'warn' }),
        expect.objectContaining({ id: 'git', status: 'fail', detail: 'Git was not found' }),
        expect.objectContaining({ id: 'browser', status: 'warn' }),
        expect.objectContaining({
          id: 'model',
          status: 'fail',
          detail: 'OPENAI_API_KEY is not configured',
        }),
      ])
    );
    expectActionableFailures(report);
  });

  it('blocks readiness when a configured model fails its live probe', async () => {
    const config = QAgentConfigSchema.parse({
      version: 1,
      test: { commands: [{ executable: 'test' }] },
      model: { provider: 'openai-compatible', model: 'offline-local' },
      publish: { provider: 'local' },
    });
    const report = await runDoctor({
      qagentHome: '/qagent',
      config,
      dependencies: doctorDependencies({
        probeModel: async () => {
          throw new Error('connection refused');
        },
      }),
    });

    expect(report.status).toBe('blocked');
    expect(report.checks.find((check) => check.id === 'model')).toMatchObject({
      status: 'fail',
      source: 'structured provider probe',
    });
    expect(report.checks.find((check) => check.id === 'model')?.detail).toContain(
      'connection refused'
    );
    expectActionableFailures(report);
  });

  it('allows a bounded cold model probe to finish without prewarming', async () => {
    expect(DOCTOR_MODEL_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    const config = QAgentConfigSchema.parse({
      version: 1,
      test: { commands: [{ executable: 'test' }] },
      model: { provider: 'openai-compatible', model: 'cold-local' },
      publish: { provider: 'local' },
    });
    let probeSignal: AbortSignal | null = null;
    const report = await runDoctor({
      qagentHome: '/qagent',
      config,
      dependencies: doctorDependencies({
        modelProbeTimeoutMs: 100,
        probeModel: async (_config, _environment, signal) => {
          probeSignal = signal;
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, 25);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timeout);
                reject(signal.reason);
              },
              { once: true }
            );
          });
        },
      }),
    });

    expect(probeSignal?.aborted).toBe(false);
    expect(report.checks.find((check) => check.id === 'model')).toMatchObject({
      status: 'pass',
      code: 'model.healthy',
      correctiveAction: null,
    });
  });

  it('keeps a genuine outer model-probe timeout visibly actionable', async () => {
    const config = QAgentConfigSchema.parse({
      version: 1,
      test: { commands: [{ executable: 'test' }] },
      model: { provider: 'openai-compatible', model: 'stalled-local' },
      publish: { provider: 'local' },
    });
    const report = await runDoctor({
      qagentHome: '/qagent',
      config,
      dependencies: doctorDependencies({
        modelProbeTimeoutMs: 5,
        probeModel: async (_config, _environment, signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      }),
    });
    const model = report.checks.find((check) => check.id === 'model');

    expect(report.status).toBe('blocked');
    expect(model).toMatchObject({
      status: 'fail',
      code: 'model.probe-failed',
      providerState: 'error',
      correctiveAction: {
        type: 'application',
        action: 'configure_provider',
      },
    });
    expect(model?.detail).toMatch(/timeout/i);
  });

  it('redacts the exact configured model credential from Doctor probe failures', async () => {
    const credential = 'opaque-model-credential';
    const config = QAgentConfigSchema.parse({
      version: 1,
      test: { commands: [{ executable: 'test' }] },
      model: { provider: 'openai', model: 'gpt-test' },
      publish: { provider: 'local' },
    });
    const report = await runDoctor({
      qagentHome: '/qagent',
      config,
      dependencies: doctorDependencies({
        environment: { OPENAI_API_KEY: credential },
        probeModel: async () => {
          throw new Error(`provider echoed ${credential}`);
        },
      }),
    });
    const model = report.checks.find((check) => check.id === 'model');

    expect(model).toMatchObject({ status: 'fail', code: 'model.probe-failed' });
    expect(model?.detail).toContain('[REDACTED]');
    expect(model?.detail).not.toContain(credential);
  });

  it('reports an unconfigured detected project and configured Anthropic adapter', async () => {
    const config = QAgentConfigSchema.parse({
      version: 1,
      test: { commands: [{ executable: 'test' }] },
      model: { provider: 'anthropic', model: 'claude-test' },
      publish: { provider: 'local' },
    });
    const report = await runDoctor({
      qagentHome: '/qagent',
      projectPath: '/repo',
      config,
      dependencies: doctorDependencies({
        environment: { ANTHROPIC_API_KEY: 'configured' },
        detectProject: async () => ({
          name: 'Ruby app',
          path: '/repo',
          stack: 'ruby',
          configPath: null,
          config: null,
          suggestedTestCommands: [],
          suggestedVerifyCommands: [],
          suggestedStartCommand: null,
          needsConfiguration: true,
        }),
      }),
    });

    expect(report.status).toBe('degraded');
    expect(report.checks.find((check) => check.id === 'project-config')).toMatchObject({
      status: 'warn',
      source: 'local project detection',
    });
    expect(report.checks.find((check) => check.id === 'model')?.status).toBe('pass');
    expectActionableFailures(report);
  });

  it('handles non-Error project failures and omits optional checks when not requested', async () => {
    const failed = await runDoctor({
      qagentHome: '/qagent',
      projectPath: '/repo',
      config: QAgentConfigSchema.parse({
        version: 1,
        test: { commands: [{ executable: 'test' }] },
        model: { provider: 'google', model: 'gemini-test' },
        publish: { provider: 'local' },
      }),
      dependencies: doctorDependencies({
        environment: { GOOGLE_API_KEY: 'configured' },
        detectProject: async () => {
          throw 'invalid project';
        },
      }),
    });
    expect(failed.status).toBe('blocked');
    expect(failed.checks.find((check) => check.id === 'project-config')?.detail).toBe(
      'invalid project'
    );
    expectActionableFailures(failed);

    const minimal = await runDoctor({
      qagentHome: '/qagent',
      dependencies: doctorDependencies(),
    });
    expect(minimal.status).toBe('ready');
    expect(minimal.checks.map((check) => check.id)).toEqual(['node', 'git', 'browser']);
  });
});

function expectActionableFailures(report: DoctorReport): void {
  for (const check of report.checks.filter(
    (candidate) => candidate.status === 'warn' || candidate.status === 'fail'
  )) {
    expect(check.correctiveAction, `${check.id} must expose a corrective action`).not.toBeNull();
  }
}

function doctorDependencies(
  overrides: Partial<DoctorDependencies> = {}
): Partial<DoctorDependencies> {
  return {
    nodeVersion: '24.13.0',
    environment: {},
    gitVersion: async () => ({ exitCode: 0, stdout: 'git version test', stderr: '' }),
    access: async () => undefined,
    detectBrowser: async () => ({
      name: 'Test Chromium',
      executablePath: '/browser',
      source: 'configured',
    }),
    probeModel: async () => undefined,
    ...overrides,
  };
}

async function compatibleServer(content: string): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl_test',
        object: 'chat.completion',
        created: 1,
        model: 'local-test',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 },
      })
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return `http://127.0.0.1:${address.port}/v1`;
}

function completeSummary(provider: ModelProvider) {
  return provider.complete({
    purpose: 'triage',
    system: 'Return JSON.',
    prompt: 'Test',
    schemaName: 'summary',
    schema: z.object({ summary: z.string() }),
  });
}
