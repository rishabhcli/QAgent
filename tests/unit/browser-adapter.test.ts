import {
  BrowserFlowError,
  BrowserModelOutputError,
  BrowserModelProviderError,
  StagehandBrowser,
  detectBrowser,
  installManagedBrowser,
  probeBrowserbaseProject,
  type BrowserAdapterDependencies,
  type StagehandFactory,
} from '@qagent/adapters';
import Anthropic from '@anthropic-ai/sdk';
import { ApiError as GoogleApiError } from '@google/genai';
import type { BrowserFlow } from '@qagent/contracts';
import { QAgentConfigSchema } from '@qagent/contracts';
import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  platform: 'darwin' as NodeJS.Platform,
  browserPlatform: 'mac' as ReturnType<BrowserAdapterDependencies['detectBrowserPlatform']>,
  accessible: new Set<string>(),
  useExistingPage: true,
  documentValue: '<html>fixture</html>' as unknown,
  consoleText: 'grounded console output',
  pageUrl: 'http://127.0.0.1:41773/result',
  pageTitle: 'Fixture title',
  actionError: null as Error | null,
  actionResult: {
    success: true,
    message: 'Action completed',
    actionDescription: 'completed test action',
    actions: [],
  },
  sessionId: 'session_safe_123',
  sessionUrl: 'https://www.browserbase.com/sessions/session_safe_123',
  debugUrl: 'https://www.browserbase.com/live/session_safe_123?navbar=true',
  handlers: new Set<(message: { type(): string; text(): string }) => void>(),
  stagehandOptions: null as Record<string, unknown> | null,
  actions: [] as string[],
  close: vi.fn(async () => undefined),
  init: vi.fn(async () => undefined),
  install: vi.fn(async () => ({ executablePath: '/managed/installed-chrome' })),
  resolveBuildId: vi.fn(async () => 'stable-build'),
  computeExecutablePath: vi.fn(() => '/managed/chrome'),
};

const adapterDependencies: Partial<BrowserAdapterDependencies> = {
  access: async (path) => {
    if (!state.accessible.has(String(path))) throw new Error('missing');
  },
  platform: () => state.platform,
  homedir: () => '/home/qagent',
  detectBrowserPlatform: () => state.browserPlatform,
  resolveBuildId: state.resolveBuildId,
  computeExecutablePath: state.computeExecutablePath,
  install: state.install as unknown as BrowserAdapterDependencies['install'],
};

const page = {
  on: vi.fn(
    (_event: 'console', listener: (message: { type(): string; text(): string }) => void) => {
      state.handlers.add(listener);
    }
  ),
  off: vi.fn(
    (_event: 'console', listener: (message: { type(): string; text(): string }) => void) => {
      state.handlers.delete(listener);
    }
  ),
  goto: vi.fn(async () => {
    for (const handler of state.handlers) {
      handler({ type: () => 'log', text: () => state.consoleText });
    }
  }),
  url: vi.fn(() => state.pageUrl),
  title: vi.fn(async () => state.pageTitle),
  screenshot: vi.fn(async () => Uint8Array.from([1, 2, 3])),
  sendCDP: vi.fn(async () => ({ result: { value: state.documentValue } })),
};

const stagehandFactory: StagehandFactory = async (options) => {
  state.stagehandOptions = options;
  return {
    browserbaseSessionID: options.env === 'BROWSERBASE' ? state.sessionId : undefined,
    browserbaseSessionURL: options.env === 'BROWSERBASE' ? state.sessionUrl : undefined,
    browserbaseDebugURL: options.env === 'BROWSERBASE' ? state.debugUrl : undefined,
    context: {
      pages: () => (state.useExistingPage ? [page] : []),
      newPage: vi.fn(async () => page),
    },
    init: state.init,
    close: state.close,
    act: async (step: string) => {
      state.actions.push(step);
      if (state.actionError) throw state.actionError;
      return state.actionResult;
    },
  };
};

beforeEach(() => {
  state.platform = 'darwin';
  state.browserPlatform = 'mac' as typeof state.browserPlatform;
  state.accessible.clear();
  state.useExistingPage = true;
  state.documentValue = '<html>fixture</html>';
  state.consoleText = 'grounded console output';
  state.pageUrl = 'http://127.0.0.1:41773/result';
  state.pageTitle = 'Fixture title';
  state.actionError = null;
  state.actionResult = {
    success: true,
    message: 'Action completed',
    actionDescription: 'completed test action',
    actions: [],
  };
  state.sessionId = 'session_safe_123';
  state.sessionUrl = 'https://www.browserbase.com/sessions/session_safe_123';
  state.debugUrl = 'https://www.browserbase.com/live/session_safe_123?navbar=true';
  state.handlers.clear();
  state.stagehandOptions = null;
  state.actions.length = 0;
  state.close.mockClear();
  state.init.mockClear();
  state.install.mockClear();
  state.resolveBuildId.mockClear();
  state.computeExecutablePath.mockClear();
  page.on.mockClear();
  page.off.mockClear();
  page.goto.mockClear();
  page.sendCDP.mockClear();
});

afterEach(() => vi.unstubAllEnvs());

describe('browser discovery', () => {
  it('validates authenticated Browserbase project metadata', async () => {
    const fetchImplementation = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'project-safe', name: 'QAgent smoke' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    ) as unknown as typeof globalThis.fetch;

    await expect(
      probeBrowserbaseProject('browserbase-secret', 'project-safe', undefined, fetchImplementation)
    ).resolves.toMatchObject({ id: 'project-safe', capturedAt: expect.any(String) });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://api.browserbase.com/v1/projects/project-safe',
      expect.objectContaining({
        headers: { 'X-BB-API-Key': 'browserbase-secret' },
        redirect: 'error',
        signal: expect.any(AbortSignal),
      })
    );

    const mismatch = vi.fn(async () =>
      Promise.resolve(new Response(JSON.stringify({ id: 'different-project' }), { status: 200 }))
    ) as unknown as typeof globalThis.fetch;
    await expect(
      probeBrowserbaseProject('browserbase-secret', 'project-safe', undefined, mismatch)
    ).rejects.toThrow(/did not confirm access/);
  });

  it('selects configured, system, and managed browsers with explicit provenance', async () => {
    state.accessible.add('/configured/chrome');
    await expect(
      detectBrowser('/configured/chrome', undefined, adapterDependencies)
    ).resolves.toMatchObject({
      source: 'configured',
      executablePath: '/configured/chrome',
    });

    state.accessible.clear();
    state.accessible.add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    await expect(detectBrowser('/missing', undefined, adapterDependencies)).resolves.toMatchObject({
      name: 'Microsoft Edge',
      source: 'system',
    });

    state.platform = 'win32';
    process.env.PROGRAMFILES = 'C:/Programs';
    process.env.LOCALAPPDATA = 'C:/Local';
    state.accessible.clear();
    state.accessible.add('C:/Local/Microsoft/Edge/Application/msedge.exe');
    await expect(detectBrowser(undefined, undefined, adapterDependencies)).resolves.toMatchObject({
      name: 'Microsoft Edge',
      source: 'system',
    });

    state.platform = 'linux';
    state.accessible.clear();
    state.accessible.add('/usr/bin/chromium-browser');
    await expect(detectBrowser(undefined, undefined, adapterDependencies)).resolves.toMatchObject({
      name: 'Chromium Browser',
      source: 'system',
    });

    state.accessible.clear();
    state.accessible.add('/managed/chrome');
    await expect(detectBrowser(undefined, '/cache', adapterDependencies)).resolves.toEqual({
      name: 'QAgent managed Chrome',
      executablePath: '/managed/chrome',
      source: 'managed',
    });
  });

  it('returns unavailable when no executable or managed platform exists', async () => {
    state.platform = 'linux';
    state.browserPlatform = undefined;
    await expect(detectBrowser('/missing', '/cache', adapterDependencies)).resolves.toBeNull();
    await expect(detectBrowser(undefined, undefined, adapterDependencies)).resolves.toBeNull();
  });

  it('installs the stable managed browser and rejects unsupported platforms', async () => {
    const progress = vi.fn();
    await expect(installManagedBrowser('/cache', progress, adapterDependencies)).resolves.toEqual({
      name: 'QAgent managed Chrome',
      executablePath: '/managed/installed-chrome',
      source: 'managed',
    });
    expect(state.install).toHaveBeenCalledWith(
      expect.objectContaining({
        browser: 'chrome',
        buildId: 'stable-build',
        cacheDir: '/cache',
        unpack: true,
        downloadProgressCallback: progress,
      })
    );

    state.browserPlatform = undefined;
    await expect(installManagedBrowser('/cache', undefined, adapterDependencies)).rejects.toThrow(
      /Unsupported browser platform/
    );
  });
});

describe('Stagehand local browser evidence', () => {
  const flow: BrowserFlow = {
    name: 'Increment once',
    steps: ['click the increment button', 'verify the counter reads one'],
  };

  it('captures screenshot, DOM, console, URL, and title in local mode', async () => {
    const evidence = await new StagehandBrowser(stagehandFactory).runFlows({
      config: config('local'),
      browser: { name: 'Chromium', executablePath: '/chrome', source: 'configured' },
      targetUrl: 'http://127.0.0.1:41773',
      flows: [flow],
    });

    expect(evidence).toEqual([
      {
        flow: 'Increment once',
        url: 'http://127.0.0.1:41773/result',
        title: 'Fixture title',
        screenshot: Uint8Array.from([1, 2, 3]),
        dom: '<html>fixture</html>',
        logs: ['[log] grounded console output'],
        session: {
          provider: 'local',
          browserName: 'Chromium',
          browserSource: 'configured',
          liveViewAvailable: false,
        },
      },
    ]);
    expect(state.actions).toEqual(flow.steps);
    expect(state.stagehandOptions).toMatchObject({
      env: 'LOCAL',
      model: 'openai/local-model',
      openAICompatible: {
        modelName: 'local-model',
        baseURL: 'http://127.0.0.1:11434/v1',
      },
      disableAPI: true,
      localBrowserLaunchOptions: { executablePath: '/chrome', headless: true },
      actTimeoutMs: 120_000,
      disablePino: true,
      verbose: 0,
    });
    expect(page.off).toHaveBeenCalledOnce();
    expect(state.close).toHaveBeenCalledOnce();
  });

  it('runs Browserbase independently of local Chrome and exposes safe session metadata', async () => {
    vi.stubEnv('BROWSERBASE_API_KEY', 'browserbase-test-key');
    vi.stubEnv('BROWSERBASE_PROJECT_ID', 'browserbase-project');
    state.useExistingPage = false;
    const evidence = await new StagehandBrowser(stagehandFactory).runFlows({
      config: config('browserbase'),
      targetUrl: 'https://example.test',
      flows: [flow],
    });
    expect(evidence[0]?.session).toEqual({
      provider: 'browserbase',
      sessionId: 'session_safe_123',
      sessionUrl: 'https://www.browserbase.com/sessions/session_safe_123',
      liveViewUrl: 'https://www.browserbase.com/live/session_safe_123',
      liveViewAvailable: true,
    });
    expect(state.stagehandOptions).toMatchObject({
      env: 'BROWSERBASE',
      apiKey: 'browserbase-test-key',
      projectId: 'browserbase-project',
      browserbaseSessionCreateParams: {
        projectId: 'browserbase-project',
        timeout: 120,
      },
      disableAPI: true,
    });
    expect(state.stagehandOptions).not.toHaveProperty('localBrowserLaunchOptions');
  });

  it('requires both Browserbase credentials and a local executable only in local mode', async () => {
    vi.stubEnv('BROWSERBASE_API_KEY', '');
    vi.stubEnv('BROWSERBASE_PROJECT_ID', '');
    await expect(
      new StagehandBrowser(stagehandFactory).runFlows({
        config: config('browserbase'),
        targetUrl: 'https://example.test',
        flows: [flow],
      })
    ).rejects.toThrow('BROWSERBASE_API_KEY');

    vi.stubEnv('BROWSERBASE_API_KEY', 'browserbase-test-key');
    await expect(
      new StagehandBrowser(stagehandFactory).runFlows({
        config: config('browserbase'),
        targetUrl: 'https://example.test',
        flows: [flow],
      })
    ).rejects.toThrow('BROWSERBASE_PROJECT_ID');

    await expect(
      new StagehandBrowser(stagehandFactory).runFlows({
        config: config('local'),
        targetUrl: 'https://example.test',
        flows: [flow],
      })
    ).rejects.toThrow(/requires a discovered or managed Chrome executable/);
  });

  it('does not send compatible-model credentials to a remote plaintext endpoint', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'model-secret');
    await expect(
      new StagehandBrowser(stagehandFactory).runFlows({
        config: config('local', {
          provider: 'openai-compatible',
          model: 'remote-model',
          baseUrl: 'http://models.example.test/v1',
        }),
        browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
        targetUrl: 'https://example.test',
        flows: [flow],
      })
    ).rejects.toThrow('must use HTTPS');
    expect(state.init).not.toHaveBeenCalled();
  });

  it('rejects Browserbase metadata that embeds a provider credential', async () => {
    vi.stubEnv('BROWSERBASE_API_KEY', 'browserbase-test-key');
    vi.stubEnv('BROWSERBASE_PROJECT_ID', 'browserbase-project');
    state.debugUrl = 'https://www.browserbase.com/live/session_safe_123?token=browserbase-test-key';
    const error = await new StagehandBrowser(stagehandFactory)
      .runFlows({
        config: config('browserbase'),
        targetUrl: 'https://example.test',
        flows: [flow],
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(BrowserFlowError);
    expect(error).toMatchObject({
      evidence: {
        flow: 'initialization',
        session: { provider: 'browserbase', liveViewAvailable: false },
      },
    });
    expect(String(error)).not.toContain('browserbase-test-key');
  });

  it.each([
    ['openai', 'gpt-5.6-luna', 'openai/gpt-5.6-luna'],
    ['anthropic', 'claude-haiku-4-5', 'anthropic/claude-haiku-4-5'],
    ['google', 'gemini-3.5-flash-lite', 'google/gemini-3.5-flash-lite'],
  ] as const)(
    'normalizes %s models to the Stagehand provider contract',
    async (provider, model, expected) => {
      vi.stubEnv('OPENAI_API_KEY', '');
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('GOOGLE_API_KEY', '');
      await new StagehandBrowser(stagehandFactory).runFlows({
        config: config('local', { provider, model }),
        browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
        targetUrl: 'https://example.test',
        flows: [flow],
      });
      expect(state.stagehandOptions).toMatchObject({ model: expected, disableAPI: true });
    }
  );

  it('passes the stored Google credential explicitly to Stagehand', async () => {
    vi.stubEnv('GOOGLE_API_KEY', 'stored-google-key');
    await new StagehandBrowser(stagehandFactory).runFlows({
      config: config('local', { provider: 'google', model: 'gemini-3.5-flash-lite' }),
      browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
      targetUrl: 'https://example.test',
      flows: [flow],
    });
    expect(state.stagehandOptions).toMatchObject({
      model: {
        modelName: 'google/gemini-3.5-flash-lite',
        apiKey: 'stored-google-key',
      },
    });
  });

  it('rejects unverified actions and retains bounded failure evidence', async () => {
    state.actionResult = {
      success: false,
      message: 'The requested state was not reached',
      actionDescription: 'attempted test action',
      actions: [],
    };
    const error = await new StagehandBrowser(stagehandFactory)
      .runFlows({
        config: config('local'),
        browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
        targetUrl: 'https://example.test',
        flows: [flow],
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(BrowserFlowError);
    expect(error).toMatchObject({
      evidence: {
        flow: 'Increment once',
        url: 'http://127.0.0.1:41773/result',
        title: 'Fixture title',
        dom: '<html>fixture</html>',
        screenshot: Uint8Array.from([1, 2, 3]),
        error: expect.stringContaining('not successful'),
      },
    });
    expect(state.close).toHaveBeenCalledOnce();
  });

  it('treats incomplete CDP evidence as a flow failure instead of a fake empty DOM', async () => {
    state.documentValue = undefined;
    const error = await new StagehandBrowser(stagehandFactory)
      .runFlows({
        config: config('local'),
        browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
        targetUrl: 'https://example.test',
        flows: [flow],
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(BrowserFlowError);
    expect(error.message).toContain('did not return a serialized DOM');
    expect(error.evidence.dom).toBeUndefined();
    expect(error.evidence.screenshot).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it('redacts provider credentials from console and failure messages', async () => {
    const secret = 'browserbase-secret/value with space';
    const encodedSecret = encodeURIComponent(secret);
    const base64Secret = Buffer.from(secret).toString('base64');
    vi.stubEnv('BROWSERBASE_API_KEY', secret);
    state.actionError = new Error(
      `provider echoed ${encodedSecret} ${base64Secret}; Authorization: Bearer generic-provider-token-1234; password=hunter2-secret`
    );
    const error = await new StagehandBrowser(stagehandFactory)
      .runFlows({
        config: config('local'),
        browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
        targetUrl: 'https://example.test',
        flows: [flow],
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(BrowserFlowError);
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(encodedSecret);
    expect(error.message).not.toContain(base64Secret);
    expect(error.message).not.toContain('generic-provider-token-1234');
    expect(error.message).not.toContain('hunter2-secret');
    expect(error.message).toContain('[REDACTED]');
  });

  it('redacts transformed and generic credentials from successful browser evidence', async () => {
    const secret = 'browser-secret/value with space';
    const encodedSecret = encodeURIComponent(secret);
    const base64Secret = Buffer.from(secret).toString('base64');
    vi.stubEnv('OPENAI_API_KEY', secret);
    state.consoleText = `Authorization: Bearer generic-console-token-1234 ${encodedSecret}`;
    state.pageUrl = `https://example.test/result?trace=${encodedSecret}&token=generic-url-token-1234`;
    state.pageTitle = `Result ${base64Secret}`;
    state.documentValue = `<html><input password="generic-dom-password"><p>${encodedSecret}</p></html>`;

    const [evidence] = await new StagehandBrowser(stagehandFactory).runFlows({
      config: config('local'),
      browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
      targetUrl: 'https://example.test',
      flows: [flow],
    });
    const persistedText = JSON.stringify(evidence);
    for (const credential of [
      secret,
      encodedSecret,
      base64Secret,
      'generic-console-token-1234',
      'generic-url-token-1234',
      'generic-dom-password',
    ]) {
      expect(persistedText).not.toContain(credential);
    }
    expect(persistedText).toContain('[REDACTED]');
  });

  it.each([
    [
      'openai',
      () =>
        new OpenAI.APIError(
          503,
          { message: 'OpenAI unavailable', type: 'server_error' },
          'OpenAI unavailable',
          {}
        ),
    ],
    [
      'anthropic',
      () =>
        new Anthropic.APIError(
          503,
          { message: 'Anthropic unavailable' },
          'Anthropic unavailable',
          new Headers()
        ),
    ],
    ['google', () => new GoogleApiError({ message: 'Google unavailable', status: 503 })],
  ] as const)(
    'classifies a concrete %s SDK failure without relabeling action errors',
    async (provider, createError) => {
      state.actionError = createError();
      const error = await new StagehandBrowser(stagehandFactory)
        .runFlows({
          config: config('local', { provider, model: 'hosted-model' }),
          browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
          targetUrl: 'https://example.test',
          flows: [flow],
        })
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(BrowserModelProviderError);
      expect(error).not.toBeInstanceOf(BrowserModelOutputError);
    }
  );

  it.each(['openai', 'anthropic', 'google'] as const)(
    'classifies branded AI SDK provider and schema errors for hosted %s',
    async (provider) => {
      state.actionError = brandedAiSdkError('AI_APICallError');
      const providerError = await new StagehandBrowser(stagehandFactory)
        .runFlows({
          config: config('local', { provider, model: 'hosted-model' }),
          browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
          targetUrl: 'https://example.test',
          flows: [flow],
        })
        .catch((reason: unknown) => reason);
      expect(providerError).toBeInstanceOf(BrowserModelProviderError);

      state.actionError = brandedAiSdkError('AI_NoObjectGeneratedError');
      const outputError = await new StagehandBrowser(stagehandFactory)
        .runFlows({
          config: config('local', { provider, model: 'hosted-model' }),
          browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
          targetUrl: 'https://example.test',
          flows: [flow],
        })
        .catch((reason: unknown) => reason);
      expect(outputError).toBeInstanceOf(BrowserModelOutputError);
    }
  );

  it('classifies an AI SDK retry by its branded provider cause', async () => {
    const providerCause = brandedAiSdkError('AI_APICallError');
    state.actionError = brandedAiSdkError('AI_RetryError', { errors: [providerCause] });
    const error = await new StagehandBrowser(stagehandFactory)
      .runFlows({
        config: config('local', { provider: 'openai', model: 'hosted-model' }),
        browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
        targetUrl: 'https://example.test',
        flows: [flow],
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(BrowserModelProviderError);
  });

  it('keeps DOM and action failures separate from compatible-provider failures', async () => {
    state.actionError = new Error('CreateChatCompletionResponseError: fake DOM action error');
    const error = await new StagehandBrowser(stagehandFactory)
      .runFlows({
        config: config('local'),
        browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
        targetUrl: 'https://example.test',
        flows: [flow],
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BrowserFlowError);
    expect(error).not.toBeInstanceOf(BrowserModelProviderError);
    expect(error).not.toBeInstanceOf(BrowserModelOutputError);
    expect(error).toMatchObject({
      evidence: {
        flow: 'Increment once',
        error: 'CreateChatCompletionResponseError: fake DOM action error',
      },
    });
  });

  it('short-circuits empty flows and closes the browser on abort or action failure', async () => {
    await expect(
      new StagehandBrowser(stagehandFactory).runFlows({
        config: config('local'),
        browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
        targetUrl: 'https://example.test',
        flows: [],
      })
    ).resolves.toEqual([]);
    expect(state.init).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      new StagehandBrowser(stagehandFactory).runFlows({
        config: config('local'),
        browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
        targetUrl: 'https://example.test',
        flows: [flow],
        signal: controller.signal,
      })
    ).rejects.toThrow('cancelled');
    expect(state.close).not.toHaveBeenCalled();

    state.actionError = new Error('action failed');
    await expect(
      new StagehandBrowser(stagehandFactory).runFlows({
        config: config('local'),
        browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
        targetUrl: 'https://example.test',
        flows: [flow],
      })
    ).rejects.toThrow('action failed');
    expect(page.off).toHaveBeenCalledOnce();
    expect(state.close).toHaveBeenCalledOnce();
  });

  it('bounds initialization and still closes a partially initialized session', async () => {
    state.init.mockImplementationOnce(() => new Promise<never>(() => undefined));
    await expect(
      new StagehandBrowser(stagehandFactory).runFlows({
        config: config('local'),
        browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
        targetUrl: 'https://example.test',
        flows: [flow],
        timeoutMs: 10,
      })
    ).rejects.toThrow(/Browser initialization failed: Browser initialization timed out/);
    expect(state.close).toHaveBeenCalledOnce();
  });
});

function config(
  provider: 'local' | 'browserbase',
  model: {
    provider: 'openai' | 'anthropic' | 'google' | 'openai-compatible';
    model: string;
    baseUrl?: string;
  } = { provider: 'openai-compatible', model: 'local-model' }
) {
  return QAgentConfigSchema.parse({
    version: 1,
    test: { commands: [{ executable: 'test' }] },
    browser: { provider, headless: true },
    model,
    publish: { provider: 'local' },
  });
}

function brandedAiSdkError(marker: string, properties: Record<string, unknown> = {}): Error {
  const error = Object.assign(new Error(`${marker} fixture`), properties);
  Object.defineProperty(error, Symbol.for(`vercel.ai.error.${marker}`), {
    configurable: true,
    value: true,
  });
  return error;
}
