import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { RunStatus } from '../../packages/contracts/dist/index.js';
import { ArtifactStore, QAgentStorage } from '../../packages/storage/dist/index.js';
import { chromium, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  bootstrap,
  cleanupWorkflowFixtures,
  fixtureRepository,
  git,
  launchDesktop,
  temporaryDirectory,
} from './desktop-workflow-harness.js';

type CockpitState =
  'active' | 'policy_blocked' | 'failed' | 'cancelled' | 'succeeded' | 'missing-evidence';

interface SeededRun {
  id: string;
  status: RunStatus;
}

interface SeededCockpit {
  runs: Record<CockpitState, SeededRun>;
}

const localProvenance = () => ({
  source: 'local' as const,
  capturedAt: new Date().toISOString(),
});

test.describe('QAgent Signal Desk', () => {
  test.setTimeout(120_000);

  test.afterEach(async () => {
    await cleanupWorkflowFixtures();
  });

  test('renders durable run states, real evidence, compact geometry, and accessible controls', async ({
    browserName: _browserName,
  }, testInfo) => {
    const userData = await temporaryDirectory('qagent-signal-desk-');
    const seeded = await seedCockpit(userData);
    const app = await launchDesktop(userData);

    try {
      const page = await app.firstWindow();
      await bootstrap(page);
      seeded.runs.active = await seedActiveRun(userData);
      await page.reload();
      await page.getByRole('button', { name: 'Runs' }).click();

      for (const hook of [
        'signal-desk',
        'instrument-dock',
        'workspace-splitter',
        'run-console',
        'evidence-monitor',
        'specialist-bay',
      ]) {
        await expect(page.getByTestId(hook)).toBeVisible();
      }

      await selectRun(page, seeded.runs.active);
      await expect(
        page.getByTestId('signal-desk').getByRole('button', { name: 'Cancel', exact: true })
      ).toBeVisible();
      await expect(page.getByTestId('run-console')).toContainText('pnpm');
      await expect(page.getByTestId('run-console')).toContainText('stdout');
      await expect(page.getByTestId('specialist-bay')).toContainText(
        'Inspecting persisted browser checkpoints'
      );
      await expect(
        page.getByTestId('specialist-bay').locator('[data-role="scout"]')
      ).toHaveAttribute('data-signal', 'started');
      await expect(page.getByText(/^Live$/i)).toHaveCount(0);

      for (const state of ['policy_blocked', 'failed', 'cancelled'] as const) {
        await selectRun(page, seeded.runs[state]);
        await expect(page.getByTestId('signal-desk')).toHaveAttribute(
          'data-status',
          seeded.runs[state].status
        );
        await expect(
          page.getByTestId('signal-desk').getByRole('button', { name: 'Run again' })
        ).toBeVisible();
      }

      await selectRun(page, seeded.runs.succeeded);
      const monitorImage = page.getByTestId('evidence-monitor').locator('img');
      await expect(monitorImage).toBeVisible();
      await expect(page.locator('.signal-crt')).toHaveAttribute('data-availability', 'ready');
      expect(
        await monitorImage.evaluate(
          (image: HTMLImageElement) => image.naturalWidth > 0 && image.naturalHeight > 0
        )
      ).toBe(true);
      expect(
        await page
          .getByTestId('signal-desk')
          .locator('img')
          .evaluateAll((images: HTMLImageElement[]) =>
            images.every((image) => image.naturalWidth > 0 && image.naturalHeight > 0)
          )
      ).toBe(true);
      await expect(page.getByTestId('evidence-monitor')).toContainText('Counter evidence fixture');
      await expect(page.getByTestId('evidence-monitor')).toContainText('Playwright Chromium');
      await expect(page.getByTestId('evidence-monitor')).toContainText('Ready');
      expect(await page.locator('iframe, webview, browserview').count()).toBe(0);

      await resizeWindow(app, 1440, 1000);
      await expectViewportIntegrity(page);
      await expectInspectableEvidenceImage(page);
      await expectNoSeriousAccessibilityViolations(page);
      await page.screenshot({
        path: testInfo.outputPath('signal-desk-succeeded-1440x1000.png'),
      });

      await resizeWindow(app, 1024, 700);
      await expectViewportIntegrity(page);
      await expectInspectableEvidenceImage(page);
      await expectNoSeriousAccessibilityViolations(page);
      await page.screenshot({
        path: testInfo.outputPath('signal-desk-succeeded-1024x700.png'),
      });

      const splitter = page.getByTestId('workspace-splitter');
      await expect(splitter).toHaveAttribute('aria-valuenow', '58');
      await splitter.focus();
      await splitter.press('ArrowLeft');
      await expect(splitter).toHaveAttribute('aria-valuenow', '56');
      await expectViewportIntegrity(page);

      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(page.getByRole('button', { name: 'Toggle scanlines' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Toggle vignette' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Toggle refresh effect' })).toBeDisabled();
      await expect(page.locator('.signal-crt')).toHaveAttribute('data-scanlines', 'off');
      await expect(page.locator('.signal-crt')).toHaveAttribute('data-vignette', 'off');
      await expect(page.locator('.signal-crt')).toHaveAttribute('data-refresh', 'off');
      expect(
        await page
          .locator('.signal-crt-screen')
          .evaluate((element) => getComputedStyle(element, '::after').animationName)
      ).toBe('none');

      await selectRun(page, seeded.runs['missing-evidence']);
      await expect(page.getByTestId('evidence-monitor')).toContainText(
        'No browser screenshot checkpoint was persisted.'
      );
      await expect(
        page.getByTestId('evidence-monitor').locator('.signal-monitor-image')
      ).toHaveCount(0);
      await expect(
        page.getByTestId('specialist-bay').getByText('Awaiting specialist signal')
      ).toHaveCount(5);
      await expectViewportIntegrity(page);
      await expectNoSeriousAccessibilityViolations(page);
    } finally {
      await app.close();
    }
  });
});

async function seedCockpit(userData: string): Promise<SeededCockpit> {
  const repository = await fixtureRepository();
  const storage = new QAgentStorage(join(userData, 'qagent.sqlite'));
  const artifactStore = new ArtifactStore(join(userData, 'artifacts'), storage);
  const project = storage.createProject({
    name: 'Signal Desk fixture',
    path: repository,
    trusted: true,
    configPath: join(repository, '.qagent.yml'),
  });
  const baseSha = await git(repository, ['rev-parse', 'HEAD']);
  const worktreeRoot = join(userData, 'worktrees');
  await mkdir(worktreeRoot, { recursive: true });
  const browserEvidence = await captureBrowserEvidence();
  const runs = {} as Record<CockpitState, SeededRun>;

  try {
    const states: CockpitState[] = [
      'policy_blocked',
      'failed',
      'cancelled',
      'succeeded',
      'missing-evidence',
    ];
    for (const state of states) {
      const run = storage.createRun({ projectId: project.id, requestedBy: 'desktop' });
      const branch = `qagent/e2e-${state}`;
      const worktreePath = join(worktreeRoot, state);
      await git(repository, ['worktree', 'add', '-b', branch, worktreePath, baseSha]);
      storage.updateRun(run.id, {
        stage: state === 'policy_blocked' ? 'preflight' : state === 'active' ? 'triage' : 'verify',
        branch,
        worktreePath,
        baseSha,
        summary: summaryFor(state),
        availableActions: state === 'active' ? ['cancel'] : [],
      });

      storage.appendEvent(run.id, {
        kind: 'run.created',
        stage: 'preflight',
        provenance: localProvenance(),
        artifactIds: [],
        payload: { message: 'Signal Desk fixture run persisted' },
      });
      storage.appendEvent(run.id, {
        kind: 'run.isolation_ready',
        stage: 'preflight',
        provenance: localProvenance(),
        artifactIds: [],
        payload: {
          isolation: {
            state: 'ready',
            canonicalProjectPath: repository,
            worktreePath,
            branch,
            baseSha,
          },
          policyBoundary: {
            mutationMode: 'dedicated-worktree',
            activeCheckoutMutationAllowed: false,
            dirtyCheckoutPublicationAllowed: false,
            highRiskAutoMergeAllowed: false,
            originalCheckoutDirty: false,
            publishProvider: 'local',
            baseBranch: 'main',
            autoMergeRequested: false,
            publicationAllowed: true,
            autoMergeAllowed: false,
            blockedReasons: [],
          },
        },
      });

      const commandId = randomUUID();
      const commandStage = state === 'policy_blocked' ? 'preflight' : 'test';
      storage.appendEvent(run.id, {
        kind: 'command.started',
        stage: commandStage,
        provenance: localProvenance(),
        artifactIds: [],
        payload: {
          executable: 'pnpm',
          args: ['test', '--', 'counter'],
          commandId,
          attempt: 1,
        },
      });
      const output = `stdout: ${state} fixture command ${run.id.slice(0, 8)}\n`;
      storage.appendEvent(run.id, {
        kind: 'command.output',
        stage: commandStage,
        provenance: localProvenance(),
        artifactIds: [],
        payload: {
          commandId,
          attempt: 1,
          stream: 'stdout',
          chunkIndex: 0,
          output: {
            text: output,
            originalBytes: Buffer.byteLength(output),
            retainedBytes: Buffer.byteLength(output),
            omittedBytes: 0,
            truncated: false,
            redactionCount: 0,
            backpressure: null,
          },
        },
      });

      const logArtifact = await artifactStore.save({
        runId: run.id,
        kind: 'log',
        name: `${state}-command.log`,
        mimeType: 'text/plain',
        data: output,
        provenance: localProvenance(),
      });

      if (state !== 'active') {
        const exitCode = state === 'failed' || state === 'policy_blocked' ? 1 : 0;
        storage.appendEvent(run.id, {
          kind: 'command.completed',
          stage: commandStage,
          provenance: localProvenance(),
          artifactIds: [logArtifact.id],
          payload: {
            executable: 'pnpm',
            args: ['test', '--', 'counter'],
            exitCode,
            durationMs: 842,
            commandId,
            attempt: 1,
          },
        });
      }

      let screenshotId: string | null = null;
      if (state === 'succeeded') {
        const screenshot = await artifactStore.save({
          runId: run.id,
          kind: 'screenshot',
          name: 'counter-browser-checkpoint.png',
          mimeType: 'image/png',
          data: browserEvidence.screenshot,
          provenance: {
            source: 'provider',
            provider: 'Playwright Chromium',
            capturedAt: new Date().toISOString(),
          },
        });
        screenshotId = screenshot.id;
        const sessionId = randomUUID();
        storage.appendEvent(run.id, {
          kind: 'browser.session_started',
          stage: 'verify',
          provenance: {
            source: 'provider',
            provider: 'Playwright Chromium',
            capturedAt: new Date().toISOString(),
          },
          artifactIds: [],
          payload: {
            sessionId,
            provider: 'Playwright Chromium',
            browserName: 'Chromium',
            attempt: 1,
          },
        });
        storage.appendEvent(run.id, {
          kind: 'browser.checkpoint',
          stage: 'verify',
          provenance: {
            source: 'provider',
            provider: 'Playwright Chromium',
            capturedAt: new Date().toISOString(),
          },
          artifactIds: [screenshot.id],
          payload: {
            sessionId,
            checkpointId: randomUUID(),
            flow: 'Counter evidence fixture',
            url: browserEvidence.url,
            title: browserEvidence.title,
            attempt: 1,
          },
        });
        recordSpecialistActivity(storage, run.id, 'proof', 'succeeded', [screenshot.id], 'verify');
      } else if (state === 'active') {
        recordSpecialistActivity(storage, run.id, 'scout', 'started', [], 'triage');
      }

      if (state !== 'active') {
        const status = state === 'missing-evidence' ? 'succeeded' : state;
        const terminalStatus = status as Exclude<
          RunStatus,
          'queued' | 'running' | 'interrupted' | 'waiting_for_intervention'
        >;
        const evidenceReady = screenshotId !== null;
        storage.appendEvent(run.id, {
          kind: 'terminal.evidence',
          stage: status === 'succeeded' ? 'complete' : commandStage,
          provenance: localProvenance(),
          artifactIds: screenshotId ? [screenshotId] : [],
          payload: {
            evidence: {
              id: randomUUID(),
              runId: run.id,
              outcome: terminalStatus,
              summary: summaryFor(state),
              evidenceAvailability: evidenceReady ? 'ready' : 'unavailable',
              artifactIds: screenshotId ? [screenshotId] : [],
              evidenceLinks: screenshotId
                ? [
                    {
                      artifactId: screenshotId,
                      label: 'Rendered browser checkpoint',
                      relationship: 'verifies',
                    },
                  ]
                : [],
              evidenceUnavailableReason: evidenceReady
                ? null
                : 'No browser screenshot checkpoint was persisted for this fixture state.',
              verificationId: null,
              publication: null,
              createdAt: new Date().toISOString(),
            },
          },
        });
        const terminalKind = {
          succeeded: 'run.completed',
          failed: 'run.failed',
          cancelled: 'run.cancelled',
          policy_blocked: 'run.policy_blocked',
        }[terminalStatus] as
          'run.completed' | 'run.failed' | 'run.cancelled' | 'run.policy_blocked';
        storage.settleRunOnce(
          run.id,
          terminalStatus,
          {
            kind: terminalKind,
            stage: terminalStatus === 'succeeded' ? 'complete' : commandStage,
            provenance: localProvenance(),
            artifactIds: screenshotId ? [screenshotId] : [logArtifact.id],
            payload: { message: summaryFor(state) },
          },
          {
            availableActions: terminalStatus === 'succeeded' ? [] : ['retry'],
            failureCode:
              terminalStatus === 'failed'
                ? 'unexpected_failure'
                : terminalStatus === 'policy_blocked'
                  ? 'policy_blocked'
                  : null,
          }
        );
      }

      const persisted = storage.getRun(run.id);
      if (!persisted) throw new Error(`Seeded run ${run.id} was not persisted`);
      runs[state] = { id: persisted.id, status: persisted.status };
    }
  } finally {
    storage.close();
  }

  return { runs };
}

async function seedActiveRun(userData: string): Promise<SeededRun> {
  const storage = new QAgentStorage(join(userData, 'qagent.sqlite'));
  const artifactStore = new ArtifactStore(join(userData, 'artifacts'), storage);
  try {
    const project = storage.listProjects()[0];
    if (!project) throw new Error('Signal Desk fixture project was not persisted');
    const baseSha = await git(project.path, ['rev-parse', 'HEAD']);
    const run = storage.createRun({ projectId: project.id, requestedBy: 'desktop' });
    const branch = 'qagent/e2e-active';
    const worktreePath = join(userData, 'worktrees', 'active');
    await git(project.path, ['worktree', 'add', '-b', branch, worktreePath, baseSha]);
    storage.updateRun(run.id, {
      stage: 'triage',
      branch,
      worktreePath,
      baseSha,
      summary: summaryFor('active'),
      availableActions: ['cancel'],
    });
    storage.appendEvent(run.id, {
      kind: 'run.created',
      stage: 'preflight',
      provenance: localProvenance(),
      artifactIds: [],
      payload: { message: 'Signal Desk active fixture persisted after runtime recovery' },
    });
    storage.appendEvent(run.id, {
      kind: 'run.isolation_ready',
      stage: 'preflight',
      provenance: localProvenance(),
      artifactIds: [],
      payload: {
        isolation: {
          state: 'ready',
          canonicalProjectPath: project.path,
          worktreePath,
          branch,
          baseSha,
        },
        policyBoundary: {
          mutationMode: 'dedicated-worktree',
          activeCheckoutMutationAllowed: false,
          dirtyCheckoutPublicationAllowed: false,
          highRiskAutoMergeAllowed: false,
          originalCheckoutDirty: false,
          publishProvider: 'local',
          baseBranch: 'main',
          autoMergeRequested: false,
          publicationAllowed: true,
          autoMergeAllowed: false,
          blockedReasons: [],
        },
      },
    });
    const commandId = randomUUID();
    storage.appendEvent(run.id, {
      kind: 'command.started',
      stage: 'triage',
      provenance: localProvenance(),
      artifactIds: [],
      payload: {
        executable: 'pnpm',
        args: ['test', '--', 'counter'],
        commandId,
        attempt: 1,
      },
    });
    const output = `stdout: active fixture command ${run.id.slice(0, 8)}\n`;
    storage.appendEvent(run.id, {
      kind: 'command.output',
      stage: 'triage',
      provenance: localProvenance(),
      artifactIds: [],
      payload: {
        commandId,
        attempt: 1,
        stream: 'stdout',
        chunkIndex: 0,
        output: {
          text: output,
          originalBytes: Buffer.byteLength(output),
          retainedBytes: Buffer.byteLength(output),
          omittedBytes: 0,
          truncated: false,
          redactionCount: 0,
          backpressure: null,
        },
      },
    });
    await artifactStore.save({
      runId: run.id,
      kind: 'log',
      name: 'active-command.log',
      mimeType: 'text/plain',
      data: output,
      provenance: localProvenance(),
    });
    recordSpecialistActivity(storage, run.id, 'scout', 'started', [], 'triage');
    const persisted = storage.getRun(run.id);
    if (!persisted) throw new Error('Active Signal Desk run was not persisted');
    return { id: persisted.id, status: persisted.status };
  } finally {
    storage.close();
  }
}

function specialistActivity(
  runId: string,
  role: 'scout' | 'proof',
  status: 'started' | 'succeeded',
  evidenceIds: string[]
) {
  return {
    id: randomUUID(),
    runId,
    role,
    status,
    summary:
      status === 'started'
        ? 'Inspecting persisted browser checkpoints'
        : 'Browser checkpoint verified',
    source: {
      kind: 'policy_worker' as const,
      worker: `qagent.specialist.${role}`,
      invocationId: randomUUID(),
    },
    occurredAt: new Date().toISOString(),
    attempt: 1,
    evidenceIds,
    handoffTarget: null,
  };
}

function recordSpecialistActivity(
  storage: QAgentStorage,
  runId: string,
  role: 'scout' | 'proof',
  status: 'started' | 'succeeded',
  evidenceIds: string[],
  stage: 'triage' | 'verify'
): void {
  const invocationId = randomUUID();
  const timestamp = new Date().toISOString();
  storage.recordPolicyWorkerCall({
    id: invocationId,
    runId,
    worker: `qagent.specialist.${role}`,
    version: '1',
    attempt: 1,
    status,
    inputDigest: '1'.repeat(64),
    outputDigest: status === 'succeeded' ? '2'.repeat(64) : null,
    error: null,
    startedAt: timestamp,
    completedAt: status === 'succeeded' ? timestamp : null,
  });
  const activity = specialistActivity(runId, role, status, evidenceIds);
  activity.source.invocationId = invocationId;
  storage.recordSpecialistActivity(activity, stage, localProvenance());
}

function summaryFor(state: CockpitState): string {
  switch (state) {
    case 'active':
      return 'Diagnosis is reading durable command output.';
    case 'policy_blocked':
      return 'Publication policy blocked this repair.';
    case 'failed':
      return 'Verification command exited with status 1.';
    case 'cancelled':
      return 'Cancellation was persisted by the desktop client.';
    case 'succeeded':
      return 'Repair verified with checksummed browser evidence.';
    case 'missing-evidence':
      return 'Checks passed, but browser evidence is unavailable.';
  }
}

async function captureBrowserEvidence(): Promise<{
  screenshot: Buffer;
  title: string;
  url: string;
}> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const html = `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <title>Counter evidence fixture</title>
          <style>
            body { margin: 0; display: grid; min-height: 100vh; place-items: center; background: #f4f7f5; color: #17211d; font: 20px system-ui; }
            main { width: 480px; padding: 36px; border: 2px solid #1d7564; background: white; box-shadow: 12px 12px 0 #cbd8d2; }
            p { color: #4a5b54; }
            output { display: block; margin-top: 20px; color: #1d7564; font: 700 64px ui-monospace; }
          </style>
        </head>
        <body><main><h1>Counter repaired</h1><p>Increment action verified in local Chromium.</p><output>1</output></main></body>
      </html>`;
    await page.goto(`data:text/html,${encodeURIComponent(html)}`, { waitUntil: 'load' });
    return {
      screenshot: await page.screenshot({ fullPage: true }),
      title: await page.title(),
      url: page.url(),
    };
  } finally {
    await browser.close();
  }
}

async function selectRun(page: Page, run: SeededRun): Promise<void> {
  const item = page
    .getByTestId('instrument-dock')
    .locator('.signal-run-item')
    .filter({ hasText: run.id.slice(0, 8) });
  await item.click();
  await expect(page.getByTestId('signal-desk')).toHaveAttribute('data-status', run.status);
  await expect(
    page.getByTestId('signal-desk').getByText(`RUN ${run.id.slice(0, 8)}`)
  ).toBeVisible();
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

async function expectViewportIntegrity(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const hooks = {
      dock: rect('[data-testid="instrument-dock"]'),
      desk: rect('[data-testid="signal-desk"]'),
      console: rect('[data-testid="run-console"]'),
      splitter: rect('[data-testid="workspace-splitter"]'),
      evidence: rect('[data-testid="evidence-monitor"]'),
      specialists: rect('[data-testid="specialist-bay"]'),
    };
    const controlSelectors = [
      '.signal-run-controls button',
      '.signal-console-actions button',
      '.signal-monitor-effects button',
      '.signal-checkpoint-pager button',
    ];
    const controls = controlSelectors.flatMap((selector) =>
      [...document.querySelectorAll<HTMLElement>(selector)].map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
        };
      })
    );
    const overlaps: Array<[number, number]> = [];
    for (let left = 0; left < controls.length; left += 1) {
      for (let right = left + 1; right < controls.length; right += 1) {
        const first = controls[left];
        const second = controls[right];
        if (!first || !second) continue;
        const intersects =
          first.left < second.right &&
          first.right > second.left &&
          first.top < second.bottom &&
          first.bottom > second.top;
        if (intersects) overlaps.push([left, right]);
      }
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentOverflow: document.documentElement.scrollWidth > innerWidth,
      hooks,
      overlaps,
    };
  });

  expect(result.documentOverflow).toBe(false);
  expect(result.overlaps).toEqual([]);
  for (const bounds of Object.values(result.hooks)) {
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThan(0);
    expect(bounds!.height).toBeGreaterThan(0);
    expect(bounds!.left).toBeGreaterThanOrEqual(0);
    expect(bounds!.top).toBeGreaterThanOrEqual(0);
    expect(bounds!.right).toBeLessThanOrEqual(result.viewport.width + 1);
    expect(bounds!.bottom).toBeLessThanOrEqual(result.viewport.height + 1);
  }
  expect(result.hooks.dock!.right).toBeLessThanOrEqual(result.hooks.desk!.left + 1);
  expect(result.hooks.console!.right).toBeLessThanOrEqual(result.hooks.evidence!.left + 1);
  expect(result.hooks.console!.bottom).toBeLessThanOrEqual(result.hooks.specialists!.top + 1);
  expect(result.hooks.evidence!.bottom).toBeLessThanOrEqual(result.hooks.specialists!.top + 1);
}

async function expectNoSeriousAccessibilityViolations(page: Page): Promise<void> {
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

async function expectInspectableEvidenceImage(page: Page): Promise<void> {
  const image = page.getByTestId('evidence-monitor').locator('img');
  await expect(image).toBeVisible();
  const result = await image.evaluate((element: HTMLImageElement) => {
    const bounds = element.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 18;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context?.drawImage(element, 0, 0, canvas.width, canvas.height);
    const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
    let darkest = 255;
    let lightest = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const luminance =
        0.2126 * (pixels[index] ?? 0) +
        0.7152 * (pixels[index + 1] ?? 0) +
        0.0722 * (pixels[index + 2] ?? 0);
      darkest = Math.min(darkest, luminance);
      lightest = Math.max(lightest, luminance);
    }
    return {
      width: bounds.width,
      height: bounds.height,
      luminanceRange: lightest - darkest,
    };
  });

  expect(result.width).toBeGreaterThanOrEqual(160);
  expect(result.height).toBeGreaterThanOrEqual(72);
  expect(result.luminanceRange).toBeGreaterThan(20);
}
