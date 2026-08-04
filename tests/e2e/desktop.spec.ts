import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import AxeBuilder from '@axe-core/playwright';
import {
  StagehandBrowser,
  detectProject,
  writeProjectConfig,
  type BrowserEvidence,
  type BrowserInstallation,
  type ModelCompletion,
  type ModelProvider,
  type ModelRequest,
} from '../../packages/adapters/dist/index.js';
import type { BrowserFlow, QAgentConfig } from '../../packages/contracts/dist/index.js';
import { QAgentEngine } from '../../packages/core/dist/index.js';
import { ArtifactStore, QAgentStorage } from '../../packages/storage/dist/index.js';
import {
  _electron as electron,
  chromium,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test';

const execFileAsync = promisify(execFile);
const temporaryPaths = new Set<string>();

test.afterEach(async () => {
  await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  await Promise.all([...temporaryPaths].map((path) => rm(path, { recursive: true, force: true })));
  temporaryPaths.clear();
});

test('onboards a trusted repository with local-only providers', async ({
  browserName: _browserName,
}, testInfo) => {
  const repository = await fixtureRepository();
  const originalConfig = await readFile(join(repository, '.qagent.yml'), 'utf8');
  const userData = await temporaryDirectory('qagent-electron-onboarding-');
  const modelServer = await startDoctorModelServer();
  const app = await launchDesktop(userData);
  try {
    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
    }, repository);
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Choose a repository.' })).toBeVisible();
    await expect(page.getByText('Waiting for a repository')).toBeVisible();
    expect(
      await page
        .locator('.onboarding-progress > span')
        .first()
        .evaluate(
          (element) => getComputedStyle(element.querySelector('i') as HTMLElement).animationName
        )
    ).toBe('progressScan');
    await expectNoSeriousAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath('onboarding-start.png'), fullPage: true });

    await page.getByRole('button', { name: 'Choose folder' }).click();
    await expect(page.getByRole('heading', { name: 'QAgent sample counter' })).toBeVisible();
    await expect(
      page.locator('.trust-command-list code').filter({
        hasText: '"node" "src/server.mjs"',
      })
    ).toHaveCount(1);
    await expect(
      page.locator('.trust-command-list code').filter({
        hasText: '"node" "--test" "test/counter.test.mjs"',
      })
    ).toHaveCount(2);
    await page.getByLabel('I trust this repository to run every command listed above.').check();
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByLabel('Model provider').selectOption('openai-compatible');
    await page.getByLabel('Model ID').fill('qwen-local');
    await page.getByLabel('Endpoint').fill(modelServer.baseUrl);
    await page.getByLabel('Publication').selectOption('local');
    await page.getByLabel('Send redacted run traces to Weave').uncheck();
    await page.getByRole('button', { name: 'Save and check' }).click();

    await expect(page.getByRole('heading', { name: 'Ready to run.' })).toBeVisible();
    await expect(page.getByText('Ready for the first run')).toBeVisible();
    await expect(page.getByText('Configured browser (configured)', { exact: false })).toBeVisible();
    await expectNoSeriousAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath('onboarding-ready.png'), fullPage: true });
    await page.getByRole('button', { name: 'Open project' }).click();
    await expect(page.getByRole('heading', { name: 'QAgent sample counter' })).toBeVisible();
    await expect(page.getByText('Managed copy')).toBeVisible();
    await expectNoSeriousAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath('onboarding-complete.png'), fullPage: true });

    expect(await readFile(join(repository, '.qagent.yml'), 'utf8')).toBe(originalConfig);
    const managedFiles = await readdir(join(userData, 'projects'));
    expect(managedFiles).toHaveLength(1);
    const written = await readFile(join(userData, 'projects', managedFiles[0]), 'utf8');
    expect(written).toContain('provider: openai-compatible');
    expect(written).toContain('provider: local');
    expect(written).toContain('healthPath: /health');
    expect(written).toContain('maxIterations: 2');
  } finally {
    await app.close();
    await modelServer.close();
  }
});

test('shows a real repaired run with evidence, provenance, and responsive layout', async ({
  browserName: _browserName,
}, testInfo) => {
  const userData = await temporaryDirectory('qagent-electron-evidence-');
  const completed = await seedSuccessfulRun(userData);
  const app = await launchDesktop(userData);
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Runs' }).click();
    await expect(page.locator('.signal-run-frequency')).toContainText(completed.runId.slice(0, 8));
    await expect(page.getByRole('heading', { name: 'Repair verified' })).toBeVisible();
    await expect(page.locator('.run-branch-line')).toContainText('qagent/');
    await expect(page.getByTestId('signal-desk')).toHaveAttribute('data-status', 'succeeded');
    await expect(page.getByTestId('run-console')).toBeVisible();
    await expect(page.getByTestId('evidence-monitor')).toBeVisible();
    await expect(page.getByTestId('specialist-bay')).toBeVisible();
    for (const role of ['scout', 'trace', 'patch', 'proof', 'gate']) {
      await expect(
        page.getByTestId('specialist-bay').locator(`[data-role="${role}"] p`)
      ).not.toHaveText('Awaiting specialist signal');
    }
    await expect(page.getByTestId('specialist-bay')).toContainText('Handoff to Trace');
    await expect(page.getByTestId('specialist-bay')).toContainText('Decision: complete');

    await page.getByRole('tab', { name: 'Dossier' }).click();
    await expect(page.getByRole('heading', { name: 'Counter advances by two' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Increment the counter by one' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Checks passed' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '2 model calls' })).toBeVisible();
    await expect(page.getByText('tokens unavailable')).toHaveCount(0);

    const screenshotButton = page.locator('.screenshot-open').first();
    const screenshot = screenshotButton.locator('img');
    await expect(screenshot).toBeVisible();
    await expect(page.locator('.screenshot-grid img')).toHaveCount(1);
    expect(
      await screenshot.evaluate((image: HTMLImageElement) => image.naturalWidth)
    ).toBeGreaterThan(0);
    await screenshot.click();
    await expect(page.getByRole('dialog', { name: /increment-the-counter-once/i })).toBeVisible();
    const closeArtifact = page.getByRole('button', { name: 'Close artifact' });
    await closeArtifact.press('Tab');
    await expect(closeArtifact).toBeFocused();
    await closeArtifact.click();
    await expect(screenshotButton).toBeFocused();
    await expect(page.locator('.stage.unrecorded').first()).toBeVisible();
    expect(
      await page.evaluate(() => ({
        nodeProcess: typeof globalThis.process,
        requireFunction: typeof globalThis.require,
        bridge: Object.keys(window.qagent).sort(),
      }))
    ).toEqual({
      nodeProcess: 'undefined',
      requireFunction: 'undefined',
      bridge: [
        'credentialStatuses',
        'getPreferences',
        'onEvent',
        'openExternal',
        'request',
        'selectDirectory',
        'setCredential',
        'setPreferences',
      ],
    });

    await resizeWindow(app, 1024, 700);
    await expect(page.getByRole('heading', { name: 'Checks passed' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    expect(
      await page.evaluate(() => {
        const consolePane = document
          .querySelector('[data-testid="run-console"]')
          ?.getBoundingClientRect();
        const evidence = document
          .querySelector('[data-testid="evidence-monitor"]')
          ?.getBoundingClientRect();
        const specialists = document
          .querySelector('[data-testid="specialist-bay"]')
          ?.getBoundingClientRect();
        return Boolean(
          consolePane &&
          evidence &&
          specialists &&
          consolePane.right <= evidence.left &&
          consolePane.bottom <= specialists.top &&
          evidence.bottom <= specialists.top
        );
      })
    ).toBe(true);
    await expectNoSeriousAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath('real-run-compact.png'), fullPage: true });

    await resizeWindow(app, 1440, 1000);
    await page.screenshot({ path: testInfo.outputPath('real-run-large.png') });

    await page.getByRole('button', { name: 'Tests' }).click();
    await expect(page.getByRole('heading', { name: 'Tests' })).toBeVisible();
    await expect(page.locator('.test-row').first()).toBeVisible();
    await expect(page.locator('.test-catalog-signal')).toContainText('Grounded checks');
    await expectNoSeriousAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath('tests-large.png'), fullPage: true });

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.locator('.credential-row')).toHaveCount(6);
    await expect(page.locator('.settings-status-rail')).toBeVisible();
    await expect(page.locator('.status-checking')).toHaveCount(0);
    await expect(page.locator('.trace-section .status-disabled')).toBeVisible();
    await expect(
      page.getByText('Connect W&B Weave above before enabling trace sync.')
    ).toBeVisible();
    await expect(page.getByLabel('Enable redacted traces after connection')).toBeDisabled();
    expect(
      await page
        .locator('.settings-live-line i')
        .evaluate((element) => getComputedStyle(element).animationName)
    ).toBe('none');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await expectNoSeriousAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath('settings-large.png'), fullPage: true });

    await page.getByRole('button', { name: 'Projects' }).click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Choose a repository.' })).toBeVisible();
    await page.getByRole('button', { name: 'Close setup' }).click();
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('surfaces browser and provider outages without simulated readiness', async () => {
  const repository = await fixtureRepository();
  const userData = await temporaryDirectory('qagent-electron-outage-');
  const app = await launchDesktop(userData, {
    OPENAI_API_KEY: '',
    QAGENT_BROWSER_PATH: '/missing/browser',
  });
  try {
    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
    }, repository);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Choose folder' }).click();
    await page.getByLabel('I trust this repository to run every command listed above.').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Model ID').fill('gpt-test');
    await page.getByLabel('Publication').selectOption('local');
    await page.getByLabel('Send redacted run traces to Weave').uncheck();
    await page.getByRole('button', { name: 'Save and check' }).click();

    await expect(page.getByText('OPENAI_API_KEY is not configured')).toBeVisible();
    await expect(
      page.getByText('No Chrome-compatible browser found', { exact: false })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Install managed Chrome' })).toHaveCount(2);
    await expect(
      page.getByRole('button', { name: 'Install managed Chrome' }).first()
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run QA' })).toBeDisabled();
    await expect(page.getByText(/^blocked$/i)).toHaveCount(2);
  } finally {
    await app.close();
  }
});

test('cancels a live command through the desktop utility process', async ({
  browserName: _browserName,
}, testInfo) => {
  const repository = await fixtureRepository();
  const detected = await detectProject(repository);
  if (!detected.config) throw new Error('Fixture configuration was not found');
  detected.config.test.commands = [longCommand()];
  detected.config.test.browserFlows = [];
  detected.config.verify.commands = [longCommand()];
  detected.config.model = {
    provider: 'openai-compatible',
    model: 'unused-during-cancellation',
    baseUrl: 'http://127.0.0.1:11434/v1',
  };
  await writeProjectConfig(repository, detected.config, { force: true });
  await git(repository, ['add', '.qagent.yml']);
  await git(repository, ['commit', '-m', 'configure cancellation fixture']);

  const userData = await temporaryDirectory('qagent-electron-cancel-');
  const storage = new QAgentStorage(join(userData, 'qagent.sqlite'));
  storage.createProject({
    name: 'Cancellation fixture',
    path: repository,
    trusted: true,
    configPath: join(repository, '.qagent.yml'),
  });
  storage.close();

  const app = await launchDesktop(userData);
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Run QA' }).click();
    await expect(page.getByText(/^Run \/ /)).toBeVisible();
    await expect(page.getByTestId('signal-desk')).toHaveAttribute('data-status', 'running');
    await expect(page.getByTestId('run-console')).toBeVisible();
    await expect(page.getByTestId('evidence-monitor')).toBeVisible();
    await expect(page.getByTestId('specialist-bay')).toContainText('Awaiting specialist signal');
    await expect(page.getByRole('list', { name: 'Run stages' })).toBeVisible();
    await expect(page.getByTestId('workspace-splitter')).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByRole('button', { name: 'Toggle refresh effect' })).toBeDisabled();
    expect(
      await page.locator('.run-list').evaluate((element) => getComputedStyle(element).overflowX)
    ).toBe('hidden');
    await page.getByRole('tab', { name: 'Events' }).click();
    expect(
      await page
        .getByLabel('Run activity events')
        .evaluate((element) => getComputedStyle(element).overflowX)
    ).toBe('hidden');
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('agent-working.png'), fullPage: true });
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(
      page.getByText('Runtime settings are locked while a run is active.')
    ).toBeVisible();
    await page.getByLabel('OpenAI credential').fill('test-value');
    await expect(page.getByTitle('Save OpenAI credential')).toBeDisabled();
    await page.getByRole('button', { name: 'Runs' }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByTestId('signal-desk')).toHaveAttribute('data-status', 'cancelled', {
      timeout: 15_000,
    });
    await page.getByRole('tab', { name: 'Events' }).click();
    await expect(
      page
        .getByLabel('Run activity events')
        .getByText('Cancellation requested from desktop')
        .first()
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test('does not persist credentials through the Linux basic_text backend', async () => {
  test.skip(process.platform !== 'linux', 'Linux safeStorage behavior');
  const repository = await fixtureRepository();
  const userData = await temporaryDirectory('qagent-electron-keyring-');
  const storage = new QAgentStorage(join(userData, 'qagent.sqlite'));
  storage.createProject({
    name: 'Keyring fixture',
    path: repository,
    trusted: true,
    configPath: join(repository, '.qagent.yml'),
  });
  storage.close();

  const app = await launchDesktop(userData, {}, ['--password-store=basic']);
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByText('Encrypted credential storage is unavailable.')).toBeVisible();
    await expect(page.getByText(/session-only|unavailable/).first()).toBeVisible();
  } finally {
    await app.close();
  }
});

async function startDoctorModelServer(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl_doctor',
        object: 'chat.completion',
        created: 1,
        model: 'qwen-local',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '{"ready":true}' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      })
    );
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

async function launchDesktop(
  userData: string,
  environment: Record<string, string> = {},
  switches: string[] = []
): Promise<ElectronApplication> {
  return electron.launch({
    args: [resolve('apps/desktop'), ...switches, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      QAGENT_BROWSER_PATH: chromium.executablePath(),
      QAGENT_WEAVE_ENABLED: 'false',
      ...environment,
    },
  });
}

async function seedSuccessfulRun(userData: string): Promise<{ runId: string }> {
  const repository = await fixtureRepository();
  const storage = new QAgentStorage(join(userData, 'qagent.sqlite'));
  const artifacts = new ArtifactStore(join(userData, 'artifacts'), storage);
  const engine = new QAgentEngine({
    storage,
    artifactStore: artifacts,
    qagentHome: userData,
    browser: new FixtureBrowser(),
    browserDetector: async () => browserInstallation(),
    modelProviderFactory: () => new FixtureRepairModel(),
  });
  const project = await engine.addProject(repository, true);
  const result = await (
    await engine.startRun({ projectId: project.id, requestedBy: 'desktop' })
  ).result();
  storage.close();
  expect(result.status).toBe('succeeded');
  return { runId: result.id };
}

class FixtureRepairModel implements ModelProvider {
  readonly provider = 'test';
  readonly model = 'deterministic-repair';

  async complete<T>(request: ModelRequest<T>): Promise<ModelCompletion<T>> {
    const value =
      request.purpose === 'triage'
        ? {
            summary: 'Counter advances by two',
            rootCause: 'src/counter.mjs adds 2 although the grounded check requires 1.',
            confidence: 1,
          }
        : {
            summary: 'Increment the counter by one',
            unifiedDiff: [
              'diff --git a/src/counter.mjs b/src/counter.mjs',
              '--- a/src/counter.mjs',
              '+++ b/src/counter.mjs',
              '@@ -1,4 +1,4 @@',
              ' export function increment(value) {',
              '   // Intentional fixture defect: QAgent should repair this to `value + 1`.',
              '-  return value + 2;',
              '+  return value + 1;',
              ' }',
              '',
            ].join('\n'),
          };
    return { value: request.schema.parse(value), inputTokens: 17, outputTokens: 9 };
  }
}

class FixtureBrowser extends StagehandBrowser {
  override async runFlows(options: {
    config: QAgentConfig;
    browser: BrowserInstallation;
    targetUrl: string;
    flows: BrowserFlow[];
    signal?: AbortSignal;
  }): Promise<BrowserEvidence[]> {
    const browser = await chromium.launch({
      executablePath: options.browser.executablePath,
      headless: true,
    });
    try {
      const page = await browser.newPage();
      const evidence: BrowserEvidence[] = [];
      for (const flow of options.flows) {
        if (options.signal?.aborted) throw options.signal.reason;
        const logs: string[] = [];
        page.on('console', (message) => logs.push(`[${message.type()}] ${message.text()}`));
        await page.goto(options.targetUrl, { waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: 'Increment' }).click();
        evidence.push({
          flow: flow.name,
          url: page.url(),
          title: await page.title(),
          screenshot: await page.screenshot({ fullPage: true }),
          dom: await page.content(),
          logs,
        });
      }
      return evidence;
    } finally {
      await browser.close();
    }
  }
}

function browserInstallation(): BrowserInstallation {
  return {
    name: 'Playwright Chromium',
    executablePath: chromium.executablePath(),
    source: 'managed',
  };
}

function longCommand() {
  return {
    executable: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 60000)'],
    cwd: '.',
    env: {},
    timeoutMs: 120_000,
  };
}

async function fixtureRepository(): Promise<string> {
  const root = await temporaryDirectory('qagent-electron-fixture-');
  await cp(resolve('fixtures/sample-web-app'), root, { recursive: true });
  const configPath = join(root, '.qagent.yml');
  const config = await readFile(configPath, 'utf8');
  await writeFile(configPath, config.replaceAll('41773', String(await availableLoopbackPort())));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'fixture baseline']);
  return root;
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return port;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.add(path);
  return path;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync(
    'git',
    ['-c', 'user.name=QAgent tests', '-c', 'user.email=tests@qagent.local', ...args],
    { cwd }
  );
}

async function resizeWindow(
  app: ElectronApplication,
  width: number,
  height: number
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height),
    { width, height }
  );
}

async function expectNoSeriousAccessibilityViolations(
  page: Awaited<ReturnType<ElectronApplication['firstWindow']>>
) {
  const results = await new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? '')
    )
  ).toEqual([]);
}
