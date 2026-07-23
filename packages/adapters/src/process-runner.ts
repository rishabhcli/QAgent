import { realpath } from 'node:fs/promises';
import type { CommandSpec } from '@qagent/contracts';
import { execa, type ResultPromise } from 'execa';
import { assertPathContained } from './paths.js';

export interface CommandResult {
  executable: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  combined: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ManagedProcess {
  result: Promise<CommandResult>;
  stop: () => Promise<void>;
}

export class ProcessRunner {
  async run(root: string, spec: CommandSpec, signal?: AbortSignal): Promise<CommandResult> {
    const cwd = await this.resolveCwd(root, spec.cwd);
    const startedAt = Date.now();
    const result = await execa(spec.executable, spec.args, {
      cwd,
      env: { ...process.env, ...spec.env },
      reject: false,
      timeout: spec.timeoutMs,
      cancelSignal: signal,
      all: true,
      cleanup: true,
    });
    return {
      executable: spec.executable,
      args: spec.args,
      exitCode: result.exitCode ?? null,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      combined: String(result.all ?? ''),
      durationMs: Date.now() - startedAt,
      timedOut: result.timedOut,
    };
  }

  async start(root: string, spec: CommandSpec, signal?: AbortSignal): Promise<ManagedProcess> {
    const cwd = await this.resolveCwd(root, spec.cwd);
    const startedAt = Date.now();
    const child: ResultPromise = execa(spec.executable, spec.args, {
      cwd,
      env: { ...process.env, ...spec.env },
      reject: false,
      cancelSignal: signal,
      all: true,
      cleanup: true,
    });
    return {
      result: child.then((result) => ({
        executable: spec.executable,
        args: spec.args,
        exitCode: result.exitCode ?? null,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
        combined: String(result.all ?? ''),
        durationMs: Date.now() - startedAt,
        timedOut: result.timedOut,
      })),
      stop: async () => {
        child.kill('SIGTERM');
        await child.catch(() => undefined);
      },
    };
  }

  private async resolveCwd(root: string, cwd: string): Promise<string> {
    const contained = assertPathContained(root, cwd);
    return realpath(contained);
  }
}
