import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { app, type UtilityProcess, utilityProcess, type WebContents } from 'electron';
import type { DesktopPreferences, WorkerRequest, WorkerResponse } from './ipc.js';
import type { CredentialProvider, CredentialStore } from './secure-store.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const ENV_NAMES: Record<CredentialProvider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  github: 'GITHUB_TOKEN',
  weave: 'WANDB_API_KEY',
  browserbase: 'BROWSERBASE_API_KEY',
};

export class EngineWorkerHost {
  private child: UtilityProcess | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private webContents: WebContents | null = null;

  constructor(
    private readonly home: string,
    private readonly credentials: CredentialStore,
    private preferences: DesktopPreferences
  ) {}

  attach(webContents: WebContents): void {
    this.webContents = webContents;
  }

  async start(): Promise<void> {
    if (this.child) return;
    if (process.env.QAGENT_DEBUG_STARTUP === 'true') {
      process.stderr.write('[qagent] starting engine utility process\n');
    }
    const values = await this.credentials.values();
    const env: NodeJS.ProcessEnv = { ...process.env, QAGENT_HOME: this.home };
    for (const [provider, value] of Object.entries(values)) {
      if (value) env[ENV_NAMES[provider as CredentialProvider]] = value;
    }
    env.QAGENT_WEAVE_DISCLOSURE_ACCEPTED = String(this.preferences.weaveDisclosureAccepted);
    env.QAGENT_WEAVE_ENABLED = String(this.preferences.weaveEnabled);
    const workerPath = join(app.getAppPath(), 'dist', 'utility-bootstrap.js');
    this.child = utilityProcess.fork(workerPath, [], {
      serviceName: 'QAgent Engine',
      env,
      stdio: 'pipe',
    });
    if (process.env.QAGENT_DEBUG_STARTUP === 'true') {
      process.stderr.write('[qagent] engine utility process forked\n');
    }
    this.child.on('message', (message: WorkerResponse | { type: string; data: unknown }) => {
      if ('type' in message) {
        this.webContents?.send('qagent:event', message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(new Error(message.error ?? 'Engine request failed'));
    });
    this.child.on('exit', (code) => {
      const error = new Error(`QAgent engine worker exited with code ${code}`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.child = null;
    });
    this.child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
  }

  async restart(preferences = this.preferences): Promise<void> {
    this.preferences = preferences;
    this.stop();
    await this.start();
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }

  async request(request: WorkerRequest): Promise<unknown> {
    await this.start();
    if (!this.child) throw new Error('Engine worker is unavailable');
    const id = randomUUID();
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.postMessage({ id, request });
    return promise;
  }
}
