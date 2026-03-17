/**
 * Git Clone Infrastructure
 *
 * Provides utilities for cloning GitHub repositories locally,
 * installing dependencies, starting development servers, and
 * managing the local development environment for QAgent testing.
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import type { ClonedRepo } from '@/lib/types';

export type PackageManager = 'npm' | 'yarn' | 'pnpm';

export interface SetupOptions {
  branch?: string;
  startPort?: number;
  serverTimeout?: number;
  installTimeout?: number;
  cloneTimeout?: number;
}

const DEFAULT_OPTIONS: Required<SetupOptions> = {
  branch: '',
  startPort: 3001,
  serverTimeout: 60000,
  installTimeout: 120000,
  cloneTimeout: 60000,
};

/**
 * Clone a GitHub repository to a temporary directory
 */
export async function cloneRepository(
  repoFullName: string,
  githubToken: string,
  branch?: string
): Promise<string> {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid repository name: ${repoFullName}`);
  }

  // Create temp directory
  const tempDir = path.join(os.tmpdir(), `qagent-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const repoPath = path.join(tempDir, repo);

  // Clone using HTTPS with token for authentication
  const cloneUrl = `https://${githubToken}@github.com/${owner}/${repo}.git`;

  console.log(`[GitClone] Cloning ${repoFullName} to ${repoPath}...`);

  try {
    const cloneArgs = ['clone', '--depth', '1'];
    if (branch) {
      cloneArgs.push('--branch', branch);
    }
    cloneArgs.push(cloneUrl, repoPath);

    execSync(`git ${cloneArgs.join(' ')}`, {
      stdio: 'pipe',
      timeout: DEFAULT_OPTIONS.cloneTimeout,
    });

    console.log(`[GitClone] Successfully cloned ${repoFullName}`);
    return repoPath;
  } catch (error) {
    // Clean up on failure
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw new Error(
      `Failed to clone repository: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Detect the package manager used in the repository
 */
export function detectPackageManager(repoPath: string): PackageManager {
  if (fs.existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(path.join(repoPath, 'yarn.lock'))) {
    return 'yarn';
  }
  return 'npm';
}

/**
 * Install dependencies using the detected package manager
 * Returns true if dependencies were installed, false if skipped (no package.json)
 */
export async function installDependencies(
  repoPath: string,
  timeout: number = DEFAULT_OPTIONS.installTimeout
): Promise<boolean> {
  // Check if package.json exists
  const packageJsonPath = path.join(repoPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    console.log(`[GitClone] No package.json found, skipping dependency installation`);
    return false;
  }

  const pm = detectPackageManager(repoPath);
  console.log(`[GitClone] Installing dependencies with ${pm}...`);

  const installCommand =
    pm === 'npm'
      ? 'npm install --ignore-scripts'
      : `${pm} install --ignore-scripts`;

  try {
    execSync(installCommand, {
      cwd: repoPath,
      stdio: 'pipe',
      timeout,
      env: {
        ...process.env,
        CI: 'true', // Suppress interactive prompts
      },
    });

    console.log(`[GitClone] Dependencies installed successfully`);
    return true;
  } catch (error) {
    throw new Error(
      `Failed to install dependencies: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Find an available port starting from the given port
 */
export async function findAvailablePort(startPort: number = 3001): Promise<number> {
  const isPortAvailable = (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      server.listen(port);
    });
  };

  let port = startPort;
  while (port < startPort + 100) {
    if (await isPortAvailable(port)) {
      return port;
    }
    port++;
  }

  throw new Error(`No available port found between ${startPort} and ${startPort + 100}`);
}

/**
 * Start the development server
 */
export async function startDevServer(
  repoPath: string,
  port: number,
  timeout: number = DEFAULT_OPTIONS.serverTimeout
): Promise<ChildProcess> {
  const pm = detectPackageManager(repoPath);
  const devCommand = pm === 'npm' ? 'npm' : pm;
  const devArgs = pm === 'npm' ? ['run', 'dev'] : ['dev'];

  console.log(`[GitClone] Starting dev server on port ${port}...`);

  const serverProcess = spawn(devCommand, devArgs, {
    cwd: repoPath,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'development',
    },
    stdio: 'pipe',
    detached: false,
  });

  // Collect output for debugging
  let output = '';
  serverProcess.stdout?.on('data', (data) => {
    output += data.toString();
    if (process.env.DEBUG === 'true') {
      console.log(`[DevServer] ${data.toString().trim()}`);
    }
  });

  serverProcess.stderr?.on('data', (data) => {
    output += data.toString();
    if (process.env.DEBUG === 'true') {
      console.error(`[DevServer] ${data.toString().trim()}`);
    }
  });

  serverProcess.on('error', (error) => {
    console.error(`[GitClone] Dev server error:`, error);
  });

  serverProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[GitClone] Dev server exited with code ${code}`);
    }
  });

  return serverProcess;
}

/**
 * Wait for the server to be ready
 */
export async function waitForServerReady(
  url: string,
  timeout: number = DEFAULT_OPTIONS.serverTimeout
): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 1000;

  console.log(`[GitClone] Waiting for server at ${url}...`);

  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok || response.status === 404) {
        // 404 is ok - server is running but route may not exist
        console.log(`[GitClone] Server is ready at ${url}`);
        return true;
      }
    } catch {
      // Server not ready yet, continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  console.error(`[GitClone] Server failed to start within ${timeout}ms`);
  return false;
}

/**
 * Clone and install dependencies only (no dev server)
 * Use this for CODE-ONLY analysis
 */
export async function cloneAndInstall(
  repoFullName: string,
  githubToken: string,
  options: SetupOptions = {}
): Promise<ClonedRepo> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // 1. Clone repository
  const repoPath = await cloneRepository(repoFullName, githubToken, opts.branch || undefined);

  try {
    // 2. Install dependencies (optional - skips if no package.json)
    const hasPackageJson = await installDependencies(repoPath, opts.installTimeout);

    if (hasPackageJson) {
      console.log(`[GitClone] Node.js repository ready for analysis at ${repoPath}`);
    } else {
      console.log(`[GitClone] Non-Node.js repository ready for analysis at ${repoPath}`);
    }

    return {
      repoPath,
      devServerPort: 0,
      devServerUrl: '',
      devServerProcess: null as unknown as ChildProcess,
      cleanup: async () => {
        // Just remove the directory, no server to stop
        try {
          const tempDir = path.dirname(repoPath);
          fs.rmSync(tempDir, { recursive: true, force: true });
          console.log(`[GitClone] Cleaned up ${tempDir}`);
        } catch (error) {
          console.error(`[GitClone] Failed to clean up:`, error);
        }
      },
    };
  } catch (error) {
    // Clean up on failure
    try {
      fs.rmSync(path.dirname(repoPath), { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Set up a complete local development environment WITH dev server
 * Use this when you need to run browser tests
 */
export async function setupLocalRepo(
  repoFullName: string,
  githubToken: string,
  options: SetupOptions = {}
): Promise<ClonedRepo> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // 1. Clone repository
  const repoPath = await cloneRepository(repoFullName, githubToken, opts.branch || undefined);

  try {
    // 2. Install dependencies
    await installDependencies(repoPath, opts.installTimeout);

    // 3. Find available port
    const port = await findAvailablePort(opts.startPort);

    // 4. Start dev server
    const devServerProcess = await startDevServer(repoPath, port, opts.serverTimeout);

    // 5. Wait for server to be ready
    const devServerUrl = `http://localhost:${port}`;
    const isReady = await waitForServerReady(devServerUrl, opts.serverTimeout);

    if (!isReady) {
      // Clean up if server fails to start
      devServerProcess.kill('SIGTERM');
      fs.rmSync(path.dirname(repoPath), { recursive: true, force: true });
      throw new Error('Dev server failed to start');
    }

    console.log(`[GitClone] Local environment ready at ${devServerUrl}`);

    return {
      repoPath,
      devServerPort: port,
      devServerUrl,
      devServerProcess,
      cleanup: async () => {
        await cleanupRepo({
          repoPath,
          devServerPort: port,
          devServerUrl,
          devServerProcess,
          cleanup: async () => {},
        });
      },
    };
  } catch (error) {
    // Clean up on failure
    try {
      fs.rmSync(path.dirname(repoPath), { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Create a new branch for fixes
 */
export async function createFixBranch(repoPath: string, branchName: string): Promise<void> {
  console.log(`[GitClone] Creating fix branch: ${branchName}`);

  try {
    execSync(`git checkout -b ${branchName}`, {
      cwd: repoPath,
      stdio: 'pipe',
    });
    console.log(`[GitClone] Branch ${branchName} created`);
  } catch (error) {
    throw new Error(
      `Failed to create branch: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Commit changes and push to remote
 */
export async function commitAndPush(
  repoPath: string,
  message: string,
  branchName: string
): Promise<void> {
  console.log(`[GitClone] Committing and pushing changes...`);

  try {
    // Stage all changes
    execSync('git add -A', { cwd: repoPath, stdio: 'pipe' });

    // Check if there are changes to commit
    try {
      execSync('git diff --cached --quiet', { cwd: repoPath, stdio: 'pipe' });
      console.log(`[GitClone] No changes to commit`);
      return;
    } catch {
      // There are changes (diff --quiet exits with 1 if there are differences)
    }

    // Commit
    const commitMessage = `${message}\n\nApplied automatically by QAgent`;
    execSync(`git commit -m "${commitMessage}"`, {
      cwd: repoPath,
      stdio: 'pipe',
    });

    // Push
    execSync(`git push -u origin ${branchName}`, {
      cwd: repoPath,
      stdio: 'pipe',
    });

    console.log(`[GitClone] Changes pushed to ${branchName}`);
  } catch (error) {
    throw new Error(
      `Failed to commit and push: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Clean up the cloned repository and stop the dev server (if running)
 */
export async function cleanupRepo(clonedRepo: ClonedRepo): Promise<void> {
  console.log(`[GitClone] Cleaning up local environment...`);

  // Stop the dev server if it exists and is running
  if (clonedRepo.devServerProcess && typeof clonedRepo.devServerProcess.kill === 'function') {
    try {
      clonedRepo.devServerProcess.kill('SIGTERM');

      // Give it a moment to shut down gracefully
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Force kill if still running
      if (!clonedRepo.devServerProcess.killed) {
        clonedRepo.devServerProcess.kill('SIGKILL');
      }
    } catch {
      // Process may already be dead
    }
  }

  // Remove the temp directory
  try {
    const tempDir = path.dirname(clonedRepo.repoPath);
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`[GitClone] Cleaned up ${tempDir}`);
  } catch (error) {
    console.error(`[GitClone] Failed to clean up:`, error);
  }
}

/**
 * Create a pull request with all the fixes
 * Uses the existing GitHub patches library
 */
export { createPullRequest } from '@/lib/github/patches';

export default {
  cloneRepository,
  detectPackageManager,
  installDependencies,
  findAvailablePort,
  startDevServer,
  waitForServerReady,
  setupLocalRepo,
  createFixBranch,
  commitAndPush,
  cleanupRepo,
};
