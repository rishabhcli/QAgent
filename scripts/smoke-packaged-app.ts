import { createHash } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  BootstrapSnapshotSchema,
  RunDetailSchema,
  type BootstrapSnapshot,
  type RunDetail,
} from '../packages/contracts/src/index.js';
import { PersistenceRedactor } from '../packages/storage/src/index.js';
import { chromium, type Browser, type Page } from 'playwright';
import YAML from 'yaml';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const argumentsMap = parseArguments(process.argv.slice(2));
const executablePath = resolve(requiredArgument('executable'));
const artifactPath = resolve(requiredArgument('artifact'));
const target = z
  .enum(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'])
  .parse(requiredArgument('target'));
const outputRoot = resolve(argumentsMap.get('output') ?? 'release/installed-smoke');
const mode = z.enum(['surface', 'live']).parse(argumentsMap.get('mode') ?? 'surface');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'qagent-packaged-smoke-'));
const userData = join(temporaryRoot, 'user-data');
const repository = join(temporaryRoot, 'fixture');
const processLog: string[] = [];
const processSecrets = Object.entries(process.env)
  .filter(
    ([name, value]) =>
      Boolean(value) && /(api.?key|token|secret|password|credential|authorization)/i.test(name)
  )
  .map(([, value]) => value as string)
  .sort((left, right) => right.length - left.length);
const processLogLimitBytes = 128 * 1024;
let processLogBytes = 0;
let application: PackagedApplication | null = null;
const expectedBridgeMethods = [
  'credentialStatuses',
  'getPreferences',
  'onEvent',
  'openExternal',
  'request',
  'selectDirectory',
  'setCredential',
  'setPreferences',
];
const processLogRedactor = new PersistenceRedactor({
  secretValues: processSecretVariants(),
  environment: {},
});

try {
  await resetOutputRoot();
  const executableStat = await stat(executablePath);
  assert(executableStat.isFile(), `Installed executable is not a file: ${executablePath}`);
  const artifactStat = await stat(artifactPath);
  assert(artifactStat.isFile(), `Release artifact is not a file: ${artifactPath}`);
  const sourceArtifact = {
    filename: basename(artifactPath),
    path: artifactPath,
    bytes: artifactStat.size,
    sha256: await sha256File(artifactPath),
  };
  if (mode === 'surface') {
    application = await launch();
    const page = await firstWindow(application);
    await waitForText(page, 'Choose a repository.', 60_000);
    const security = await page.evaluate(() => ({
      nodeProcess: typeof globalThis.process,
      requireFunction: typeof globalThis.require,
      bridgeMethods: Object.keys((window as unknown as QAgentPageWindow).qagent).sort(),
      url: window.location.href,
    }));
    assert(security.nodeProcess === 'undefined', 'Renderer unexpectedly exposes process');
    assert(security.requireFunction === 'undefined', 'Renderer unexpectedly exposes require');
    assert(
      JSON.stringify(security.bridgeMethods) === JSON.stringify(expectedBridgeMethods),
      `Renderer bridge methods changed: ${security.bridgeMethods.join(', ')}`
    );
    await page.screenshot({ path: join(outputRoot, 'installed-surface.png'), fullPage: true });
    await closeApplication(application);
    application = null;
    await writeProcessLog();
    await writeEvidence({
      schemaVersion: 1,
      mode,
      target,
      checkedAt: new Date().toISOString(),
      installedExecutablePath: executablePath,
      sourceArtifact,
      attachmentMode: 'loopback-chromium-devtools',
      security,
      providerProof: 'not-run',
    });
  } else {
    const model = liveModelConfiguration();
    await prepareFixture();
    application = await launch(model);
    let page = await firstWindow(application);
    assert(application.process.pid, 'Packaged application did not expose its process ID');
    await chooseRepository(page, repository, application.process.pid);
    await onboard(page, model);
    const runIdsBeforeLaunch = new Set(
      (await bootstrap(page)).runs.data?.map((run) => run.id) ?? []
    );
    await page.getByRole('button', { name: 'Run QA' }).click();
    const interruptedRunId = await waitForNewActiveRun(page, runIdsBeforeLaunch, 90_000);
    const beforeRestart = await bootstrap(page);
    assert(
      beforeRestart.runs.data?.some(
        (run) =>
          run.id === interruptedRunId && (run.status === 'queued' || run.status === 'running')
      ),
      'The packaged run was no longer active before restart interruption'
    );
    await page.screenshot({ path: join(outputRoot, 'run-before-restart.png'), fullPage: true });

    await terminateAbruptly(application);
    application = null;
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));

    application = await launch(model);
    page = await firstWindow(application);
    await page.getByRole('button', { name: 'Runs' }).click();
    await waitForRunCompletion(page, interruptedRunId, 15 * 60_000);
    const afterRestart = await bootstrap(page);
    const recovered = afterRestart.runs.data?.find((run) => run.id === interruptedRunId);
    const detail = await runDetail(page, interruptedRunId);
    if (recovered?.status !== 'succeeded') {
      await writeFile(
        join(outputRoot, 'run-terminal-detail.json'),
        `${JSON.stringify(detail, null, 2)}\n`,
        'utf8'
      );
    }
    assert(
      recovered?.status === 'succeeded',
      `Recovered run ended as ${recovered?.status ?? 'missing'}`
    );
    assert(
      detail.run.branch?.startsWith('qagent/'),
      'Run did not retain a dedicated QAgent branch'
    );
    assert(
      detail.providerCalls.some(
        (call) => call.provider === model.provider && call.model === model.model
      ),
      'Run did not record the configured live model provider'
    );
    assert(
      detail.providerCalls.some(
        (call) =>
          call.provider === model.provider &&
          call.model === model.model &&
          call.status === 'succeeded'
      ),
      'Run did not complete a structured live model call'
    );
    assert(
      detail.artifacts.some((artifact) => artifact.kind === 'screenshot'),
      'Run did not retain browser screenshot evidence'
    );
    assert(detail.specialistHandoffs.length > 0, 'Run did not record specialist handoffs');
    assert(
      detail.specialistHandoffs.every((handoff) => handoff.evidenceIds.length > 0),
      'A specialist handoff is missing durable evidence'
    );
    assert(
      detail.events.filter((event) => event.kind === 'specialist.handoff').length ===
        detail.specialistHandoffs.length,
      'Specialist handoff records and events do not agree'
    );
    const specialistRoles = new Set(detail.specialistActivities.map((activity) => activity.role));
    for (const role of ['scout', 'trace', 'patch', 'proof', 'gate'] as const) {
      assert(specialistRoles.has(role), `Run did not record ${role} specialist activity`);
    }
    assert(
      detail.specialistActivities
        .filter((activity) => activity.status !== 'started' && activity.status !== 'cancelled')
        .every((activity) => activity.evidenceIds.length > 0),
      'A terminal specialist activity is missing durable evidence'
    );
    assert(
      detail.specialistDecisions.some(
        (decision) => decision.role === 'gate' && decision.action === 'complete'
      ),
      'Gate did not record the final completion decision'
    );
    assert(detail.run.recoveryCount > 0, 'Relaunched run did not increment its recovery count');
    assert(
      detail.events.some((event) => event.kind === 'run.interrupted'),
      'Relaunched run has no durable interruption event'
    );
    assert(
      detail.events.some((event) => event.kind === 'run.resumed'),
      'Relaunched run has no durable resume event'
    );

    const browserEvidenceEvents = detail.events.filter(
      (event) => event.kind === 'evidence.captured' && event.payload.kind === 'browser'
    );
    assert(browserEvidenceEvents.length > 0, 'Run did not record browser evidence reception');
    assert(
      browserEvidenceEvents.every((event) => event.artifactIds.length >= 3),
      'Browser evidence reception did not link screenshot, DOM, and report artifacts'
    );
    const receivedBrowserArtifactIds = new Set(
      browserEvidenceEvents.flatMap((event) => event.artifactIds)
    );
    assert(
      detail.artifacts.some(
        (artifact) => artifact.kind === 'screenshot' && receivedBrowserArtifactIds.has(artifact.id)
      ),
      'Browser evidence receiver did not retain a linked screenshot'
    );

    const publicationEvents = detail.events.filter((event) =>
      ['publication.created', 'publication.updated'].includes(event.kind)
    );
    const localPublishEvent = detail.events.findLast(
      (event) =>
        event.stage === 'publish' &&
        event.kind === 'stage.completed' &&
        typeof event.payload.message === 'string' &&
        event.payload.message.includes(detail.run.branch as string) &&
        event.payload.message.includes('available locally')
    );
    assert(detail.publication === null, 'Local smoke unexpectedly created a publication record');
    assert(publicationEvents.length === 0, 'Local smoke crossed the GitHub publication boundary');
    assert(localPublishEvent, 'Run did not record the local verified branch boundary');
    assert(
      detail.run.summary?.includes(`local branch ${detail.run.branch}`),
      'Final summary does not identify the verified local branch'
    );
    const verifiedBranch = detail.run.branch;
    assert(verifiedBranch, 'Run did not retain a dedicated QAgent branch');
    const branchSha = (
      await execFileAsync('git', ['rev-parse', '--verify', verifiedBranch], {
        cwd: repository,
      })
    ).stdout.trim();
    assert(/^[a-f0-9]{40}$/i.test(branchSha), 'Verified local branch does not resolve to a commit');
    const originalCheckoutStatus = (
      await execFileAsync('git', ['status', '--porcelain=v1'], { cwd: repository })
    ).stdout;
    assert(
      originalCheckoutStatus.trim() === '',
      'Packaged run modified the original fixture checkout'
    );
    const terminalEvidence = detail.terminalEvidence;
    assert(terminalEvidence, 'Succeeded run did not record terminal evidence');
    assert(terminalEvidence.outcome === 'succeeded', 'Terminal evidence outcome is not succeeded');
    assert(
      terminalEvidence.evidenceAvailability === 'ready',
      'Terminal evidence is not available for inspection'
    );
    assert(terminalEvidence.verificationId, 'Terminal evidence is not linked to verification');
    assert(
      detail.verification?.id === terminalEvidence.verificationId,
      'Terminal evidence references a different verification record'
    );
    assert(detail.manifest, 'Succeeded run did not record an immutable manifest');
    assert(
      terminalEvidence.artifactIds.includes(detail.manifest.artifactId),
      'Terminal evidence does not include the run manifest artifact'
    );
    assert(
      detail.artifacts.some(
        (artifact) => artifact.id === detail.manifest?.artifactId && artifact.kind === 'manifest'
      ),
      'Run manifest artifact is missing from the evidence ledger'
    );

    const evidenceMonitor = page.getByTestId('evidence-monitor');
    await evidenceMonitor.waitFor({ state: 'visible', timeout: 60_000 });
    await evidenceMonitor.locator('[data-availability="ready"]').waitFor({
      state: 'visible',
      timeout: 60_000,
    });
    await evidenceMonitor.getByRole('button', { name: /^Inspect / }).waitFor({
      state: 'visible',
      timeout: 60_000,
    });

    await page.screenshot({ path: join(outputRoot, 'run-recovered.png'), fullPage: true });
    await exportArtifacts(page, detail.artifacts);
    await closeApplication(application);
    application = null;
    assert(
      processLogText().trim().length > 0,
      'Packaged application did not emit a bounded startup/process shell stream'
    );
    await writeProcessLog();
    await writeEvidence({
      schemaVersion: 1,
      mode,
      target,
      checkedAt: new Date().toISOString(),
      installedExecutablePath: executablePath,
      sourceArtifact,
      attachmentMode: 'loopback-chromium-devtools',
      interruptedRunId,
      recoveredRunId: recovered.id,
      finalStatus: recovered.status,
      finalStage: recovered.stage,
      finalBranch: recovered.branch,
      restartRecovery: {
        recoveryCount: detail.run.recoveryCount,
        interrupted: true,
        resumed: true,
      },
      finalSummary: recovered.summary,
      localPublicationBoundary: {
        provider: 'local',
        branch: verifiedBranch,
        branchSha,
        originalCheckoutClean: true,
        publicationRecord: detail.publication,
        publicationEvents: publicationEvents.length,
        stageEvent: localPublishEvent,
      },
      browserEvidenceReceiver: {
        displayed: true,
        eventCount: browserEvidenceEvents.length,
        artifactIds: [...receivedBrowserArtifactIds].sort(),
      },
      model: {
        provider: model.provider,
        model: model.model,
        structuredCalls: detail.providerCalls,
      },
      specialistActivities: detail.specialistActivities,
      specialistHandoffs: detail.specialistHandoffs,
      terminalEvidence: detail.terminalEvidence ?? null,
      events: detail.events,
      artifacts: detail.artifacts,
    });
  }
} catch (error) {
  if (application) {
    try {
      await closeApplication(application);
    } catch (cleanupError) {
      appendProcessLog(`\n[qagent-smoke] cleanup failed: ${errorMessage(cleanupError)}\n`);
    } finally {
      application = null;
    }
  }
  await mkdir(outputRoot, { recursive: true });
  await writeProcessLog();
  await writeFile(
    join(outputRoot, 'installed-smoke-failure.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        mode,
        target,
        checkedAt: new Date().toISOString(),
        installedExecutablePath: executablePath,
        sourceArtifactPath: artifactPath,
        error: redactProcessText(errorMessage(error)),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  throw error;
} finally {
  if (application) await closeApplication(application).catch(() => undefined);
  if (process.env.QAGENT_KEEP_SMOKE_STATE !== 'true') {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

interface LiveModel {
  provider: 'openai' | 'anthropic' | 'google' | 'openai-compatible';
  model: string;
  baseUrl?: string;
}

interface PackagedApplication {
  browser: Browser;
  process: ChildProcess;
}

interface QAgentPageWindow {
  qagent: {
    request(input: unknown): Promise<unknown>;
  };
}

async function launch(model?: LiveModel): Promise<PackagedApplication> {
  const port = await availablePort();
  const child = spawn(
    executablePath,
    [
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userData}`,
    ],
    {
      env: packagedChildEnvironment(model),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout?.on('data', appendProcessLog);
  child.stderr?.on('data', appendProcessLog);
  let launchError: Error | null = null;
  child.once('error', (error) => {
    launchError = error;
  });
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    let lastConnectionError: unknown = null;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Packaged application exited before DevTools attachment (${child.exitCode ?? child.signalCode})`
        );
      }
      try {
        const browser = await chromium.connectOverCDP(endpoint, { timeout: 2_000 });
        return { browser, process: child };
      } catch (error) {
        lastConnectionError = error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    }
    throw new Error(
      `Timed out connecting to the packaged renderer DevTools endpoint: ${errorMessage(lastConnectionError)}`
    );
  } catch (error) {
    const ownedProcessIds = child.pid ? await descendantProcessIds(child.pid) : [];
    await terminateChild(child).catch(() => undefined);
    await terminateOwnedProcesses(ownedProcessIds, false).catch(() => undefined);
    throw error;
  }
}

function packagedChildEnvironment(model?: LiveModel): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    'APPDATA',
    'COMSPEC',
    'DBUS_SESSION_BUS_ADDRESS',
    'DISPLAY',
    'HOME',
    'LANG',
    'LC_ALL',
    'LD_LIBRARY_PATH',
    'LOCALAPPDATA',
    'LOGNAME',
    'PATH',
    'PATHEXT',
    'PROGRAMDATA',
    'SHELL',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USER',
    'USERPROFILE',
    'WAYLAND_DISPLAY',
    'WINDIR',
    'XAUTHORITY',
    'XDG_RUNTIME_DIR',
  ]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  const credentialName = model
    ? {
        openai: 'OPENAI_API_KEY',
        anthropic: 'ANTHROPIC_API_KEY',
        google: 'GOOGLE_API_KEY',
        'openai-compatible': 'OPENAI_API_KEY',
      }[model.provider]
    : null;
  if (credentialName && process.env[credentialName]) {
    environment[credentialName] = process.env[credentialName];
  }
  return {
    ...environment,
    QAGENT_BROWSER_PATH: chromium.executablePath(),
    QAGENT_DEBUG_STARTUP: 'true',
    QAGENT_DISABLE_AUTO_UPDATE: 'true',
    QAGENT_WEAVE_ENABLED: 'false',
  };
}

async function firstWindow(app: PackagedApplication): Promise<Page> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const page = app.browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith('qagent://app/'));
    if (page) return page;
    if (app.process.exitCode !== null || app.process.signalCode !== null) {
      throw new Error('Packaged application exited before creating its renderer');
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Timed out waiting for the packaged application renderer');
}

async function closeApplication(app: PackagedApplication): Promise<void> {
  const ownedProcessIds = app.process.pid ? await descendantProcessIds(app.process.pid) : [];
  await app.browser.close().catch(() => undefined);
  await terminateChild(app.process);
  await terminateOwnedProcesses(ownedProcessIds, false);
}

async function terminateAbruptly(app: PackagedApplication): Promise<void> {
  const ownedProcessIds = app.process.pid ? await descendantProcessIds(app.process.pid) : [];
  await app.browser.close().catch(() => undefined);
  await terminateChild(app.process, true);
  await terminateOwnedProcesses(ownedProcessIds, true);
}

async function terminateChild(child: ChildProcess, abrupt = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.kill(abrupt ? 'SIGKILL' : 'SIGTERM');
  if (!abrupt) {
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolveWait) => setTimeout(() => resolveWait(false), 10_000)),
    ]);
    if (stopped) return;
    child.kill('SIGKILL');
  }
  await Promise.race([
    exited,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Timed out stopping the packaged application')), 30_000)
    ),
  ]);
}

async function descendantProcessIds(rootProcessId: number): Promise<number[]> {
  const output =
    process.platform === 'win32'
      ? (
          await execFileAsync('powershell', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
          ])
        ).stdout
      : (await execFileAsync('ps', ['-axo', 'pid=,ppid='])).stdout;
  const childrenByParent = new Map<number, number[]>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const processId = Number.parseInt(match[1]!, 10);
    const parentProcessId = Number.parseInt(match[2]!, 10);
    const children = childrenByParent.get(parentProcessId) ?? [];
    children.push(processId);
    childrenByParent.set(parentProcessId, children);
  }
  const descendants: number[] = [];
  const pending = [...(childrenByParent.get(rootProcessId) ?? [])];
  while (pending.length > 0) {
    const processId = pending.pop()!;
    descendants.push(processId);
    pending.push(...(childrenByParent.get(processId) ?? []));
  }
  return descendants;
}

async function terminateOwnedProcesses(
  processIds: readonly number[],
  abrupt: boolean
): Promise<void> {
  let remaining = processIds.filter(processIsAlive);
  const initialSignal: NodeJS.Signals = abrupt ? 'SIGKILL' : 'SIGTERM';
  for (const processId of remaining.reverse()) terminateOwnedProcess(processId, initialSignal);
  remaining = await waitForOwnedProcessesToExit(processIds, 5_000);
  for (const processId of remaining.reverse()) terminateOwnedProcess(processId, 'SIGKILL');
  remaining = await waitForOwnedProcessesToExit(processIds, 5_000);
  assert(
    remaining.length === 0,
    `Owned packaged process(es) remained after cleanup: ${remaining.join(', ')}`
  );
}

async function waitForOwnedProcessesToExit(
  processIds: readonly number[],
  timeoutMs: number
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = processIds.filter(processIsAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    remaining = processIds.filter(processIsAlive);
  }
  return remaining;
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${processId}/stat`, 'utf8');
      const stateStart = stat.lastIndexOf(') ') + 2;
      if (stat[stateStart] === 'Z') return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function terminateOwnedProcess(processId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(processId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function chooseRepository(
  page: Page,
  selectedPath: string,
  applicationProcessId: number
): Promise<void> {
  await page.getByRole('button', { name: 'Choose folder' }).click();
  if (process.platform === 'darwin') {
    await execFileAsync('osascript', [
      '-e',
      `on run argv
set selectedPath to item 1 of argv
set targetPid to (item 2 of argv) as integer
tell application "System Events"
  set qagentProcess to first application process whose unix id is targetPid
  tell qagentProcess
    set frontmost to true
    set chooserReady to false
    repeat 40 times
      if exists sheet 1 of window 1 then
        set chooserReady to true
        exit repeat
      end if
      delay 0.25
    end repeat
    if chooserReady is false then error "QAgent directory chooser did not appear"
  end tell
  keystroke "g" using {command down, shift down}
  delay 1
  keystroke selectedPath
  delay 1
  key code 36
  delay 1
  key code 36
end tell
end run`,
      selectedPath,
      String(applicationProcessId),
    ]);
  } else if (process.platform === 'win32') {
    await execFileAsync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -AssemblyName System.Windows.Forms
$previous = Get-Clipboard -Raw -ErrorAction SilentlyContinue
try {
  Set-Clipboard -Value $args[0]
  [Microsoft.VisualBasic.Interaction]::AppActivate([int]$args[1])
  Start-Sleep -Milliseconds 500
  [System.Windows.Forms.SendKeys]::SendWait('^l')
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 500
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
} finally {
  if ($null -eq $previous) { Set-Clipboard -Value '' } else { Set-Clipboard -Value $previous }
}`,
      selectedPath,
      String(applicationProcessId),
    ]);
  } else {
    const windowId = (
      await execFileAsync('xdotool', [
        'search',
        '--onlyvisible',
        '--pid',
        String(applicationProcessId),
      ])
    ).stdout
      .trim()
      .split(/\r?\n/)[0];
    assert(
      windowId,
      `Could not find the packaged application window for PID ${applicationProcessId}`
    );
    await execFileAsync('xdotool', ['windowactivate', '--sync', windowId]);
    await execFileAsync('xdotool', [
      'key',
      '--window',
      windowId,
      '--delay',
      '100',
      'ctrl+l',
      'type',
      '--window',
      windowId,
      '--delay',
      '10',
      selectedPath,
      'key',
      '--window',
      windowId,
      'Return',
      'sleep',
      '1',
      'key',
      '--window',
      windowId,
      'Return',
    ]);
  }
  await waitForText(page, 'Executable boundary', 60_000);
}

async function onboard(page: Page, model: LiveModel): Promise<void> {
  await page.getByLabel('I trust this repository to run every command listed above.').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Model provider').selectOption(model.provider);
  await page.getByLabel('Model ID').fill(model.model);
  if (model.provider === 'openai-compatible') {
    await page.getByLabel('Endpoint').fill(model.baseUrl as string);
  }
  const browserProvider = page.getByLabel('Browser provider');
  if (await browserProvider.count()) await browserProvider.selectOption('local');
  await page.getByLabel('Publication').selectOption('local');
  const weave = page.getByLabel('Send redacted run traces to Weave');
  if (await weave.isChecked()) await weave.uncheck();
  await page.getByRole('button', { name: 'Save and check' }).click();
  await waitForText(page, 'Ready to run.', 120_000);
}

async function prepareFixture(): Promise<void> {
  await cp(resolve('fixtures/sample-web-app'), repository, { recursive: true });
  const configPath = join(repository, '.qagent.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8')) as {
    target: { url: string; start: { env: Record<string, string> } };
    limits: { maxIterations: number; maxRunMinutes: number };
  };
  const port = await availablePort();
  config.target.url = `http://127.0.0.1:${port}`;
  config.target.start.env.PORT = String(port);
  config.limits.maxIterations = 4;
  config.limits.maxRunMinutes = 12;
  await writeFile(configPath, YAML.stringify(config), 'utf8');
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-m', 'fixture baseline']);
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose()))
  );
  if (!port) throw new Error('Could not allocate a fixture port');
  return port;
}

async function bootstrap(page: Page): Promise<BootstrapSnapshot> {
  const value = await page.evaluate(() =>
    (window as unknown as QAgentPageWindow).qagent.request({
      method: 'bootstrap',
      params: {},
    })
  );
  return BootstrapSnapshotSchema.parse(value);
}

async function runDetail(page: Page, runId: string): Promise<RunDetail> {
  const value = await page.evaluate(
    ({ id }) =>
      (window as unknown as QAgentPageWindow).qagent.request({
        method: 'run.detail',
        params: { runId: id },
      }),
    { id: runId }
  );
  return RunDetailSchema.parse(value);
}

async function waitForNewActiveRun(
  page: Page,
  excludedRunIds: ReadonlySet<string>,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await bootstrap(page);
    const run = snapshot.runs.data?.find((candidate) => !excludedRunIds.has(candidate.id));
    if (run && (run.status === 'queued' || run.status === 'running')) return run.id;
    if (run) {
      throw new Error(
        `Packaged run ${run.id} became ${run.status} before restart interruption: ${
          run.summary ?? 'no summary'
        }`
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('Timed out waiting for the packaged application to expose the launched run');
}

async function waitForRunCompletion(page: Page, runId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await bootstrap(page);
    const run = snapshot.runs.data?.find((candidate) => candidate.id === runId);
    if (
      run &&
      ['succeeded', 'failed', 'cancelled', 'policy_blocked', 'waiting_for_intervention'].includes(
        run.status
      )
    ) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  throw new Error(`Timed out waiting for recovered run ${runId}`);
}

async function exportArtifacts(page: Page, artifacts: RunDetail['artifacts']): Promise<void> {
  const exportable = artifacts.filter(
    (artifact) =>
      artifact.kind === 'log' || artifact.kind === 'screenshot' || artifact.kind === 'patch'
  );
  const directory = join(outputRoot, 'artifacts');
  await mkdir(directory, { recursive: true });
  for (const artifact of exportable) {
    const preview = await page.evaluate(
      ({ id }) =>
        (window as unknown as QAgentPageWindow).qagent.request({
          method: 'artifact.read',
          params: { artifactId: id },
        }),
      { id: artifact.id }
    );
    const parsed = z
      .object({ encoding: z.enum(['base64', 'utf8']), data: z.string() })
      .parse(preview);
    const data = parsed.encoding === 'base64' ? Buffer.from(parsed.data, 'base64') : parsed.data;
    await writeFile(join(directory, `${safeName(artifact.id)}-${safeName(artifact.name)}`), data);
  }
}

function liveModelConfiguration(): LiveModel {
  const provider = z
    .enum(['openai', 'anthropic', 'google', 'openai-compatible'])
    .parse(process.env.QAGENT_SMOKE_MODEL_PROVIDER);
  const model = z.string().min(1).parse(process.env.QAGENT_SMOKE_MODEL);
  const baseUrl =
    provider === 'openai-compatible'
      ? z.url().parse(process.env.QAGENT_SMOKE_MODEL_BASE_URL)
      : undefined;
  const requiredCredential = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY',
    'openai-compatible': null,
  }[provider];
  if (requiredCredential && !process.env[requiredCredential]) {
    throw new Error(`${requiredCredential} is required for live packaged smoke`);
  }
  return { provider, model, baseUrl };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync(
    'git',
    ['-c', 'user.name=QAgent smoke', '-c', 'user.email=smoke@qagent.local', ...args],
    { cwd }
  );
}

async function waitForText(page: Page, text: string, timeout: number): Promise<void> {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
}

async function writeEvidence(value: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(outputRoot, 'installed-smoke.json'),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8'
  );
}

async function resetOutputRoot(): Promise<void> {
  const workspaceRoot = resolve('.');
  const outputRelative = relative(workspaceRoot, outputRoot);
  assert(
    outputRelative.length > 0 && !outputRelative.startsWith('..') && !isAbsolute(outputRelative),
    `Smoke output must be a child of the workspace: ${outputRoot}`
  );
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
}

async function writeProcessLog(): Promise<void> {
  await writeFile(join(outputRoot, 'shell-stream.log'), processLogText(), 'utf8');
}

function appendProcessLog(data: Buffer | string): void {
  if (processLogBytes >= processLogLimitBytes) return;
  const text = String(data);
  const available = processLogLimitBytes - processLogBytes;
  const bounded = Buffer.from(text).subarray(0, available).toString();
  processLog.push(bounded);
  processLogBytes += Buffer.byteLength(bounded);
}

function processLogText(): string {
  return redactProcessText(processLog.join(''));
}

function redactProcessText(value: string): string {
  return processLogRedactor.redactText(value).text;
}

function processSecretVariants(): string[] {
  const variants = new Set<string>();
  for (const secret of processSecrets) {
    variants.add(secret);
    if (secret.length < 8) continue;
    variants.add(encodeURIComponent(secret));
    variants.add(new URLSearchParams([['value', secret]]).toString().slice('value='.length));
    const base64 = Buffer.from(secret).toString('base64');
    variants.add(base64);
    variants.add(base64.replace(/=+$/u, ''));
    variants.add(Buffer.from(secret).toString('base64url'));
  }
  return [...variants];
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function parseArguments(arguments_: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const argument of arguments_) {
    const separator = argument.indexOf('=');
    if (!argument.startsWith('--') || separator < 3) continue;
    parsed.set(argument.slice(2, separator), argument.slice(separator + 1));
  }
  return parsed;
}

function safeName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '-');
}

function requiredArgument(name: string): string {
  const value = argumentsMap.get(name);
  if (!value) throw new Error(`Missing --${name}=...`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}
