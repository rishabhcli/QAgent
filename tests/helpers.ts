import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  BrowserEvidence,
  BrowserInstallation,
  ModelCompletion,
  ModelProvider,
  ModelRequest,
} from '@qagent/adapters';
import { StagehandBrowser } from '@qagent/adapters';
import type { BrowserFlow, QAgentConfig } from '@qagent/contracts';
import { chromium } from 'playwright';
import { afterAll } from 'vitest';

const execFileAsync = promisify(execFile);
const temporaryDirectories = new Set<string>();

afterAll(async () => {
  await Promise.all(
    [...temporaryDirectories].map((path) => rm(path, { recursive: true, force: true }))
  );
  temporaryDirectories.clear();
});

export async function temporaryDirectory(prefix = 'qagent-test-'): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(path);
  return path;
}

export async function temporaryFixtureRepository(): Promise<string> {
  const root = await temporaryDirectory('qagent-fixture-');
  const source = resolve(import.meta.dirname, '../fixtures/sample-web-app');
  await cp(source, root, { recursive: true });
  await git(root, ['init', '-b', 'main']);
  await git(root, ['add', '.']);
  await git(root, [
    '-c',
    'user.name=QAgent tests',
    '-c',
    'user.email=tests@qagent.local',
    'commit',
    '-m',
    'fixture baseline',
  ]);
  return root;
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd });
  return result.stdout.trim();
}

export class DeterministicRepairModel implements ModelProvider {
  readonly provider = 'test';
  readonly model = 'deterministic-repair';
  readonly calls: ModelRequest<unknown>[] = [];

  async complete<T>(request: ModelRequest<T>): Promise<ModelCompletion<T>> {
    this.calls.push(request as ModelRequest<unknown>);
    const value =
      request.purpose === 'triage'
        ? {
            summary: 'Counter advances by two',
            rootCause: 'src/counter.mjs adds 2 even though the grounded test requires 1.',
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
    return {
      value: request.schema.parse(value),
      inputTokens: 17,
      outputTokens: 9,
    };
  }
}

export class ChromiumTestBrowser extends StagehandBrowser {
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

export function playwrightBrowserInstallation(): BrowserInstallation {
  return {
    name: 'Playwright Chromium',
    executablePath: chromium.executablePath(),
    source: 'managed',
  };
}

export async function readCounter(repository: string): Promise<string> {
  return readFile(join(repository, 'src/counter.mjs'), 'utf8');
}
