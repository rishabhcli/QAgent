import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import started from 'electron-squirrel-startup';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  Menu,
  net,
  protocol,
  session,
  shell,
} from 'electron';
import { z } from 'zod';
import { type DesktopPreferences, WorkerRequestSchema } from './ipc.js';
import { CredentialStore, PreferencesStore } from './secure-store.js';
import { EngineWorkerHost } from './worker-host.js';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'qagent',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);

const UPDATE_REPOSITORY = 'rishabhcli/QAgent';

if (started) app.quit();
if (process.platform === 'win32') app.setAppUserModelId('com.squirrel.qagent.QAgent');
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (process.env.QAGENT_DEBUG_STARTUP === 'true') {
  process.stderr.write(`[qagent] single instance lock ${hasSingleInstanceLock}\n`);
}
if (!hasSingleInstanceLock) app.quit();

let mainWindow: BrowserWindow | null = null;
let worker: EngineWorkerHost | null = null;
let workerShutdown: Promise<void> | null = null;
let workerShutdownComplete = false;
const debugStartup = (stage: string): void => {
  if (process.env.QAGENT_DEBUG_STARTUP === 'true') process.stderr.write(`[qagent] ${stage}\n`);
};

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  debugStartup('app ready');
  const userData = app.getPath('userData');
  debugStartup(`user data ${userData}`);
  const buildMetadata = await readBuildMetadata();
  const credentials = new CredentialStore(
    join(userData, 'credentials.json'),
    process.env,
    undefined,
    {
      persistentStorageAllowed: process.platform !== 'darwin' || buildMetadata?.signed === true,
    }
  );
  const preferencesStore = new PreferencesStore(join(userData, 'preferences.json'));
  const preferences = await preferencesStore.read();
  worker = new EngineWorkerHost(userData, credentials, preferences);

  await registerApplicationProtocol();
  debugStartup('protocol registered');
  hardenSession();
  registerIpc(credentials, preferencesStore);
  createWindow();
  debugStartup('window created');

  void startAutoUpdates(buildMetadata).catch((error: unknown) => {
    debugStartup(
      `auto-update disabled after initialization failure: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (workerShutdownComplete) return;
  event.preventDefault();
  if (workerShutdown) return;
  workerShutdown = Promise.resolve(worker?.shutdown())
    .catch((error: unknown) => {
      debugStartup(
        `engine shutdown failed: ${error instanceof Error ? error.message : String(error)}`
      );
    })
    .finally(() => {
      workerShutdownComplete = true;
      app.quit();
    });
});
app.on('will-quit', () => debugStartup('will quit'));
app.on('quit', (_event, exitCode) => debugStartup(`quit ${exitCode}`));

const BuildMetadataSchema = z.object({
  version: z.literal(3),
  appVersion: z.string().min(1),
  releaseTag: z.string().min(1).nullable(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  sourceDirty: z.boolean(),
  platform: z.enum(['darwin', 'win32', 'linux']),
  arch: z.enum(['arm64', 'x64']),
  signed: z.boolean(),
  notarized: z.boolean(),
  releaseChannel: z.enum(['stable', 'prerelease']),
  updateRepository: z.literal(UPDATE_REPOSITORY),
  updateEnabled: z.boolean(),
});

type BuildMetadata = z.infer<typeof BuildMetadataSchema>;

async function readBuildMetadata(): Promise<BuildMetadata | null> {
  if (!app.isPackaged) return null;
  try {
    return BuildMetadataSchema.parse(
      JSON.parse(await readFile(join(process.resourcesPath, 'build-metadata.json'), 'utf8'))
    );
  } catch {
    return null;
  }
}

function autoUpdateEnabled(metadata: BuildMetadata | null): boolean {
  if (
    !metadata ||
    process.env.QAGENT_DISABLE_AUTO_UPDATE === 'true' ||
    !['darwin', 'win32'].includes(process.platform)
  ) {
    return false;
  }
  return (
    metadata.updateEnabled &&
    !metadata.sourceDirty &&
    metadata.signed &&
    (process.platform !== 'darwin' || metadata.notarized) &&
    process.platform === 'darwin' &&
    metadata.releaseChannel === 'stable' &&
    metadata.appVersion === app.getVersion() &&
    metadata.releaseTag === `v${app.getVersion()}` &&
    metadata.platform === process.platform &&
    metadata.arch === process.arch
  );
}

async function startAutoUpdates(metadata: BuildMetadata | null): Promise<void> {
  if (!autoUpdateEnabled(metadata)) return;
  if (process.platform === 'win32' && process.argv.includes('--squirrel-firstrun')) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10_000));
  }
  const { updateElectronApp, UpdateSourceType } = await import('update-electron-app');
  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.ElectronPublicUpdateService,
      repo: UPDATE_REPOSITORY,
    },
    updateInterval: '1 hour',
    logger: updaterLogger,
  });
}

const updaterLogger = {
  log: (...values: unknown[]) => logUpdaterMessage(values),
  info: (...values: unknown[]) => logUpdaterMessage(values),
  warn: (...values: unknown[]) => logUpdaterMessage(values),
  error: (...values: unknown[]) => logUpdaterMessage(values),
};

function logUpdaterMessage(values: unknown[]): void {
  debugStartup(
    `updater ${values
      .map((value) => (value instanceof Error ? value.message : String(value)))
      .join(' ')}`
  );
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#f5f7f6',
    title: 'QAgent',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay:
      process.platform === 'darwin'
        ? false
        : { color: '#16231f', symbolColor: '#f4f7f5', height: 44 },
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  worker?.attach(mainWindow.webContents);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalHttpsUrl(url);
    if (external) void shell.openExternal(external);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isApplicationUrl(url) || url === MAIN_WINDOW_VITE_DEV_SERVER_URL;
    if (!allowed) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => debugStartup('window closed'));
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    debugStartup(`renderer gone ${details.reason} ${details.exitCode}`);
  });
  Menu.setApplicationMenu(buildMenu());
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadURL('qagent://app/index.html');
  }
  debugStartup('renderer requested');
}

async function registerApplicationProtocol(): Promise<void> {
  protocol.handle('qagent', async (request) => {
    debugStartup(`protocol request ${new URL(request.url).pathname}`);
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const rendererRoot = resolve(app.getAppPath(), '.vite', 'renderer', MAIN_WINDOW_VITE_NAME);
    const requestedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = resolve(rendererRoot, `.${requestedPath}`);
    const child = relative(rendererRoot, file);
    if (child === '..' || child.startsWith('../'))
      return new Response('Forbidden', { status: 403 });
    try {
      await readFile(file);
      return net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function registerIpc(credentials: CredentialStore, preferencesStore: PreferencesStore): void {
  ipcMain.handle('qagent:request', async (event, input: unknown) => {
    assertMainFrame(event);
    return worker?.request(WorkerRequestSchema.parse(input));
  });
  ipcMain.handle('qagent:select-directory', async (event) => {
    assertMainFrame(event);
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a web project',
      properties: ['openDirectory'],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('qagent:credentials-status', async (event) => {
    assertMainFrame(event);
    return credentials.statuses();
  });
  ipcMain.handle('qagent:credential-set', async (event, input: unknown) => {
    assertMainFrame(event);
    const value = z
      .object({
        provider: z.enum(['openai', 'anthropic', 'google', 'github', 'weave', 'browserbase']),
        value: z.string().max(16_384),
        deferRestart: z.boolean().default(false),
      })
      .parse(input);
    const previousValue = (await credentials.values())[value.provider] ?? '';
    const status = await credentials.set(value.provider, value.value);
    if (!value.deferRestart) {
      try {
        await worker?.restart(await preferencesStore.read());
      } catch (error) {
        await credentials.set(value.provider, previousValue);
        throw error;
      }
    }
    return status;
  });
  ipcMain.handle('qagent:preferences-get', async (event) => {
    assertMainFrame(event);
    return preferencesStore.read();
  });
  ipcMain.handle('qagent:preferences-set', async (event, input: unknown) => {
    assertMainFrame(event);
    const preferences = z
      .object({
        weaveDisclosureAccepted: z.boolean(),
        weaveEnabled: z.boolean(),
        browserbaseProjectId: z.string().trim().max(256),
      })
      .parse(input) as DesktopPreferences;
    const previous = await preferencesStore.read();
    await worker?.restart(preferences);
    try {
      await preferencesStore.write(preferences);
    } catch (error) {
      await worker?.restart(previous);
      throw error;
    }
    return preferences;
  });
  ipcMain.handle('qagent:open-external', async (event, input: unknown) => {
    assertMainFrame(event);
    const url = externalHttpsUrl(z.url().parse(input));
    if (!url) throw new Error('Only credential-free HTTPS links may be opened');
    await shell.openExternal(url);
  });
}

function assertMainFrame(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    !frame ||
    frame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('IPC request did not originate from the QAgent main frame');
  }
  const url = new URL(frame.url);
  const productionOrigin =
    url.protocol === 'qagent:' && url.hostname === 'app' && !url.username && !url.password;
  const developmentOrigin =
    !app.isPackaged && MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? url.origin === new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
      : false;
  if (!productionOrigin && !developmentOrigin) {
    throw new Error('IPC request did not originate from the QAgent application origin');
  }
}

function isApplicationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'qagent:' &&
      url.hostname === 'app' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

function externalHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function buildMenu(): Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}
