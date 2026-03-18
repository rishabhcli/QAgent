/**
 * Daytona Sandbox Lifecycle Manager
 *
 * Creates, provisions, and manages Daytona sandboxes for running
 * GitHub repositories in isolated cloud environments.
 */

import type { Sandbox } from '@daytonaio/sdk';
import { getDaytonaClient } from './client';
import { op, isWeaveEnabled } from '@/lib/weave';

export interface SandboxInstance {
  sandboxId: string;
  previewUrl: string;
  repoPath: string;
  sandbox: Sandbox;
  cleanup: () => Promise<void>;
}

/**
 * Create a Daytona sandbox, clone a repo, install deps, start dev server,
 * and return the publicly-accessible preview URL.
 * Traced by W&B Weave for observability when enabled.
 */
export const createSandboxForRepo = isWeaveEnabled()
  ? op(_createSandboxForRepo, { name: 'Daytona.createSandboxForRepo' })
  : _createSandboxForRepo;

async function _createSandboxForRepo(params: {
  repoFullName: string;
  githubToken: string;
  branch?: string;
  onStatus?: (message: string) => void;
}): Promise<SandboxInstance> {
  const { repoFullName, githubToken, branch, onStatus } = params;
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid repository name: ${repoFullName}`);
  }

  const daytona = getDaytonaClient();
  const status = onStatus || (() => {});
  const repoPath = `/home/daytona/repo`;

  // 1. Create sandbox
  status('Creating cloud sandbox...');
  const sandbox = await daytona.create(
    {
      language: 'typescript',
      envVars: {
        NODE_ENV: 'development',
        CI: 'true',
      },
      public: true,
      autoStopInterval: 30,
      autoDeleteInterval: 60,
      labels: {
        'qagent-run': 'true',
        repo: repoFullName,
      },
    },
    { timeout: 120 }
  );

  console.log(`[Daytona] Sandbox created: ${sandbox.id}`);

  try {
    // 2. Clone repository
    status(`Cloning ${repoFullName}...`);
    const cloneUrl = `https://github.com/${owner}/${repo}.git`;
    await sandbox.git.clone(
      cloneUrl,
      repoPath,
      branch || undefined,
      undefined,
      'x-access-token',
      githubToken
    );

    console.log(`[Daytona] Repository cloned to ${repoPath}`);

    // 3. Detect package manager and install
    status('Installing dependencies...');
    const pm = await detectPackageManager(sandbox, repoPath);
    const installCmd =
      pm === 'pnpm'
        ? 'npm install -g pnpm && pnpm install'
        : pm === 'yarn'
          ? 'yarn install'
          : 'npm install';

    const installResult = await sandbox.process.executeCommand(installCmd, repoPath, undefined, 180);
    if (installResult.exitCode !== 0) {
      console.error(`[Daytona] Install stderr: ${installResult.result.substring(0, 500)}`);
      throw new Error(`Dependency install failed (exit ${installResult.exitCode})`);
    }
    console.log(`[Daytona] Dependencies installed with ${pm}`);

    // 4. Start dev server in background
    status('Starting development server...');
    const devCmd =
      pm === 'pnpm'
        ? 'pnpm dev'
        : pm === 'yarn'
          ? 'yarn dev'
          : 'npm run dev';

    // Run dev server in background with nohup
    await sandbox.process.executeCommand(
      `nohup ${devCmd} > /tmp/devserver.log 2>&1 &`,
      repoPath
    );

    console.log(`[Daytona] Dev server starting...`);

    // 5. Wait for dev server to be ready and get preview URL
    status('Waiting for server to be ready...');
    const port = await detectDevServerPort(sandbox, repoPath);
    await waitForSandboxServer(sandbox, port);

    const previewLink = await sandbox.getPreviewLink(port);
    const previewUrl = previewLink.url;

    console.log(`[Daytona] Preview URL: ${previewUrl}`);
    status(`Sandbox ready at ${previewUrl}`);

    return {
      sandboxId: sandbox.id,
      previewUrl,
      repoPath,
      sandbox,
      cleanup: async () => {
        try {
          console.log(`[Daytona] Cleaning up sandbox ${sandbox.id}...`);
          await daytona.delete(sandbox, 30);
          console.log(`[Daytona] Sandbox ${sandbox.id} deleted`);
        } catch (err) {
          console.error(`[Daytona] Failed to delete sandbox:`, err);
        }
      },
    };
  } catch (error) {
    // Cleanup on failure
    try {
      await daytona.delete(sandbox, 30);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Detect package manager by checking for lock files in the sandbox
 */
async function detectPackageManager(
  sandbox: Sandbox,
  repoPath: string
): Promise<'npm' | 'yarn' | 'pnpm'> {
  try {
    const lsResult = await sandbox.process.executeCommand('ls -1', repoPath);
    const files = lsResult.result;

    if (files.includes('pnpm-lock.yaml')) return 'pnpm';
    if (files.includes('yarn.lock')) return 'yarn';
    return 'npm';
  } catch {
    return 'npm';
  }
}

/**
 * Detect what port the dev server will run on by inspecting package.json
 */
async function detectDevServerPort(
  sandbox: Sandbox,
  repoPath: string
): Promise<number> {
  try {
    const result = await sandbox.process.executeCommand(
      `node -e "const p=require('./package.json');const s=p.scripts?.dev||'';const m=s.match(/--port\\s+(\\d+)|-p\\s+(\\d+)/);console.log(m?m[1]||m[2]:'3000')"`,
      repoPath
    );
    const port = parseInt(result.result.trim(), 10);
    return isNaN(port) ? 3000 : port;
  } catch {
    return 3000;
  }
}

/**
 * Poll until the dev server inside the sandbox is responding
 */
async function waitForSandboxServer(
  sandbox: Sandbox,
  port: number,
  timeoutMs: number = 90000
): Promise<void> {
  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await sandbox.process.executeCommand(
        `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port} 2>/dev/null || echo "000"`,
        '/tmp'
      );
      const statusCode = result.result.trim();
      if (statusCode === '200' || statusCode === '404' || statusCode === '302' || statusCode === '301') {
        console.log(`[Daytona] Dev server ready on port ${port} (status: ${statusCode})`);
        return;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Dev server failed to start on port ${port} within ${timeoutMs / 1000}s`);
}
