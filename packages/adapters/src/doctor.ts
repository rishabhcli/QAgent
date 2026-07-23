import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { DoctorCheck, DoctorReport, QAgentConfig } from '@qagent/contracts';
import { execa } from 'execa';
import { detectBrowser } from './browser.js';
import { detectProject } from './config-loader.js';

export interface DoctorOptions {
  projectPath?: string;
  qagentHome: string;
  config?: QAgentConfig;
  dependencies?: Partial<DoctorDependencies>;
}

export interface DoctorDependencies {
  nodeVersion: string;
  environment: NodeJS.ProcessEnv;
  gitVersion(): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  access: typeof access;
  detectBrowser: typeof detectBrowser;
  detectProject: typeof detectProject;
}

const defaultDependencies: DoctorDependencies = {
  nodeVersion: process.versions.node,
  environment: process.env,
  gitVersion: async () => {
    const result = await execa('git', ['--version'], { reject: false });
    return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
  },
  access,
  detectBrowser,
  detectProject,
};

function check(
  id: string,
  label: string,
  status: DoctorCheck['status'],
  detail: string,
  source: string
): DoctorCheck {
  return { id, label, status, detail, source, checkedAt: new Date().toISOString() };
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const runtime = { ...defaultDependencies, ...options.dependencies };
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(runtime.nodeVersion.split('.')[0]);
  checks.push(
    check(
      'node',
      'Node.js runtime',
      nodeMajor === 24 ? 'pass' : 'warn',
      `Node ${runtime.nodeVersion}${nodeMajor === 24 ? '' : '; development is pinned to Node 24'}`,
      'process.versions'
    )
  );

  const git = await runtime.gitVersion();
  checks.push(
    check(
      'git',
      'Git',
      git.exitCode === 0 ? 'pass' : 'fail',
      git.exitCode === 0 ? git.stdout : git.stderr || 'Git was not found',
      'local executable'
    )
  );

  const browser = await runtime.detectBrowser(
    options.config?.browser.executablePath ?? runtime.environment.QAGENT_BROWSER_PATH,
    join(options.qagentHome, 'browsers')
  );
  checks.push(
    check(
      'browser',
      'Local browser',
      browser ? 'pass' : 'warn',
      browser
        ? `${browser.name} (${browser.source}) at ${browser.executablePath}`
        : 'No Chrome-compatible browser found; install the managed browser from QAgent',
      browser?.source ?? 'filesystem scan'
    )
  );

  if (options.projectPath) {
    try {
      await runtime.access(options.projectPath);
      const detected = await runtime.detectProject(options.projectPath);
      checks.push(
        check(
          'project-config',
          'Project configuration',
          detected.config ? 'pass' : 'warn',
          detected.config
            ? `.qagent.yml is valid for a ${detected.stack} project`
            : `${detected.stack} project detected; run qagent init to create .qagent.yml`,
          detected.configPath ?? 'local project detection'
        )
      );
    } catch (error) {
      checks.push(
        check(
          'project-config',
          'Project configuration',
          'fail',
          error instanceof Error ? error.message : String(error),
          'local project detection'
        )
      );
    }
  }

  const modelConfig = options.config?.model;
  if (modelConfig) {
    const configured = credentialPresent(modelConfig.provider, runtime.environment);
    checks.push(
      check(
        'model',
        'Model provider',
        configured ? 'pass' : 'fail',
        configured
          ? `${modelConfig.provider}/${modelConfig.model} is configured`
          : `${credentialName(modelConfig.provider)} is not configured`,
        'environment or secure credential store'
      )
    );
  }

  const failed = checks.some((item) => item.status === 'fail');
  const warned = checks.some((item) => item.status === 'warn');
  return {
    status: failed ? 'blocked' : warned ? 'degraded' : 'ready',
    checks,
    checkedAt: new Date().toISOString(),
  };
}

function credentialPresent(
  provider: QAgentConfig['model']['provider'],
  environment: NodeJS.ProcessEnv
): boolean {
  if (provider === 'openai-compatible') return true;
  return Boolean(environment[credentialName(provider)]);
}

function credentialName(provider: QAgentConfig['model']['provider']): string {
  if (provider === 'openai') return 'OPENAI_API_KEY';
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (provider === 'google') return 'GOOGLE_API_KEY';
  return 'QAGENT_OPENAI_BASE_URL';
}
