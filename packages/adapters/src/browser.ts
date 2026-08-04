import { constants as fsConstants } from 'node:fs';
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
import OpenAI from 'openai';
import { validateOpenAICompatibleBaseUrl } from './model.js';

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
  session?: BrowserSessionMetadata;
}

export interface BrowserSessionMetadata {
  provider: 'local' | 'browserbase';
  browserName?: string;
  browserSource?: BrowserInstallation['source'];
  sessionId?: string;
  sessionUrl?: string;
  liveViewUrl?: string;
  liveViewAvailable: boolean;
}

export interface BrowserbaseProjectProbe {
  id: string;
  capturedAt: string;
}

export interface BrowserFailureEvidence {
  flow: string;
  url?: string;
  screenshot?: Uint8Array;
  title?: string;
  dom?: string;
  logs: string[];
  error: string;
  session: BrowserSessionMetadata;
}

export class BrowserFlowError extends Error {
  readonly evidence: BrowserFailureEvidence;

  constructor(message: string, evidence: BrowserFailureEvidence) {
    super(message);
    this.name = 'BrowserFlowError';
    this.evidence = evidence;
  }
}

export class BrowserModelProviderError extends BrowserFlowError {
  constructor(message: string, evidence: BrowserFailureEvidence) {
    super(message, evidence);
    this.name = 'BrowserModelProviderError';
  }
}

export class BrowserModelOutputError extends BrowserFlowError {
  constructor(message: string, evidence: BrowserFailureEvidence) {
    super(message, evidence);
    this.name = 'BrowserModelOutputError';
  }
}

export class BrowserOperationTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'BrowserOperationTimeoutError';
  }
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
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout?: number }): Promise<unknown>;
  sendCDP(
    method: 'Runtime.evaluate',
    options: { expression: string; returnByValue: true }
  ): Promise<{ result?: { value?: unknown }; exceptionDetails?: unknown }>;
  url(): string;
  title(): Promise<string>;
  screenshot(options: { type: 'png'; fullPage: true }): Promise<Uint8Array>;
}

interface StagehandActResult {
  success: boolean;
  message: string;
  actionDescription: string;
  actions: unknown[];
}

interface StagehandSession {
  context: {
    pages(): StagehandPage[];
    newPage(): Promise<StagehandPage>;
  };
  readonly browserbaseSessionID?: string;
  readonly browserbaseSessionURL?: string;
  readonly browserbaseDebugURL?: string;
  init(): Promise<unknown>;
  act(step: string, options?: { timeout?: number }): Promise<StagehandActResult>;
  close(): Promise<unknown>;
}

interface StagehandOptions {
  env: 'LOCAL' | 'BROWSERBASE';
  apiKey?: string;
  projectId?: string;
  browserbaseSessionCreateParams?: {
    projectId: string;
    timeout: number;
  };
  actTimeoutMs: number;
  disablePino: boolean;
  disableAPI: boolean;
  verbose: 0;
  model:
    | string
    | {
        modelName: string;
        apiKey?: string;
        baseURL?: string;
      };
  openAICompatible?: {
    modelName: string;
    apiKey: string;
    baseURL: string;
  };
  localBrowserLaunchOptions?: {
    executablePath: string;
    headless: boolean;
  };
}

type StagehandConsoleListener = (message: { type(): string; text(): string }) => void;

export type StagehandFactory = (options: StagehandOptions) => Promise<StagehandSession>;

interface StagehandModelSelection {
  model: StagehandOptions['model'];
  openAICompatible?: StagehandOptions['openAICompatible'];
}

class StagehandModelFailure extends Error {
  readonly reason: 'invalid_model_output' | 'provider_outage';

  constructor(reason: 'invalid_model_output' | 'provider_outage', error: unknown) {
    super(browserErrorMessage(error));
    this.name = 'StagehandModelFailure';
    this.reason = reason;
  }
}

const defaultDependencies: BrowserAdapterDependencies = {
  access: fsAccess,
  platform: osPlatform,
  homedir: osHomedir,
  detectBrowserPlatform,
  resolveBuildId,
  computeExecutablePath,
  install,
};

const DEFAULT_BROWSER_TIMEOUT_MS = 120_000;
const MAX_BROWSER_TIMEOUT_MS = 21_600_000;
const BROWSERBASE_MIN_SESSION_TIMEOUT_SECONDS = 60;
const BROWSERBASE_MAX_SESSION_TIMEOUT_SECONDS = 21_600;
const FAILURE_CAPTURE_TIMEOUT_MS = 2_500;
const CLOSE_TIMEOUT_MS = 5_000;
const MAX_CONSOLE_ENTRIES = 200;
const MAX_CONSOLE_ENTRY_LENGTH = 4_096;
const MAX_BROWSERBASE_RESPONSE_BYTES = 1_000_000;
const BROWSER_SECRET_ASSIGNMENT =
  /((?:api[-_]?key|token|secret|password|passwd|authorization|cookie|credential)\s*[:=]\s*)(["']?)[^\s,;"']+\2/gi;
const BROWSER_SECRET_VALUE =
  /(bearer\s+)[a-z0-9._~+/=-]+|(?:sk|rk|pk|gh[pousr])[-_][a-z0-9_-]{8,}/gi;
const BROWSER_URL_SECRET =
  /([?&](?:access_token|api_key|apikey|authorization|password|secret|token)=)[^&#\s]+/gi;
const BROWSER_URL_BASIC_AUTH = /(https?:\/\/)[^/\s@]+:[^/\s@]*@/gi;
const BROWSER_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const BROWSER_REDACTED = '[REDACTED]';
const SECRET_ENVIRONMENT_KEYS = [
  'BROWSERBASE_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
] as const;

function dependencies(
  overrides: Partial<BrowserAdapterDependencies> = {}
): BrowserAdapterDependencies {
  return { ...defaultDependencies, ...overrides };
}

async function executable(path: string, access: typeof fsAccess): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
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

export async function probeBrowserbaseProject(
  apiKey: string,
  projectId: string,
  signal?: AbortSignal,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch
): Promise<BrowserbaseProjectProbe> {
  const key = browserbaseProbeValue(apiKey, 'API key');
  const project = browserbaseProbeValue(projectId, 'project ID');
  const timeoutSignal = AbortSignal.timeout(15_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetchImplementation(
    `https://api.browserbase.com/v1/projects/${encodeURIComponent(project)}`,
    {
      headers: { 'X-BB-API-Key': key },
      redirect: 'error',
      signal: requestSignal,
    }
  );
  if (!response.ok) throw new Error(`Browserbase project probe returned HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BROWSERBASE_RESPONSE_BYTES) {
    throw new Error('Browserbase project response exceeded the size limit');
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('Browserbase project probe returned invalid JSON');
  }
  if (!body || typeof body !== 'object' || !('id' in body) || body.id !== project) {
    throw new Error('Browserbase did not confirm access to the configured project ID');
  }
  return { id: project, capturedAt: new Date().toISOString() };
}

export class StagehandBrowser {
  constructor(private readonly factory: StagehandFactory = defaultStagehandFactory) {}

  async runFlows(options: {
    config: QAgentConfig;
    browser?: BrowserInstallation;
    targetUrl: string;
    flows: BrowserFlow[];
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<BrowserEvidence[]> {
    if (options.flows.length === 0) return [];
    const timeoutMs = browserTimeout(options.timeoutMs);
    const deadline = Date.now() + timeoutMs;
    const provider = options.config.browser.provider;
    const configuredSession = configuredSessionMetadata(provider, options.browser);
    const modelSelection = stagehandModel(options.config.model);
    const stagehandOptions: StagehandOptions = {
      env: provider === 'browserbase' ? 'BROWSERBASE' : 'LOCAL',
      model: modelSelection.model,
      actTimeoutMs: timeoutMs,
      disablePino: true,
      disableAPI: true,
      verbose: 0,
    };
    if (modelSelection.openAICompatible) {
      stagehandOptions.openAICompatible = modelSelection.openAICompatible;
    }
    if (provider === 'browserbase') {
      const apiKey = requiredBrowserbaseCredential('BROWSERBASE_API_KEY');
      const projectId = requiredBrowserbaseCredential('BROWSERBASE_PROJECT_ID');
      stagehandOptions.apiKey = apiKey;
      stagehandOptions.projectId = projectId;
      stagehandOptions.browserbaseSessionCreateParams = {
        projectId,
        timeout: browserbaseSessionTimeoutSeconds(timeoutMs),
      };
    } else {
      if (!options.browser) {
        throw new Error('Local browser mode requires a discovered or managed Chrome executable');
      }
      stagehandOptions.localBrowserLaunchOptions = {
        executablePath: options.browser.executablePath,
        headless: options.config.browser.headless,
      };
    }

    let stagehand: StagehandSession | undefined;
    let session = configuredSession;
    let evidence: BrowserEvidence[] | undefined;
    let failure: Error | undefined;
    try {
      stagehand = await withinDeadline('Stagehand construction', deadline, options.signal, () =>
        this.factory(stagehandOptions)
      );
      await withinDeadline('Browser initialization', deadline, options.signal, () =>
        stagehand!.init()
      );
      session = activeSessionMetadata(provider, options.browser, stagehand);
      const page =
        stagehand.context.pages()[0] ??
        (await withinDeadline('Browser page creation', deadline, options.signal, () =>
          stagehand!.context.newPage()
        ));
      const capturedEvidence: BrowserEvidence[] = [];
      for (const flow of options.flows) {
        const logs: string[] = [];
        const consoleListener: StagehandConsoleListener = (message) => {
          if (logs.length >= MAX_CONSOLE_ENTRIES) return;
          logs.push(
            redactBrowserText(`[${message.type()}] ${message.text()}`).slice(
              0,
              MAX_CONSOLE_ENTRY_LENGTH
            )
          );
        };
        page.on('console', consoleListener);
        try {
          await withinDeadline('Browser navigation', deadline, options.signal, () =>
            page.goto(options.targetUrl, {
              waitUntil: 'domcontentloaded',
              timeout: remainingMilliseconds(deadline, 'Browser navigation'),
            })
          );
          for (const step of flow.steps) {
            const result = await withinDeadline('Browser action', deadline, options.signal, () =>
              stagehand!.act(step, {
                timeout: remainingMilliseconds(deadline, 'Browser action'),
              })
            );
            assertSuccessfulAction(result);
          }
          capturedEvidence.push(
            await captureSuccessfulEvidence({
              flow: flow.name,
              page,
              logs,
              session,
              deadline,
              signal: options.signal,
            })
          );
        } catch (error) {
          if (options.signal?.aborted) throw abortReason(options.signal);
          const message = browserErrorMessage(error);
          const failureEvidence = await captureFailureEvidence({
            flow: flow.name,
            page,
            logs,
            error: message,
            session,
          });
          const failureMessage = `Browser flow "${flow.name}" failed: ${message}`;
          const modelFailureReason = stagehandModelFailureReason(error);
          if (modelFailureReason) {
            throw modelFailureReason === 'invalid_model_output'
              ? new BrowserModelOutputError(failureMessage, failureEvidence)
              : new BrowserModelProviderError(failureMessage, failureEvidence);
          }
          throw new BrowserFlowError(failureMessage, failureEvidence);
        } finally {
          page.off('console', consoleListener);
        }
      }
      evidence = capturedEvidence;
    } catch (error) {
      if (options.signal?.aborted) {
        failure = abortReason(options.signal);
      } else if (error instanceof BrowserFlowError) {
        failure = error;
      } else {
        const message = browserErrorMessage(error);
        const failureEvidence: BrowserFailureEvidence = {
          flow: 'initialization',
          logs: [],
          error: message,
          session,
        };
        const modelFailureReason = stagehandModelFailureReason(error);
        failure =
          modelFailureReason === 'invalid_model_output'
            ? new BrowserModelOutputError(
                `Browser model initialization returned invalid output: ${message}`,
                failureEvidence
              )
            : modelFailureReason === 'provider_outage'
              ? new BrowserModelProviderError(
                  `Browser model initialization failed: ${message}`,
                  failureEvidence
                )
              : new BrowserFlowError(`Browser initialization failed: ${message}`, failureEvidence);
      }
    } finally {
      if (stagehand) {
        try {
          await boundedOperation('Browser close', CLOSE_TIMEOUT_MS, undefined, () =>
            stagehand!.close()
          );
        } catch (error) {
          if (!failure) {
            const message = browserErrorMessage(error);
            failure = new BrowserFlowError(`Browser cleanup failed: ${message}`, {
              flow: 'cleanup',
              logs: [],
              error: message,
              session,
            });
          }
        }
      }
    }
    if (failure) throw failure;
    return evidence ?? [];
  }
}

function browserTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_BROWSER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_BROWSER_TIMEOUT_MS) {
    throw new Error(
      `Browser timeout must be a positive integer no greater than ${MAX_BROWSER_TIMEOUT_MS}ms`
    );
  }
  return timeoutMs;
}

function browserbaseSessionTimeoutSeconds(timeoutMs: number): number {
  return Math.min(
    BROWSERBASE_MAX_SESSION_TIMEOUT_SECONDS,
    Math.max(BROWSERBASE_MIN_SESSION_TIMEOUT_SECONDS, Math.ceil(timeoutMs / 1_000))
  );
}

function requiredBrowserbaseCredential(
  name: 'BROWSERBASE_API_KEY' | 'BROWSERBASE_PROJECT_ID'
): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Browserbase mode requires ${name}`);
  return value;
}

function browserbaseProbeValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed !== value ||
    trimmed.length > 4_096 ||
    [...trimmed].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new Error(`Browserbase ${label} is invalid`);
  }
  return trimmed;
}

function configuredSessionMetadata(
  provider: QAgentConfig['browser']['provider'],
  browser: BrowserInstallation | undefined
): BrowserSessionMetadata {
  if (provider === 'local') {
    return {
      provider,
      browserName: browser?.name,
      browserSource: browser?.source,
      liveViewAvailable: false,
    };
  }
  return { provider, liveViewAvailable: false };
}

function activeSessionMetadata(
  provider: QAgentConfig['browser']['provider'],
  browser: BrowserInstallation | undefined,
  stagehand: StagehandSession
): BrowserSessionMetadata {
  if (provider === 'local') return configuredSessionMetadata(provider, browser);
  const sessionId = stagehand.browserbaseSessionID;
  if (!sessionId || !/^[A-Za-z0-9_-]{1,256}$/.test(sessionId)) {
    throw new Error('Browserbase initialized without a valid session identifier');
  }
  const sessionUrl = safeBrowserbaseUrl(stagehand.browserbaseSessionURL, 'Browserbase session URL');
  const liveViewUrl = stagehand.browserbaseDebugURL
    ? safeBrowserbaseUrl(stagehand.browserbaseDebugURL, 'Browserbase live-view URL')
    : undefined;
  return {
    provider,
    sessionId,
    sessionUrl,
    liveViewUrl,
    liveViewAvailable: Boolean(liveViewUrl),
  };
}

function safeBrowserbaseUrl(value: string | undefined, name: string): string {
  if (!value || value.length > 4_096) throw new Error(`${name} was unavailable or invalid`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} was unavailable or invalid`);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (hostname !== 'browserbase.com' && !hostname.endsWith('.browserbase.com')) ||
    includesProviderCredential(url.toString())
  ) {
    throw new Error(`${name} was unavailable or invalid`);
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

function includesProviderCredential(value: string): boolean {
  return redactBrowserTextWithCount(value).replacementCount > 0;
}

function assertSuccessfulAction(value: StagehandActResult): void {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.success !== 'boolean' ||
    typeof value.message !== 'string' ||
    typeof value.actionDescription !== 'string' ||
    !Array.isArray(value.actions)
  ) {
    throw new Error('Stagehand returned an invalid action result');
  }
  if (!value.success) {
    throw new Error(
      value.message
        ? `Stagehand action was not successful: ${value.message}`
        : 'Stagehand action failed'
    );
  }
}

async function captureSuccessfulEvidence(options: {
  flow: string;
  page: StagehandPage;
  logs: string[];
  session: BrowserSessionMetadata;
  deadline: number;
  signal?: AbortSignal;
}): Promise<BrowserEvidence> {
  const document = await withinDeadline(
    'Browser DOM capture',
    options.deadline,
    options.signal,
    () =>
      options.page.sendCDP('Runtime.evaluate', {
        expression: 'document.documentElement.outerHTML',
        returnByValue: true,
      })
  );
  if (document.exceptionDetails || typeof document.result?.value !== 'string') {
    throw new Error('Chrome DevTools Protocol did not return a serialized DOM');
  }
  const title = await withinDeadline(
    'Browser title capture',
    options.deadline,
    options.signal,
    () => options.page.title()
  );
  const screenshot = await withinDeadline(
    'Browser screenshot capture',
    options.deadline,
    options.signal,
    () => options.page.screenshot({ type: 'png', fullPage: true })
  );
  if (!(screenshot instanceof Uint8Array) || screenshot.byteLength === 0) {
    throw new Error('Browser screenshot capture returned no image data');
  }
  return {
    flow: options.flow,
    url: redactBrowserText(safePageUrl(options.page)),
    title: redactBrowserText(title),
    screenshot,
    dom: redactBrowserText(document.result.value),
    logs: [...options.logs],
    session: redactBrowserValue(options.session),
  };
}

async function captureFailureEvidence(options: {
  flow: string;
  page: StagehandPage;
  logs: string[];
  error: string;
  session: BrowserSessionMetadata;
}): Promise<BrowserFailureEvidence> {
  const evidence: BrowserFailureEvidence = {
    flow: options.flow,
    logs: [...options.logs],
    error: redactBrowserText(options.error),
    session: redactBrowserValue(options.session),
  };
  try {
    evidence.url = redactBrowserText(safePageUrl(options.page));
  } catch {
    // Failure evidence is best-effort and must not mask the provider error.
  }
  const title = await bestEffortCapture(() => options.page.title());
  evidence.title = title === undefined ? undefined : redactBrowserText(title);
  const document = await bestEffortCapture(() =>
    options.page.sendCDP('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true,
    })
  );
  if (!document?.exceptionDetails && typeof document?.result?.value === 'string') {
    evidence.dom = redactBrowserText(document.result.value);
  }
  const screenshot = await bestEffortCapture(() =>
    options.page.screenshot({ type: 'png', fullPage: true })
  );
  if (screenshot instanceof Uint8Array && screenshot.byteLength > 0) {
    evidence.screenshot = screenshot;
  }
  return evidence;
}

async function bestEffortCapture<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await boundedOperation(
      'Browser failure evidence capture',
      FAILURE_CAPTURE_TIMEOUT_MS,
      undefined,
      operation
    );
  } catch {
    return undefined;
  }
}

function safePageUrl(page: StagehandPage): string {
  const value = page.url();
  if (!value || value.length > 4_096)
    throw new Error('Browser page URL was unavailable or invalid');
  return value;
}

function remainingMilliseconds(deadline: number, operation: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new BrowserOperationTimeoutError(operation, 0);
  return remaining;
}

async function withinDeadline<T>(
  operation: string,
  deadline: number,
  signal: AbortSignal | undefined,
  task: () => Promise<T>
): Promise<T> {
  return boundedOperation(operation, remainingMilliseconds(deadline, operation), signal, task);
}

async function boundedOperation<T>(
  operation: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  task: () => Promise<T>
): Promise<T> {
  if (signal?.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortReason(signal!)));
    const timer = setTimeout(
      () => finish(() => reject(new BrowserOperationTimeoutError(operation, timeoutMs))),
      timeoutMs
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(task)
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error))
      );
  });
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (typeof signal.reason === 'string' && signal.reason) return new Error(signal.reason);
  return new Error('Browser operation cancelled');
}

function browserErrorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown browser provider failure';
  return stripControlCharacters(redactBrowserText(message)).slice(0, 4_096);
}

function stripControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    result += code <= 31 || code === 127 ? ' ' : character;
  }
  return result;
}

function redactBrowserText(value: string): string {
  return redactBrowserTextWithCount(value).text;
}

function redactBrowserValue<T>(value: T): T {
  if (typeof value === 'string') return redactBrowserText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactBrowserValue(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactBrowserValue(child)])
    ) as T;
  }
  return value;
}

function redactBrowserTextWithCount(value: string): {
  text: string;
  replacementCount: number;
} {
  let text = value;
  let replacementCount = 0;
  const replace = (
    pattern: RegExp,
    replacement: string | ((...args: string[]) => string)
  ): void => {
    text = text.replace(pattern, (...args: string[]) => {
      replacementCount += 1;
      return typeof replacement === 'string' ? replacement : replacement(...args);
    });
  };
  replace(BROWSER_PRIVATE_KEY, BROWSER_REDACTED);
  replace(BROWSER_URL_BASIC_AUTH, (_match, scheme: string) => `${scheme}${BROWSER_REDACTED}@`);
  replace(BROWSER_URL_SECRET, (_match, prefix: string) => `${prefix}${BROWSER_REDACTED}`);
  replace(BROWSER_SECRET_VALUE, (_match, bearerPrefix?: string) =>
    bearerPrefix ? `${bearerPrefix}${BROWSER_REDACTED}` : BROWSER_REDACTED
  );
  replace(BROWSER_SECRET_ASSIGNMENT, (_match, prefix: string) => `${prefix}${BROWSER_REDACTED}`);
  for (const secret of browserSecretVariants()) {
    if (!text.includes(secret)) continue;
    const pieces = text.split(secret);
    replacementCount += pieces.length - 1;
    text = pieces.join(BROWSER_REDACTED);
  }
  return { text, replacementCount };
}

function browserSecretVariants(): string[] {
  const secretValues = new Set<string>();
  for (const name of SECRET_ENVIRONMENT_KEYS) {
    const secret = process.env[name];
    if (!secret || secret.length < 4) continue;
    secretValues.add(secret);
    if (secret.length < 8) continue;
    const encoded = encodeURIComponent(secret);
    secretValues.add(encoded);
    secretValues.add(new URLSearchParams([['value', secret]]).toString().slice('value='.length));
    const base64 = Buffer.from(secret).toString('base64');
    secretValues.add(base64);
    secretValues.add(base64.replace(/=+$/u, ''));
    secretValues.add(Buffer.from(secret).toString('base64url'));
  }
  return [...secretValues].sort((left, right) => right.length - left.length);
}

function stagehandModel(config: QAgentConfig['model']): StagehandModelSelection {
  if (config.provider === 'openai-compatible') {
    const modelName = config.model.startsWith('openai/') ? config.model : `openai/${config.model}`;
    const apiKey = process.env.OPENAI_API_KEY ?? 'local';
    const baseURL = validateOpenAICompatibleBaseUrl(
      config.baseUrl ?? process.env.QAGENT_OPENAI_BASE_URL ?? 'http://127.0.0.1:11434/v1'
    );
    return {
      model: modelName,
      openAICompatible: { modelName: config.model, apiKey, baseURL },
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
  return { model: apiKey ? { modelName, apiKey } : modelName };
}

async function defaultStagehandFactory(options: StagehandOptions): Promise<StagehandSession> {
  const stagehandModule = await import('@browserbasehq/stagehand');
  const isStructuredOutputError = (error: unknown): boolean =>
    error instanceof stagehandModule.CreateChatCompletionResponseError ||
    error instanceof stagehandModule.ZodSchemaValidationError ||
    error instanceof stagehandModule.LLMResponseError;
  const { openAICompatible, ...stagehandOptions } = options;
  if (!openAICompatible) {
    return instrumentStagehandSession(
      new stagehandModule.Stagehand(stagehandOptions) as unknown as StagehandSession,
      isStructuredOutputError
    );
  }
  const client = new OpenAI({
    apiKey: openAICompatible.apiKey,
    baseURL: openAICompatible.baseURL,
    timeout: options.actTimeoutMs,
    maxRetries: 0,
  });
  const llmClient = new stagehandModule.CustomOpenAIClient({
    modelName: openAICompatible.modelName,
    client: client as never,
  });
  instrumentOpenAICompatibleClient(llmClient, isStructuredOutputError);
  return instrumentStagehandSession(
    new stagehandModule.Stagehand({
      ...stagehandOptions,
      llmClient,
    }) as unknown as StagehandSession,
    isStructuredOutputError
  );
}

function instrumentOpenAICompatibleClient<T extends object>(
  client: T,
  isStructuredOutputError: (error: unknown) => boolean
): T {
  const createChatCompletion = Reflect.get(client, 'createChatCompletion');
  if (typeof createChatCompletion !== 'function') {
    throw new Error('Stagehand compatible model client is missing createChatCompletion');
  }
  Object.defineProperty(client, 'createChatCompletion', {
    configurable: true,
    value: async (...args: unknown[]) => {
      try {
        return await Reflect.apply(createChatCompletion, client, args);
      } catch (error) {
        if (error instanceof StagehandModelFailure) throw error;
        throw new StagehandModelFailure(
          isStructuredOutputError(error) ? 'invalid_model_output' : 'provider_outage',
          error
        );
      }
    },
  });
  return client;
}

function instrumentStagehandSession(
  session: StagehandSession,
  isStructuredOutputError: (error: unknown) => boolean
): StagehandSession {
  const act = session.act;
  session.act = async (...args: Parameters<StagehandSession['act']>) => {
    try {
      return await Reflect.apply(act, session, args);
    } catch (error) {
      if (error instanceof StagehandModelFailure) throw error;
      const reason = isStructuredOutputError(error)
        ? 'invalid_model_output'
        : stagehandModelFailureReason(error);
      if (reason) throw new StagehandModelFailure(reason, error);
      throw error;
    }
  };
  return session;
}

function stagehandModelFailureReason(
  error: unknown
): 'invalid_model_output' | 'provider_outage' | null {
  if (error instanceof StagehandModelFailure) return error.reason;
  if (hasAiSdkErrorMarker(error, 'AI_NoObjectGeneratedError')) {
    return 'invalid_model_output';
  }
  if (
    hasAiSdkErrorMarker(error, 'AI_TypeValidationError') ||
    hasAiSdkErrorMarker(error, 'AI_JSONParseError') ||
    hasAiSdkErrorMarker(error, 'AI_InvalidResponseDataError') ||
    hasAiSdkErrorMarker(error, 'AI_EmptyResponseBodyError')
  ) {
    return 'invalid_model_output';
  }
  if (
    hasAiSdkErrorMarker(error, 'AI_APICallError') ||
    hasAiSdkErrorMarker(error, 'AI_LoadAPIKeyError') ||
    hasAiSdkErrorMarker(error, 'AI_NoSuchModelError') ||
    hasAiSdkErrorMarker(error, 'AI_NoSuchProviderError') ||
    hasAiSdkErrorMarker(error, 'AI_UnsupportedModelVersionError')
  ) {
    return 'provider_outage';
  }
  if (hasAiSdkErrorMarker(error, 'AI_RetryError')) {
    const retryErrors = retryErrorCauses(error);
    for (let index = retryErrors.length - 1; index >= 0; index -= 1) {
      const reason = stagehandModelFailureReason(retryErrors[index]);
      if (reason) return reason;
    }
    return null;
  }
  if (isKnownProviderSdkError(error)) {
    return 'provider_outage';
  }
  return null;
}

function isKnownProviderSdkError(error: unknown): boolean {
  if (error instanceof OpenAI.APIError) return true;
  if (!error || typeof error !== 'object') return false;
  const constructorName = Reflect.get(Reflect.getPrototypeOf(error) ?? {}, 'constructor')?.name;
  if (
    constructorName === 'ApiError' &&
    Reflect.get(error, 'name') === 'ApiError' &&
    typeof Reflect.get(error, 'status') === 'number'
  ) {
    return true;
  }
  if (
    !new Set([
      'APIError',
      'APIConnectionError',
      'APIConnectionTimeoutError',
      'APIUserAbortError',
      'AuthenticationError',
      'BadRequestError',
      'ConflictError',
      'InternalServerError',
      'NotFoundError',
      'PermissionDeniedError',
      'RateLimitError',
      'RetryableError',
      'UnprocessableEntityError',
    ]).has(constructorName)
  ) {
    return false;
  }
  return (
    Object.hasOwn(error, 'status') &&
    Object.hasOwn(error, 'headers') &&
    Object.hasOwn(error, 'error') &&
    (Object.hasOwn(error, 'request_id') ||
      Object.hasOwn(error, 'requestID') ||
      Object.hasOwn(error, 'type'))
  );
}

function hasAiSdkErrorMarker(error: unknown, marker: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    Reflect.get(error, Symbol.for(`vercel.ai.error.${marker}`)) === true
  );
}

function retryErrorCauses(error: unknown): unknown[] {
  if (!error || typeof error !== 'object') return [];
  const errors = Reflect.get(error, 'errors');
  if (Array.isArray(errors)) return errors;
  const lastError = Reflect.get(error, 'lastError');
  return lastError === undefined ? [] : [lastError];
}
