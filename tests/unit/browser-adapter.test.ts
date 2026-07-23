import {
  StagehandBrowser,
  detectBrowser,
  installManagedBrowser,
  type BrowserAdapterDependencies,
  type StagehandFactory,
} from '@qagent/adapters';
import type { BrowserFlow } from '@qagent/contracts';
import { QAgentConfigSchema } from '@qagent/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  platform: 'darwin' as NodeJS.Platform,
  browserPlatform: 'mac' as ReturnType<BrowserAdapterDependencies['detectBrowserPlatform']>,
  accessible: new Set<string>(),
  useExistingPage: true,
  documentValue: '<html>fixture</html>' as unknown,
  actionError: null as Error | null,
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
      handler({ type: () => 'log', text: () => 'grounded console output' });
    }
  }),
  url: vi.fn(() => 'http://127.0.0.1:41773/result'),
  title: vi.fn(async () => 'Fixture title'),
  screenshot: vi.fn(async () => Uint8Array.from([1, 2, 3])),
  sendCDP: vi.fn(async () => ({ result: { value: state.documentValue } })),
};

const stagehandFactory: StagehandFactory = async (options) => {
  state.stagehandOptions = options;
  return {
    context: {
      pages: () => (state.useExistingPage ? [page] : []),
      newPage: vi.fn(async () => page),
    },
    init: state.init,
    close: state.close,
    act: async (step: string) => {
      state.actions.push(step);
      if (state.actionError) throw state.actionError;
    },
  };
};

beforeEach(() => {
  state.platform = 'darwin';
  state.browserPlatform = 'mac' as typeof state.browserPlatform;
  state.accessible.clear();
  state.useExistingPage = true;
  state.documentValue = '<html>fixture</html>';
  state.actionError = null;
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
      },
    ]);
    expect(state.actions).toEqual(flow.steps);
    expect(state.stagehandOptions).toMatchObject({
      env: 'LOCAL',
      model: {
        modelName: 'openai/local-model',
        baseURL: 'http://127.0.0.1:11434/v1',
      },
      localBrowserLaunchOptions: { executablePath: '/chrome', headless: true },
    });
    expect(page.off).toHaveBeenCalledOnce();
    expect(state.close).toHaveBeenCalledOnce();
  });

  it('supports Browserbase mode, a new page, and missing DOM values', async () => {
    state.useExistingPage = false;
    state.documentValue = undefined;
    const evidence = await new StagehandBrowser(stagehandFactory).runFlows({
      config: config('browserbase'),
      browser: { name: 'Chrome', executablePath: '/chrome', source: 'system' },
      targetUrl: 'https://example.test',
      flows: [flow],
    });
    expect(evidence[0]?.dom).toBe('');
    expect(state.stagehandOptions).toMatchObject({ env: 'BROWSERBASE' });
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
      expect(state.stagehandOptions).toMatchObject({ model: expected });
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
    expect(state.close).toHaveBeenCalledOnce();

    state.close.mockClear();
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
