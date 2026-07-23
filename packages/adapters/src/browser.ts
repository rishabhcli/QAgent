import { access as fsAccess } from 'node:fs/promises';
import { homedir as osHomedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import {
  Browser,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
  resolveBuildId,
} from '@puppeteer/browsers';
import type { BrowserFlow, QAgentConfig } from '@qagent/contracts';

export interface BrowserInstallation {
  name: string;
  executablePath: string;
  source: 'system' | 'managed' | 'configured';
}

export interface BrowserEvidence {
  flow: string;
  url: string;
  screenshot: Uint8Array;
  title: string;
  dom: string;
  logs: string[];
}

export interface BrowserAdapterDependencies {
  access: typeof fsAccess;
  platform: typeof osPlatform;
  homedir: typeof osHomedir;
  detectBrowserPlatform: typeof detectBrowserPlatform;
  resolveBuildId: typeof resolveBuildId;
  computeExecutablePath: typeof computeExecutablePath;
  install: typeof install;
}

interface StagehandPage {
  on(event: 'console', listener: StagehandConsoleListener): void;
  off(event: 'console', listener: StagehandConsoleListener): void;
  goto(url: string, options: { waitUntil: 'domcontentloaded' }): Promise<unknown>;
  sendCDP(
    method: 'Runtime.evaluate',
    options: { expression: string; returnByValue: true }
  ): Promise<{ result: { value?: unknown } }>;
  url(): string;
  title(): Promise<string>;
  screenshot(options: { type: 'png'; fullPage: true }): Promise<Uint8Array>;
}

interface StagehandSession {
  context: {
    pages(): StagehandPage[];
    newPage(): Promise<StagehandPage>;
  };
  init(): Promise<unknown>;
  act(step: string): Promise<unknown>;
  close(): Promise<unknown>;
}

interface StagehandOptions {
  env: 'LOCAL' | 'BROWSERBASE';
  apiKey: string | undefined;
  projectId: string | undefined;
  model:
    | string
    | {
        modelName: string;
        apiKey?: string;
        baseURL?: string;
      };
  localBrowserLaunchOptions: {
    executablePath: string;
    headless: boolean;
  };
}

type StagehandConsoleListener = (message: { type(): string; text(): string }) => void;

export type StagehandFactory = (options: StagehandOptions) => Promise<StagehandSession>;

const defaultDependencies: BrowserAdapterDependencies = {
  access: fsAccess,
  platform: osPlatform,
  homedir: osHomedir,
  detectBrowserPlatform,
  resolveBuildId,
  computeExecutablePath,
  install,
};

function dependencies(
  overrides: Partial<BrowserAdapterDependencies> = {}
): BrowserAdapterDependencies {
  return { ...defaultDependencies, ...overrides };
}

async function executable(path: string, access: typeof fsAccess): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function systemCandidates(
  platform: NodeJS.Platform,
  homedir: string
): Array<{ name: string; path: string }> {
  if (platform === 'darwin') {
    return [
      {
        name: 'Google Chrome',
        path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
      {
        name: 'Microsoft Edge',
        path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      },
      {
        name: 'Chromium',
        path: '/Applications/Chromium.app/Contents/MacOS/Chromium',
      },
      {
        name: 'Google Chrome',
        path: join(homedir, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      },
    ];
  }
  if (platform === 'win32') {
    const roots = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ].filter((root): root is string => Boolean(root));
    return roots.flatMap((root) => [
      { name: 'Google Chrome', path: join(root, 'Google/Chrome/Application/chrome.exe') },
      { name: 'Microsoft Edge', path: join(root, 'Microsoft/Edge/Application/msedge.exe') },
    ]);
  }
  return [
    { name: 'Google Chrome', path: '/usr/bin/google-chrome' },
    { name: 'Google Chrome Stable', path: '/usr/bin/google-chrome-stable' },
    { name: 'Chromium', path: '/usr/bin/chromium' },
    { name: 'Chromium Browser', path: '/usr/bin/chromium-browser' },
    { name: 'Microsoft Edge', path: '/usr/bin/microsoft-edge' },
  ];
}

export async function detectBrowser(
  configuredPath?: string,
  managedCache?: string,
  overrides: Partial<BrowserAdapterDependencies> = {}
): Promise<BrowserInstallation | null> {
  const runtime = dependencies(overrides);
  if (configuredPath && (await executable(configuredPath, runtime.access))) {
    return { name: 'Configured browser', executablePath: configuredPath, source: 'configured' };
  }
  for (const candidate of systemCandidates(runtime.platform(), runtime.homedir())) {
    if (await executable(candidate.path, runtime.access)) {
      return { name: candidate.name, executablePath: candidate.path, source: 'system' };
    }
  }
  if (managedCache) {
    const browserPlatform = runtime.detectBrowserPlatform();
    if (browserPlatform) {
      const buildId = await runtime.resolveBuildId(Browser.CHROME, browserPlatform, 'stable');
      const path = runtime.computeExecutablePath({
        browser: Browser.CHROME,
        buildId,
        cacheDir: managedCache,
      });
      if (await executable(path, runtime.access)) {
        return { name: 'QAgent managed Chrome', executablePath: path, source: 'managed' };
      }
    }
  }
  return null;
}

export async function installManagedBrowser(
  cacheDir: string,
  onProgress?: (downloadedBytes: number, totalBytes: number) => void,
  overrides: Partial<BrowserAdapterDependencies> = {}
): Promise<BrowserInstallation> {
  const runtime = dependencies(overrides);
  const browserPlatform = runtime.detectBrowserPlatform();
  if (!browserPlatform) throw new Error(`Unsupported browser platform: ${runtime.platform()}`);
  const buildId = await runtime.resolveBuildId(Browser.CHROME, browserPlatform, 'stable');
  const installed = await runtime.install({
    browser: Browser.CHROME,
    buildId,
    cacheDir,
    unpack: true,
    downloadProgressCallback: onProgress,
  });
  return {
    name: 'QAgent managed Chrome',
    executablePath: installed.executablePath,
    source: 'managed',
  };
}

export class StagehandBrowser {
  constructor(private readonly factory: StagehandFactory = defaultStagehandFactory) {}

  async runFlows(options: {
    config: QAgentConfig;
    browser: BrowserInstallation;
    targetUrl: string;
    flows: BrowserFlow[];
    signal?: AbortSignal;
  }): Promise<BrowserEvidence[]> {
    if (options.flows.length === 0) return [];
    const stagehand = await this.factory({
      env: options.config.browser.provider === 'browserbase' ? 'BROWSERBASE' : 'LOCAL',
      apiKey: process.env.BROWSERBASE_API_KEY,
      projectId: process.env.BROWSERBASE_PROJECT_ID,
      model: stagehandModel(options.config.model),
      localBrowserLaunchOptions: {
        executablePath: options.browser.executablePath,
        headless: options.config.browser.headless,
      },
    });
    await stagehand.init();
    try {
      const page = stagehand.context.pages()[0] ?? (await stagehand.context.newPage());
      const evidence: BrowserEvidence[] = [];
      for (const flow of options.flows) {
        if (options.signal?.aborted) throw options.signal.reason;
        const logs: string[] = [];
        const consoleListener: StagehandConsoleListener = (message) => {
          logs.push(`[${message.type()}] ${message.text()}`);
        };
        page.on('console', consoleListener);
        await page.goto(options.targetUrl, { waitUntil: 'domcontentloaded' });
        try {
          for (const step of flow.steps) await stagehand.act(step);
          const document = await page.sendCDP('Runtime.evaluate', {
            expression: 'document.documentElement.outerHTML',
            returnByValue: true,
          });
          evidence.push({
            flow: flow.name,
            url: page.url(),
            title: await page.title(),
            screenshot: await page.screenshot({ type: 'png', fullPage: true }),
            dom: typeof document.result.value === 'string' ? document.result.value : '',
            logs,
          });
        } finally {
          page.off('console', consoleListener);
        }
      }
      return evidence;
    } finally {
      await stagehand.close();
    }
  }
}

function stagehandModel(config: QAgentConfig['model']): StagehandOptions['model'] {
  if (config.provider === 'openai-compatible') {
    const modelName = config.model.startsWith('openai/') ? config.model : `openai/${config.model}`;
    return {
      modelName,
      apiKey: process.env.OPENAI_API_KEY ?? 'local',
      baseURL: config.baseUrl ?? process.env.QAGENT_OPENAI_BASE_URL ?? 'http://127.0.0.1:11434/v1',
    };
  }

  const prefix = config.provider === 'google' ? 'google' : config.provider;
  const modelName = config.model.startsWith(`${prefix}/`)
    ? config.model
    : `${prefix}/${config.model}`;
  const apiKey =
    config.provider === 'openai'
      ? process.env.OPENAI_API_KEY
      : config.provider === 'anthropic'
        ? process.env.ANTHROPIC_API_KEY
        : process.env.GOOGLE_API_KEY;
  return apiKey ? { modelName, apiKey } : modelName;
}

async function defaultStagehandFactory(options: StagehandOptions): Promise<StagehandSession> {
  const stagehandModule = await import('@browserbasehq/stagehand');
  return new stagehandModule.Stagehand(options) as unknown as StagehandSession;
}
