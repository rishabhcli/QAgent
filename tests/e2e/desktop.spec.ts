import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
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
  await Promise.all([...temporaryPaths].map((path) => rm(path, { recursive: true, force: true })));
  temporaryPaths.clear();
});

test('onboards a trusted repository with local-only providers', async ({
  browserName: _browserName,
}, testInfo) => {
  const repository = await fixtureRepository();
  const userData = await temporaryDirectory('qagent-electron-onboarding-');
  const app = await launchDesktop(userData);
  try {
    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
    }, repository);
    const page = await app.firstWindow();
    await expect(
      page.getByRole('heading', { name: 'Choose the project QAgent will inspect.' })
    ).toBeVisible();

    await page.getByRole('button', { name: 'Choose folder' }).click();
    await expect(page.getByRole('heading', { name: 'QAgent sample counter' })).toBeVisible();
    await page.getByLabel('I trust this repository to run the commands shown above.').check();
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByLabel('Model provider').selectOption('openai-compatible');
    await page.getByLabel('Model ID').fill('qwen-local');
    await page.getByLabel('Publication').selectOption('local');
    await page.getByLabel('Send redacted run traces to Weave').uncheck();
    await page.getByRole('button', { name: 'Save and check' }).click();

    await expect(page.getByRole('heading', { name: 'Local checks are complete.' })).toBeVisible();
    await expect(page.getByText('Configured browser (configured)', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Open project' }).click();
    await expect(page.getByRole('heading', { name: 'QAgent sample counter' })).toBeVisible();
    await expectNoSeriousAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath('onboarding-complete.png'), fullPage: true });

    const written = await readFile(join(repository, '.qagent.yml'), 'utf8');
    expect(written).toContain('provider: openai-compatible');
    expect(written).toContain('provider: local');
  } finally {
    await app.close();
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
    await expect(page.getByText(completed.runId.slice(0, 8), { exact: false })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Repair verified on local branch/ })
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Counter advances by two' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Increment the counter by one' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Checks passed' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '2 model calls' })).toBeVisible();
    await expect(page.getByText('tokens unavailable')).toHaveCount(0);

    const screenshot = page.locator('.screenshot-grid img').first();
    await expect(screenshot).toBeVisible();
    expect(
      await screenshot.evaluate((image: HTMLImageElement) => image.naturalWidth)
    ).toBeGreaterThan(0);
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
    await expectNoSeriousAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath('real-run-compact.png'), fullPage: true });

    await resizeWindow(app, 1440, 1000);
    await page.screenshot({ path: testInfo.outputPath('real-run-large.png'), fullPage: true });
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
    await page.getByLabel('I trust this repository to run the commands shown above.').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Model ID').fill('gpt-test');
    await page.getByLabel('Publication').selectOption('local');
    await page.getByLabel('Send redacted run traces to Weave').uncheck();
    await page.getByRole('button', { name: 'Save and check' }).click();

    await expect(page.getByText('OPENAI_API_KEY is not configured')).toBeVisible();
    await expect(
      page.getByText('No Chrome-compatible browser found', { exact: false })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Install managed Chrome' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run QA' })).toBeDisabled();
    await expect(page.getByText(/^blocked$/i)).toHaveCount(2);
  } finally {
    await app.close();
  }
});

test('cancels a live command through the desktop utility process', async () => {
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
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.status-cancelled')).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByText('Cancellation requested from desktop')).toBeVisible();
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
  const engine = new QAgentEngine({
    storage,
    artifactStore: new ArtifactStore(join(userData, 'artifacts'), storage),
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
  await git(root, ['init', '-b', 'main']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'fixture baseline']);
  return root;
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
