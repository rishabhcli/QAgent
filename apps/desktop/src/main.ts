import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import started from 'electron-squirrel-startup';
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell } from 'electron';
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

if (started) app.quit();
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (process.env.QAGENT_DEBUG_STARTUP === 'true') {
  process.stderr.write(`[qagent] single instance lock ${hasSingleInstanceLock}\n`);
}
if (!hasSingleInstanceLock) app.quit();

let mainWindow: BrowserWindow | null = null;
let worker: EngineWorkerHost | null = null;
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
  const credentials = new CredentialStore(join(userData, 'credentials.json'));
  const preferencesStore = new PreferencesStore(join(userData, 'preferences.json'));
  const preferences = await preferencesStore.read();
  worker = new EngineWorkerHost(userData, credentials, preferences);

  await registerApplicationProtocol();
  debugStartup('protocol registered');
  hardenSession();
  registerIpc(credentials, preferencesStore);
  createWindow();
  debugStartup('window created');

  if (await autoUpdateEnabled()) {
    const { updateElectronApp } = await import('update-electron-app');
    updateElectronApp();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => worker?.stop());
app.on('will-quit', () => debugStartup('will quit'));
app.on('quit', (_event, exitCode) => debugStartup(`quit ${exitCode}`));

const BuildMetadataSchema = z.object({
  version: z.literal(1),
  platform: z.string(),
  arch: z.string(),
  signed: z.boolean(),
  updateEnabled: z.boolean(),
});

async function autoUpdateEnabled(): Promise<boolean> {
  if (!app.isPackaged || !['darwin', 'win32'].includes(process.platform)) return false;
  try {
    const metadata = BuildMetadataSchema.parse(
      JSON.parse(await readFile(join(process.resourcesPath, 'build-metadata.json'), 'utf8'))
    );
    return metadata.signed && metadata.updateEnabled && metadata.platform === process.platform;
  } catch {
    return false;
  }
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
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('qagent://app/') || url === MAIN_WINDOW_VITE_DEV_SERVER_URL;
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
    assertMainFrame(event.senderFrame?.url ?? '');
    return worker?.request(WorkerRequestSchema.parse(input));
  });
  ipcMain.handle('qagent:select-directory', async (event) => {
    assertMainFrame(event.senderFrame?.url ?? '');
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
    assertMainFrame(event.senderFrame?.url ?? '');
    return credentials.statuses();
  });
  ipcMain.handle('qagent:credential-set', async (event, input: unknown) => {
    assertMainFrame(event.senderFrame?.url ?? '');
    const value = z
      .object({
        provider: z.enum(['openai', 'anthropic', 'google', 'github', 'weave', 'browserbase']),
        value: z.string().max(16_384),
      })
      .parse(input);
    const status = await credentials.set(value.provider, value.value);
    await worker?.restart(await preferencesStore.read());
    return status;
  });
  ipcMain.handle('qagent:preferences-get', async (event) => {
    assertMainFrame(event.senderFrame?.url ?? '');
    return preferencesStore.read();
  });
  ipcMain.handle('qagent:preferences-set', async (event, input: unknown) => {
    assertMainFrame(event.senderFrame?.url ?? '');
    const preferences = z
      .object({ weaveDisclosureAccepted: z.boolean(), weaveEnabled: z.boolean() })
      .parse(input) as DesktopPreferences;
    await preferencesStore.write(preferences);
    await worker?.restart(preferences);
    return preferences;
  });
  ipcMain.handle('qagent:open-external', async (event, input: unknown) => {
    assertMainFrame(event.senderFrame?.url ?? '');
    const url = z.url().parse(input);
    if (!url.startsWith('https://')) throw new Error('Only HTTPS links may be opened');
    await shell.openExternal(url);
  });
}

function assertMainFrame(url: string): void {
  const allowed =
    url.startsWith('qagent://app/') ||
    url.startsWith('http://localhost:') ||
    url.startsWith('http://127.0.0.1:');
  if (!allowed) throw new Error('IPC request did not originate from the QAgent main frame');
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
