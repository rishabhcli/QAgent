import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GitRepository,
  detectProject,
  writeProjectConfig,
  type ModelCompletion,
  type ModelProvider,
  type ModelRequest,
} from '../../packages/adapters/dist/index.js';
import type {
  CommandSpec,
  IntegrationVerifyResult,
  Run,
  RunDetail,
} from '../../packages/contracts/dist/index.js';
import { PolicyBlockedError, QAgentEngine } from '../../packages/core/dist/index.js';
import { ArtifactStore, QAgentStorage } from '../../packages/storage/dist/index.js';
import { chromium, expect, test, type Page } from '@playwright/test';
import {
  bootstrap,
  canonicalSelection,
  cleanupWorkflowFixtures,
  desktopRequest,
  engineUtilityPid,
  fixtureRepository,
  git,
  killEngineUtility,
  launchDesktop,
  runDetail,
  startLocalGitHubServer,
  startScriptedModelServer,
  temporaryDirectory,
} from './desktop-workflow-harness.js';

test.describe('contract-backed desktop workflow', () => {
  test.setTimeout(120_000);

  test.afterEach(async () => {
    await cleanupWorkflowFixtures();
  });

  test('remediates provider health, discloses isolation, survives navigation and recovery, and cancels', async () => {
    const repository = await fixtureRepository();
    const detected = await detectProject(repository);
    if (!detected.config) throw new Error('Fixture configuration was not found');
    const command = longCommand();
    detected.config.test.commands = [command];
    detected.config.test.browserFlows = [];
    detected.config.verify.commands = [command];
    await writeProjectConfig(repository, detected.config, { force: true });
    await git(repository, ['add', '.qagent.yml']);
    await git(repository, ['commit', '-m', 'configure durable recovery fixture']);

    const selection = await canonicalSelection(repository);
    const userData = await temporaryDirectory('qagent-desktop-workflow-recovery-');
    const modelServer = await startScriptedModelServer();
    const app = await launchDesktop(userData);
    try {
      await app.evaluate(({ dialog }, selectedPath) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [selectedPath],
        });
      }, selection.selectedPath);
      const page = await app.firstWindow();
      await page.getByRole('button', { name: 'Choose folder' }).click();

      await expect(page.getByText(selection.canonicalPath, { exact: true })).toBeVisible();
      await expect(page.getByText(selection.selectedPath, { exact: true })).toBeVisible();
      const disclosedCommands = page.locator('.trust-command-list code');
      await expect(disclosedCommands.nth(0)).toContainText(
        'PORT=<configured> "node" "src/server.mjs"'
      );
      await expect(disclosedCommands.nth(1)).toContainText(
        `${JSON.stringify(process.execPath)} "-e" "setTimeout(() => {}, 20000)"`
      );
      await expect(disclosedCommands.nth(2)).toContainText(
        `${JSON.stringify(process.execPath)} "-e" "setTimeout(() => {}, 20000)"`
      );
      await expect(disclosedCommands.filter({ hasText: '[cwd .]' })).toHaveCount(3);

      await page.getByLabel('I trust this repository to run every command listed above.').check();
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByLabel('Model provider').selectOption('openai-compatible');
      await page.getByLabel('Model ID').fill('qagent-workflow-e2e');
      await page.getByLabel('Endpoint').fill('http://127.0.0.1:1/v1');
      await page.getByLabel('Publication').selectOption('local');
      await page.getByLabel('Send redacted run traces to Weave').uncheck();
      await page.getByRole('button', { name: 'Save and check' }).click();

      const reviewModel = page.getByRole('button', { name: 'Review model connection' });
      const projectDoctor = page.getByRole('button', { name: 'Check', exact: true });
      await expect
        .poll(async () => (await reviewModel.count()) + (await projectDoctor.count()))
        .toBeGreaterThan(0);
      if ((await reviewModel.count()) === 0) await projectDoctor.click();
      await expect(page.getByText(/probe failed:/)).toBeVisible();
      const projectId = (await bootstrap(page)).projects.data?.[0]?.id;
      if (!projectId) throw new Error('Configured project was not returned by desktop bootstrap');
      expect((await verifyIntegration(page, 'model', projectId)).integration.status).toBe('error');
      expect((await verifyIntegration(page, 'browser', projectId)).integration.status).toBe(
        'configured'
      );
      expect((await verifyIntegration(page, 'github', projectId)).integration.status).toBe(
        'unconfigured'
      );
      expect((await verifyIntegration(page, 'weave', projectId)).integration.status).toBe(
        'unconfigured'
      );
      await reviewModel.click();
      await expect(page.getByRole('heading', { name: 'Connect the essentials.' })).toBeVisible();
      await page.getByLabel('Endpoint').fill(modelServer.baseUrl);
      await page.getByRole('button', { name: 'Save and check' }).click();

      const readyHeading = page.getByRole('heading', { name: 'Ready to run.' });
      await expect
        .poll(async () => (await readyHeading.count()) + (await projectDoctor.count()))
        .toBeGreaterThan(0);
      if ((await readyHeading.count()) === 0) await projectDoctor.click();
      await expect(
        page.getByText('openai-compatible/qagent-workflow-e2e returned valid structured output')
      ).toBeVisible();
      expect((await verifyIntegration(page, 'model', projectId)).integration.status).toBe(
        'end-to-end-verified'
      );
      await page.getByRole('button', { name: 'Run QA' }).click();

      const started = await waitForRun(page, (run) =>
        run.status === 'queued' || run.status === 'running' ? run : null
      );
      const initialDetail = await waitForRunDetail(page, started.id, (detail) =>
        detail.events.some((event) => event.kind === 'run.isolation_ready')
      );
      const worktreePath = initialDetail.run.worktreePath;
      expect(worktreePath).not.toBeNull();
      expect(worktreePath).not.toBe(selection.canonicalPath);
      expect(initialDetail.run.branch).toMatch(/^qagent\//);

      const signalDesk = page.getByTestId('signal-desk');
      await expect(signalDesk).toContainText(worktreePath!);
      const workflow = page.getByRole('region', { name: 'Persistent run workflow' });
      const runMark = `RUN ${started.id.slice(0, 8)}`;
      for (const view of ['Projects', 'Tests', 'Settings']) {
        await page.getByRole('button', { name: view }).click();
        await expect(workflow).toContainText(runMark);
        await expect(workflow).toContainText(worktreePath!);
        await expect(workflow).toContainText('active checkout mutation blocked');
        await expect(workflow).toContainText('local publication allowed');
      }
      await page.getByRole('button', { name: 'Runs' }).click();
      await expect(signalDesk).toContainText(runMark);
      await expect(signalDesk).toContainText(worktreePath!);

      await page.reload();
      await expect(workflow).toContainText(runMark);
      const previousUtilityPid = await engineUtilityPid(app);
      expect(await killEngineUtility(app)).toBe(previousUtilityPid);
      await expect
        .poll(async () => {
          try {
            return await engineUtilityPid(app);
          } catch {
            return previousUtilityPid;
          }
        })
        .not.toBe(previousUtilityPid);

      const recovered = await waitForRunDetail(page, started.id, (detail) => {
        const kinds = detail.events.map((event) => event.kind);
        return (
          detail.run.recoveryCount > 0 &&
          kinds.includes('run.interrupted') &&
          kinds.includes('run.resumed')
        );
      });
      expect(recovered.run.id).toBe(started.id);
      expect(recovered.run.worktreePath).toBe(worktreePath);
      await expect(workflow).toContainText(runMark);

      await workflow.getByRole('button', { name: 'Cancel', exact: true }).click();
      const cancelled = await waitForRunDetail(
        page,
        started.id,
        (detail) => detail.run.status === 'cancelled'
      );
      expect(cancelled.run.id).toBe(started.id);
      expectExactTerminal(cancelled, 'run.cancelled', 'cancelled');
      if (cancelled.terminalEvidence?.evidenceAvailability === 'unavailable') {
        expect(cancelled.terminalEvidence.evidenceUnavailableReason).toBeTruthy();
      }
    } finally {
      await app.close();
      await modelServer.close();
    }
  });

  test('resolves invalid model output and dirty checkout before succeeding on a resumed retry', async () => {
    const repository = await fixtureRepository();
    const modelServer = await startScriptedModelServer();
    const detected = await detectProject(repository);
    if (!detected.config) throw new Error('Fixture configuration was not found');
    detected.config.test.browserFlows = [];
    detected.config.model = {
      provider: 'openai-compatible',
      model: 'qagent-workflow-e2e',
      baseUrl: modelServer.baseUrl,
    };
    detected.config.publish.provider = 'local';
    detected.config.publish.autoMerge = false;
    await writeProjectConfig(repository, detected.config, { force: true });
    await git(repository, ['add', '.qagent.yml']);
    await git(repository, ['commit', '-m', 'configure intervention fixture']);

    const readmePath = join(repository, 'README.md');
    const cleanReadme = await readFile(readmePath, 'utf8');
    const userData = await temporaryDirectory('qagent-desktop-workflow-intervention-');
    const storage = new QAgentStorage(join(userData, 'qagent.sqlite'));
    storage.createProject({
      name: 'Intervention fixture',
      path: repository,
      trusted: true,
      configPath: join(repository, '.qagent.yml'),
    });
    storage.close();

    modelServer.invalidateNextTriage();
    const app = await launchDesktop(userData);
    try {
      const page = await app.firstWindow();
      await writeFile(readmePath, `${cleanReadme}\nUncommitted user note.\n`);
      await page.getByRole('button', { name: 'Run QA' }).click();

      const invalid = await waitForRunDetailBy(
        page,
        (detail) =>
          detail.run.status === 'waiting_for_intervention' &&
          detail.run.intervention?.reason === 'invalid_model_output'
      );
      expect(invalid.run.availableActions).toEqual(['resolve_intervention', 'cancel']);
      expect(invalid.run.intervention?.requiredAction).toMatchObject({
        type: 'application',
        action: 'configure_provider',
        label: 'Repair model output',
      });
      expectNoTerminalEvent(invalid);
      await expect(page.getByText(/returned invalid structured output/).first()).toBeVisible();

      const workflow = page.getByRole('region', { name: 'Persistent run workflow' });
      await workflow.getByRole('button', { name: 'Recheck and continue', exact: true }).click();
      const retried = await waitForRunDetailBy(
        page,
        (detail) =>
          detail.run.retryOfRunId === invalid.run.id &&
          detail.run.status === 'waiting_for_intervention' &&
          detail.run.intervention?.reason === 'dirty_checkout'
      );
      expect(retried.run.id).not.toBe(invalid.run.id);
      expect(retried.run.attempt).toBe(2);
      expect(retried.run.worktreePath).not.toBe(invalid.run.worktreePath);
      expect(retried.run.availableActions).toEqual(['resolve_intervention', 'cancel']);
      expect(retried.events.some((event) => event.kind === 'run.retrying')).toBe(true);
      expectNoTerminalEvent(retried);
      await expect(workflow).toContainText(/source checkout is dirty/i);
      await expect(workflow).toContainText('Commit, stash, or remove source-checkout changes');

      const providerRequestsBeforeResolution = modelServer.requests.length;
      const providerCallsBeforeResolution = retried.providerCalls.length;
      await writeFile(readmePath, cleanReadme);
      await workflow.getByRole('button', { name: 'Recheck and continue', exact: true }).click();

      const completed = await waitForRunDetail(
        page,
        retried.run.id,
        (detail) => detail.run.status === 'succeeded'
      );
      expect(completed.run.id).toBe(retried.run.id);
      expect(completed.run.attempt).toBe(2);
      expect(completed.events.some((event) => event.kind === 'intervention.resolved')).toBe(true);
      expect(completed.events.some((event) => event.kind === 'run.resumed')).toBe(true);
      expect(completed.providerCalls).toHaveLength(providerCallsBeforeResolution);
      expect(modelServer.requests).toHaveLength(providerRequestsBeforeResolution);
      expect(completed.verification?.passed).toBe(true);
      expectExactTerminal(completed, 'run.completed', 'succeeded');
      expect(completed.terminalEvidence?.artifactIds.length).toBeGreaterThan(0);
      expect(completed.terminalEvidence?.verificationId).toBe(completed.verification?.id);
      const specialistRoles = new Set(
        completed.specialistActivities.map((activity) => activity.role)
      );
      expect(specialistRoles).toEqual(new Set(['scout', 'trace', 'patch', 'proof', 'gate']));
      expect(
        completed.specialistActivities.every((activity) => activity.evidenceIds.length > 0)
      ).toBe(true);
      expect(completed.specialistDecisions.some((decision) => decision.action === 'complete')).toBe(
        true
      );
      expect(
        completed.specialistCritiques.some((critique) => critique.verdict === 'accepted')
      ).toBe(true);
      expect(
        completed.specialistCritiques.some((critique) => critique.verdict === 'rejected')
      ).toBe(true);
      expect(completed.specialistObjections.length).toBeGreaterThan(0);
      expect(
        completed.specialistHandoffs.some(
          (handoff) => handoff.from === 'scout' && handoff.to === 'trace'
        )
      ).toBe(true);
      for (const record of [
        ...completed.specialistCritiques,
        ...completed.specialistDecisions,
        ...completed.specialistObjections,
        ...completed.specialistHandoffs,
      ]) {
        expect(record.evidenceIds.length).toBeGreaterThan(0);
      }

      const oldRun = await runDetail(page, invalid.run.id);
      expect(oldRun.run).toMatchObject({
        status: 'failed',
        attempt: 1,
        retryOfRunId: null,
        availableActions: ['retry'],
      });
      expectExactTerminal(oldRun, 'run.failed', 'failed');
      const finalSnapshot = await bootstrap(page);
      expect(
        finalSnapshot.integrations.data?.some(
          (integration) =>
            integration.provider === 'model' &&
            integration.status === 'end-to-end-verified' &&
            integration.detail?.includes('openai-compatible/qagent-workflow-e2e')
        )
      ).toBe(true);
      await page.getByRole('button', { name: 'Runs' }).click();
      const completedRunButton = page
        .getByLabel('Run ledger')
        .getByRole('button')
        .filter({ hasText: completed.run.id.slice(0, 8) });
      await completedRunButton.click();
      const signalDesk = page.getByTestId('signal-desk');
      await expect(signalDesk).toHaveAttribute('data-status', 'succeeded');
      await expect(signalDesk).toContainText(/Repair verified on local branch/);

      const specialistBay = page.getByTestId('specialist-bay');
      await expect(specialistBay).toContainText('Persisted specialist events');
      for (const role of ['scout', 'trace', 'patch', 'proof', 'gate']) {
        const station = specialistBay.locator(`[data-role="${role}"]`);
        await expect(station).not.toHaveAttribute('data-signal', 'none');
        await expect(station).not.toContainText('Awaiting specialist signal');
      }

      await page.getByRole('tab', { name: 'Dossier' }).click();
      const terminalEvidence = page.getByTestId('terminal-evidence');
      await expect(terminalEvidence).toContainText('succeeded');
      await expect(terminalEvidence).toContainText(completed.terminalEvidence!.summary);
      const linkedArtifact = terminalEvidence.locator('.signal-dossier-command button').first();
      await expect(linkedArtifact).toHaveText(/^(supports|contradicts|produced|verifies): /);
      await expect(
        terminalEvidence.locator('.signal-dossier-command span[title]').first()
      ).toHaveAttribute('title', /^[a-f0-9]{64}$/);
      await expect(terminalEvidence.getByText('Run manifest', { exact: true })).toBeVisible();
    } finally {
      await app.close();
      await modelServer.close();
    }
  });

  test('turns an early policy block into an evidence-backed trust intervention and retry', async () => {
    const repository = await fixtureRepository();
    const modelServer = await startScriptedModelServer();
    const detected = await detectProject(repository);
    if (!detected.config) throw new Error('Fixture configuration was not found');
    detected.config.test.browserFlows = [];
    detected.config.model = {
      provider: 'openai-compatible',
      model: 'qagent-workflow-e2e',
      baseUrl: modelServer.baseUrl,
    };
    detected.config.publish.provider = 'local';
    await writeProjectConfig(repository, detected.config, { force: true });
    await git(repository, ['add', '.qagent.yml']);
    await git(repository, ['commit', '-m', 'configure policy intervention fixture']);

    const userData = await temporaryDirectory('qagent-desktop-workflow-policy-');
    const storage = new QAgentStorage(join(userData, 'qagent.sqlite'));
    const project = storage.createProject({
      name: 'Policy fixture',
      path: repository,
      trusted: false,
      configPath: join(repository, '.qagent.yml'),
    });
    const queued = storage.createRun({
      projectId: project.id,
      requestedBy: 'desktop',
    });
    storage.close();

    const app = await launchDesktop(userData);
    try {
      const page = await app.firstWindow();
      const blocked = await waitForRunDetail(
        page,
        queued.id,
        (detail) =>
          detail.run.status === 'waiting_for_intervention' &&
          detail.run.failureCode === 'policy_blocked'
      );
      expect(blocked.run.availableActions).toEqual(['resolve_intervention', 'cancel']);
      expect(blocked.run.intervention).toMatchObject({
        reason: 'policy_blocked',
        resolutionOptions: ['policy_acknowledged'],
        requiredAction: {
          type: 'application',
          action: 'trust_project',
          label: 'Trust project',
        },
      });
      expect(blocked.run.intervention?.evidenceArtifactIds.length).toBeGreaterThan(0);
      expectNoTerminalEvent(blocked);

      const workflow = page.getByRole('region', { name: 'Persistent run workflow' });
      await expect(workflow).toContainText('Trust this workspace before running commands');
      await expect(
        workflow.locator('.workflow-specialist-row').filter({ hasText: 'Gate' }).first()
      ).toContainText('evidence');

      await workflow.getByRole('button', { name: 'Trust project', exact: true }).click();
      await page.getByRole('button', { name: 'Configure' }).click();
      await expect(page.getByRole('heading', { name: 'Connect the essentials.' })).toBeVisible();
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page.getByText(repository, { exact: true })).toBeVisible();
      await expect(
        page.locator('.trust-command-list code').filter({
          hasText: '"node" "--test" "test/counter.test.mjs"',
        })
      ).toHaveCount(2);
      await page.getByLabel('I trust this repository to run every command listed above.').check();
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Close setup' }).click();

      await expect(workflow.getByRole('button', { name: 'Recheck and continue' })).toBeVisible();
      await workflow.getByRole('button', { name: 'Recheck and continue' }).click();
      const retried = await waitForRunDetailBy(
        page,
        (detail) => detail.run.retryOfRunId === queued.id && detail.run.status === 'succeeded'
      );
      expect(retried.run.id).not.toBe(queued.id);
      expect(retried.run.attempt).toBe(2);
      expect(retried.events.some((event) => event.kind === 'run.retrying')).toBe(true);
      expectExactTerminal(retried, 'run.completed', 'succeeded');

      const terminalBlock = await runDetail(page, queued.id);
      expect(terminalBlock.run).toMatchObject({
        status: 'policy_blocked',
        failureCode: 'policy_blocked',
        availableActions: ['retry'],
      });
      expectExactTerminal(terminalBlock, 'run.policy_blocked', 'policy_blocked');
    } finally {
      await app.close();
      await modelServer.close();
    }
  });

  test('surfaces browser startup failure and verifies the repaired browser end to end', async () => {
    const repository = await fixtureRepository();
    const modelServer = await startScriptedModelServer();
    const detected = await detectProject(repository);
    if (!detected.config) throw new Error('Fixture configuration was not found');
    detected.config.model = {
      provider: 'openai-compatible',
      model: 'qagent-workflow-e2e',
      baseUrl: modelServer.baseUrl,
    };
    detected.config.publish.provider = 'local';
    await writeProjectConfig(repository, detected.config, { force: true });
    await git(repository, ['add', '.qagent.yml']);
    await git(repository, ['commit', '-m', 'configure browser recovery fixture']);

    const userData = await temporaryDirectory('qagent-desktop-workflow-browser-');
    const browserDirectory = await temporaryDirectory('qagent-desktop-workflow-browser-bin-');
    const configuredBrowser = join(browserDirectory, 'chromium');
    const storage = new QAgentStorage(join(userData, 'qagent.sqlite'));
    const project = storage.createProject({
      name: 'Browser recovery fixture',
      path: repository,
      trusted: true,
      configPath: join(repository, '.qagent.yml'),
    });
    storage.close();

    const app = await launchDesktop(userData, { QAGENT_BROWSER_PATH: configuredBrowser });
    try {
      const page = await app.firstWindow();
      expect((await verifyIntegration(page, 'browser', project.id)).integration.status).toBe(
        'unconfigured'
      );
      await page.getByRole('button', { name: 'Run QA' }).click();
      const blocked = await waitForRunDetailBy(
        page,
        (detail) =>
          detail.run.status === 'waiting_for_intervention' &&
          detail.run.intervention?.reason === 'browser_startup_failure'
      );
      expect(blocked.run.availableActions).toEqual(['resolve_intervention', 'cancel']);
      expect(blocked.run.intervention?.requiredAction).toMatchObject({
        type: 'application',
        action: 'install_browser',
        label: 'Install browser',
      });
      expectNoTerminalEvent(blocked);

      const workflow = page.getByRole('region', { name: 'Persistent run workflow' });
      await expect(workflow).toContainText(/No Chrome-compatible browser|browser/i);
      await expect(
        workflow.getByRole('button', { name: 'Install browser', exact: true })
      ).toBeVisible();

      await writeFile(
        configuredBrowser,
        `#!/bin/sh\nexec ${JSON.stringify(chromium.executablePath())} "$@"\n`,
        'utf8'
      );
      await chmod(configuredBrowser, 0o755);
      expect((await verifyIntegration(page, 'browser', project.id)).integration.status).toBe(
        'configured'
      );
      await workflow.getByRole('button', { name: 'Recheck and continue', exact: true }).click();

      const repaired = await waitForRunDetailBy(
        page,
        (detail) =>
          detail.run.retryOfRunId === blocked.run.id &&
          ['succeeded', 'failed', 'policy_blocked', 'cancelled'].includes(detail.run.status)
      );
      expect(
        repaired.run.status,
        JSON.stringify({
          browserFailures: repaired.events
            .filter((event) => event.kind === 'browser.failed')
            .map((event) => event.payload),
          modelEndpoints: modelServer.requests.map(({ method, url }) => ({ method, url })),
        })
      ).toBe('succeeded');
      expect(repaired.run.attempt).toBe(2);
      expect(repaired.artifacts.some((artifact) => artifact.kind === 'screenshot')).toBe(true);
      expectExactTerminal(repaired, 'run.completed', 'succeeded');
      expect(
        (await bootstrap(page)).integrations.data?.some(
          (integration) =>
            integration.provider === 'browser' && integration.status === 'end-to-end-verified'
        )
      ).toBe(true);

      const original = await runDetail(page, blocked.run.id);
      expect(original.run).toMatchObject({
        status: 'failed',
        failureCode: 'browser_startup_failure',
        availableActions: ['retry'],
      });
      expectExactTerminal(original, 'run.failed', 'failed');
    } finally {
      await app.close();
      await modelServer.close();
    }
  });

  test('terminalizes a post-verification policy block and accepts a bounded retry', async () => {
    const userData = await temporaryDirectory('qagent-desktop-workflow-terminal-policy-');
    const modelServer = await startScriptedModelServer();
    const seeded = await seedTerminalPolicyBlock(userData, modelServer.baseUrl);

    const app = await launchDesktop(userData);
    try {
      const page = await app.firstWindow();
      const terminal = await waitForRunDetail(
        page,
        seeded.runId,
        (detail) => detail.run.status === 'policy_blocked'
      );
      expect(terminal.run).toMatchObject({
        failureCode: 'policy_blocked',
        availableActions: ['retry'],
        intervention: null,
      });
      expect(terminal.run.error).toContain('Post-checkpoint policy block');
      expectExactTerminal(terminal, 'run.policy_blocked', 'policy_blocked');

      const workflow = page.getByRole('region', { name: 'Persistent run workflow' });
      await expect(workflow.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
      await workflow.getByRole('button', { name: 'Retry', exact: true }).click();
      const retried = await waitForRunDetailBy(
        page,
        (detail) => detail.run.retryOfRunId === seeded.runId && detail.run.status === 'succeeded'
      );
      expect(retried.run.attempt).toBe(2);
      expect(retried.run.worktreePath).not.toBe(terminal.run.worktreePath);
      expectExactTerminal(retried, 'run.completed', 'succeeded');
    } finally {
      await app.close();
      await modelServer.close();
    }
  });

  test('creates a real pull request, waits, and reconnects without duplicate publication', async () => {
    const repository = await fixtureRepository();
    const userData = await temporaryDirectory('qagent-desktop-workflow-publication-');
    const bareRepository = await temporaryDirectory('qagent-desktop-workflow-bare-');
    const modelServer = await startScriptedModelServer();
    await git(bareRepository, ['init', '--bare', '--initial-branch=main']);
    const detected = await detectProject(repository);
    if (!detected.config) throw new Error('Fixture configuration was not found');
    detected.config.test.browserFlows = [];
    detected.config.model = {
      provider: 'openai-compatible',
      model: 'qagent-workflow-e2e',
      baseUrl: modelServer.baseUrl,
    };
    detected.config.publish.provider = 'github';
    detected.config.publish.autoMerge = false;
    await writeProjectConfig(repository, detected.config, { force: true });
    await git(repository, ['add', '.qagent.yml']);
    await git(repository, ['commit', '-m', 'configure GitHub publication fixture']);
    const remote = 'https://github.com/qagent-tests/workflow-fixture.git';
    await git(repository, ['config', `url.file://${bareRepository}.insteadOf`, remote]);
    await git(repository, ['remote', 'add', 'origin', remote]);
    await git(repository, ['push', '--set-upstream', 'origin', 'main']);
    const githubServer = await startLocalGitHubServer(bareRepository);
    const storage = new QAgentStorage(join(userData, 'qagent.sqlite'));
    const project = storage.createProject({
      name: 'GitHub publication fixture',
      path: repository,
      trusted: true,
      configPath: join(repository, '.qagent.yml'),
    });
    storage.close();

    const app = await launchDesktop(userData, {
      GITHUB_TOKEN: 'github-fixture-token',
      QAGENT_E2E: 'true',
      QAGENT_GITHUB_API_URL: githubServer.baseUrl,
    });
    try {
      const page = await app.firstWindow();
      expect((await verifyIntegration(page, 'github', project.id)).integration.status).toBe(
        'healthy'
      );
      await page.getByRole('button', { name: 'Run QA' }).click();
      const started = await waitForRun(page, (run) => (run.projectId === project.id ? run : null));
      const waiting = await waitForRunDetail(
        page,
        started.id,
        (detail) =>
          detail.run.status === 'waiting_for_intervention' &&
          detail.run.intervention?.reason === 'merge_waiting'
      );
      expect(waiting.publication).toMatchObject({
        provider: 'github',
        number: 1,
        state: 'waiting_for_checks',
      });
      expect(waiting.run.availableActions).toEqual(['reconnect', 'resolve_intervention', 'cancel']);
      expect(waiting.events.filter((event) => event.kind === 'publication.created')).toHaveLength(
        1
      );
      expect(githubServer.createCount).toBe(1);
      expect(await git(bareRepository, ['rev-parse', `refs/heads/${waiting.run.branch}`])).toMatch(
        /^[a-f0-9]{40}$/
      );

      const workflow = page.getByRole('region', { name: 'Persistent run workflow' });
      await expect(workflow).toContainText(`RUN ${waiting.run.id.slice(0, 8)}`);
      await expect(workflow.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
      await workflow.getByRole('button', { name: 'Reconnect', exact: true }).click();

      const reconnected = await waitForRunDetail(
        page,
        waiting.run.id,
        (detail) => detail.run.status === 'succeeded'
      );
      expect(reconnected.run.id).toBe(waiting.run.id);
      expect(reconnected.events.some((event) => event.kind === 'run.reconnected')).toBe(true);
      expect(
        reconnected.events.filter((event) => event.kind === 'publication.created')
      ).toHaveLength(1);
      expect(reconnected.publication?.number).toBe(1);
      expect(githubServer.createCount).toBe(1);
      expect(githubServer.snapshotCount).toBe(2);
      expectExactTerminal(reconnected, 'run.completed', 'succeeded');
      expect(
        (await bootstrap(page)).integrations.data?.some(
          (integration) =>
            integration.provider === 'github' && integration.status === 'end-to-end-verified'
        )
      ).toBe(true);
    } finally {
      await app.close();
      await githubServer.close();
      await modelServer.close();
    }
  });
});

async function waitForRun(page: Page, select: (run: Run) => Run | null): Promise<Run> {
  let selected: Run | null = null;
  await expect
    .poll(
      async () => {
        try {
          const snapshot = await bootstrap(page);
          selected =
            snapshot.runs.data?.map(select).find((run): run is Run => Boolean(run)) ?? null;
          return selected !== null;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  if (!selected) throw new Error('Expected run was not found');
  return selected;
}

async function waitForRunDetail(
  page: Page,
  runId: string,
  predicate: (detail: RunDetail) => boolean
): Promise<RunDetail> {
  let selected: RunDetail | null = null;
  const observations: string[] = [];
  try {
    await expect
      .poll(
        async () => {
          try {
            const detail = await runDetail(page, runId);
            observations.push(describeRun(detail));
            if (predicate(detail)) selected = detail;
            return selected !== null;
          } catch (error) {
            observations.push(`read-error:${String(error)}`);
            return false;
          }
        },
        { timeout: 45_000 }
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `Run detail ${runId} did not reach the expected state. Last observations: ${observations.slice(-8).join(' | ')}`,
      { cause: error }
    );
  }
  if (!selected) throw new Error(`Run detail ${runId} did not reach the expected state`);
  return selected;
}

async function waitForRunDetailBy(
  page: Page,
  predicate: (detail: RunDetail) => boolean
): Promise<RunDetail> {
  let selected: RunDetail | null = null;
  const observations: string[] = [];
  try {
    await expect
      .poll(
        async () => {
          try {
            const snapshot = await bootstrap(page);
            for (const run of snapshot.runs.data ?? []) {
              const detail = await runDetail(page, run.id);
              observations.push(describeRun(detail));
              if (predicate(detail)) {
                selected = detail;
                break;
              }
            }
            return selected !== null;
          } catch (error) {
            observations.push(`read-error:${String(error)}`);
            return false;
          }
        },
        { timeout: 45_000 }
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `No run detail reached the expected state. Last observations: ${observations.slice(-12).join(' | ')}`,
      { cause: error }
    );
  }
  if (!selected) throw new Error('No run detail reached the expected state');
  return selected;
}

function describeRun(detail: RunDetail): string {
  const intervention = detail.run.intervention?.reason ?? 'none';
  const error = detail.run.error?.slice(0, 160).replaceAll(/\s+/g, ' ') ?? 'none';
  return `${detail.run.id.slice(0, 8)}:${detail.run.status}:${detail.run.failureCode ?? 'none'}:${intervention}:${error}`;
}

async function verifyIntegration(
  page: Page,
  provider: 'model' | 'browser' | 'github' | 'weave',
  projectId: string
): Promise<IntegrationVerifyResult> {
  return desktopRequest<IntegrationVerifyResult>(page, {
    method: 'integration.verify',
    params: {
      provider,
      projectId,
      requestedBy: 'desktop',
      weaveDisclosureAccepted: false,
    },
  });
}

const terminalEventKinds = [
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.policy_blocked',
] as const;

function expectNoTerminalEvent(detail: RunDetail): void {
  expect(
    detail.events.filter((event) => terminalEventKinds.some((kind) => event.kind === kind))
  ).toHaveLength(0);
  expect(detail.terminalEvidence).toBeNull();
}

function expectExactTerminal(
  detail: RunDetail,
  kind: (typeof terminalEventKinds)[number],
  outcome: NonNullable<RunDetail['terminalEvidence']>['outcome']
): void {
  const terminalEvents = detail.events.filter((event) =>
    terminalEventKinds.some((candidate) => event.kind === candidate)
  );
  expect(terminalEvents).toHaveLength(1);
  expect(terminalEvents[0]?.kind).toBe(kind);
  expect(detail.events.at(-1)?.kind).toBe(kind);
  expect(detail.events.filter((event) => event.kind === 'terminal.evidence')).toHaveLength(1);
  expect(detail.events.filter((event) => event.kind === 'run.manifest_created')).toHaveLength(1);

  const manifest = detail.artifacts.find(
    (artifact) => artifact.kind === 'manifest' && artifact.name === 'run-manifest.json'
  );
  expect(manifest).toBeDefined();
  expect(manifest?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(detail.terminalEvidence).toMatchObject({
    runId: detail.run.id,
    outcome,
    evidenceAvailability: 'ready',
  });
  expect(detail.terminalEvidence?.artifactIds).toContain(manifest?.id);
  expect(detail.terminalEvidence?.evidenceLinks).toContainEqual({
    artifactId: manifest?.id,
    label: 'run-manifest.json',
    relationship: 'supports',
  });
}

async function seedTerminalPolicyBlock(
  userData: string,
  modelBaseUrl: string
): Promise<{ runId: string }> {
  const repository = await fixtureRepository();
  const detected = await detectProject(repository);
  if (!detected.config) throw new Error('Fixture configuration was not found');
  detected.config.test.browserFlows = [];
  detected.config.model = {
    provider: 'openai-compatible',
    model: 'qagent-workflow-e2e',
    baseUrl: modelBaseUrl,
  };
  detected.config.publish.provider = 'local';
  await writeProjectConfig(repository, detected.config, { force: true });
  await git(repository, ['add', '.qagent.yml']);
  await git(repository, ['commit', '-m', 'configure terminal policy fixture']);

  const storage = new QAgentStorage(join(userData, 'qagent.sqlite'));
  const engine = new QAgentEngine({
    storage,
    artifactStore: new ArtifactStore(join(userData, 'artifacts'), storage),
    qagentHome: userData,
    gitRepository: new PostCheckpointPolicyBlockGitRepository(),
    modelProviderFactory: () => new FixtureRepairModel(),
  });
  try {
    const project = await engine.addProject(repository, true);
    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'desktop' })
    ).result();
    expect(result.status).toBe('policy_blocked');
    return { runId: result.id };
  } finally {
    storage.close();
  }
}

class PostCheckpointPolicyBlockGitRepository extends GitRepository {
  override async commit(): Promise<never> {
    throw new PolicyBlockedError('Post-checkpoint policy block');
  }
}

class FixtureRepairModel implements ModelProvider {
  readonly provider = 'fixture';
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
    return {
      value: request.schema.parse(value),
      inputTokens: 17,
      outputTokens: 9,
    };
  }
}

function longCommand(): CommandSpec {
  return {
    executable: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 20000)'],
    cwd: '.',
    env: {},
    timeoutMs: 60_000,
  };
}
