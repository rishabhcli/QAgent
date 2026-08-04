import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { CorrectiveAction, DoctorCheck, DoctorReport, QAgentConfig } from '@qagent/contracts';
import { execa } from 'execa';
import { z } from 'zod';
import { detectBrowser, probeBrowserbaseProject } from './browser.js';
import { detectProject } from './config-loader.js';
import { GitRepository } from './git.js';
import { GitHubPublisher, type GitHubRepositoryProbe, parseGitHubRemote } from './github.js';
import { createModelProvider } from './model.js';
import { redactForTelemetry, WeaveTraceSink } from './telemetry.js';

export interface DoctorOptions {
  projectPath?: string;
  projectConfigPath?: string | null;
  qagentHome: string;
  config?: QAgentConfig;
  dependencies?: Partial<DoctorDependencies>;
}

export interface DoctorDependencies {
  nodeVersion: string;
  environment: NodeJS.ProcessEnv;
  modelProbeTimeoutMs: number;
  gitVersion(): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  access: typeof access;
  detectBrowser: typeof detectBrowser;
  detectProject: typeof detectProject;
  probeBrowserbase(apiKey: string, projectId: string, signal: AbortSignal): Promise<void>;
  probeGitHub(
    projectPath: string,
    token: string,
    baseBranch: string,
    signal: AbortSignal
  ): Promise<GitHubRepositoryProbe>;
  probeWeave(apiKey: string, project: string, signal: AbortSignal): Promise<string>;
  probeModel(
    config: QAgentConfig['model'],
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal
  ): Promise<void>;
}

export const DOCTOR_MODEL_PROBE_TIMEOUT_MS = 65_000;

const defaultDependencies: DoctorDependencies = {
  nodeVersion: process.versions.node,
  environment: process.env,
  modelProbeTimeoutMs: DOCTOR_MODEL_PROBE_TIMEOUT_MS,
  gitVersion: async () => {
    const result = await execa('git', ['--version'], { reject: false });
    return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
  },
  access,
  detectBrowser,
  detectProject,
  probeBrowserbase: async (apiKey, projectId, signal) => {
    await probeBrowserbaseProject(apiKey, projectId, signal);
  },
  probeGitHub: async (projectPath, token, baseBranch, signal) => {
    const repository = new GitRepository();
    const status = await repository.inspect(projectPath, { signal });
    const remote = status.origin ? parseGitHubRemote(status.origin) : null;
    if (!remote) throw new Error('Project origin is not a supported GitHub repository URL');
    return new GitHubPublisher(token, repository).probeRepository(remote, baseBranch, signal);
  },
  probeWeave: async (apiKey, project, signal) =>
    new WeaveTraceSink(project, false, { apiKey }).probeProject(signal),
  probeModel: async (config, environment, signal) => {
    const provider = createModelProvider(config, {
      openai: environment.OPENAI_API_KEY,
      anthropic: environment.ANTHROPIC_API_KEY,
      google: environment.GOOGLE_API_KEY,
      openaiCompatible: environment.OPENAI_API_KEY,
    });
    await provider.complete({
      purpose: 'other',
      system: 'Return the requested JSON and nothing else.',
      prompt: 'Return {"ready":true}.',
      schemaName: 'qagent_doctor_probe',
      schema: z.object({ ready: z.literal(true) }),
      signal,
    });
  },
};

function check(
  id: string,
  code: string,
  label: string,
  status: DoctorCheck['status'],
  detail: string,
  source: string,
  correctiveAction: CorrectiveAction | null,
  providerState?: DoctorCheck['providerState']
): DoctorCheck {
  return {
    id,
    code,
    label,
    status,
    detail,
    source,
    checkedAt: new Date().toISOString(),
    correctiveAction,
    providerState,
  };
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const runtime = { ...defaultDependencies, ...options.dependencies };
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(runtime.nodeVersion.split('.')[0]);
  checks.push(
    check(
      'node',
      nodeMajor === 24 ? 'node.ready' : 'node.version-mismatch',
      'Node.js runtime',
      nodeMajor === 24 ? 'pass' : 'warn',
      `Node ${runtime.nodeVersion}${nodeMajor === 24 ? '' : '; development is pinned to Node 24'}`,
      'process.versions',
      nodeMajor === 24
        ? null
        : {
            id: 'install-node-24',
            type: 'command',
            label: 'Install Node 24',
            description: 'Install and select the runtime declared by QAgent.',
            command: {
              executable: 'pnpm',
              args: ['env', 'use', '--global', '24'],
              cwd: '.',
              env: {},
              timeoutMs: 300_000,
            },
          }
    )
  );

  const git = await runtime.gitVersion();
  checks.push(
    check(
      'git',
      git.exitCode === 0 ? 'git.ready' : 'git.missing',
      'Git',
      git.exitCode === 0 ? 'pass' : 'fail',
      git.exitCode === 0 ? git.stdout : git.stderr || 'Git was not found',
      'local executable',
      git.exitCode === 0
        ? null
        : {
            id: 'install-git',
            type: 'external',
            label: 'Install Git',
            description: 'Open the official Git download page, then run Doctor again.',
            url: 'https://git-scm.com/downloads',
          }
    )
  );

  if (options.config?.browser.provider === 'browserbase') {
    const apiKey = runtime.environment.BROWSERBASE_API_KEY;
    const projectId = runtime.environment.BROWSERBASE_PROJECT_ID;
    if (!apiKey || !projectId) {
      checks.push(
        check(
          'browser',
          'browserbase.unconfigured',
          'Browserbase cloud browser',
          'fail',
          'BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are required',
          'environment or secure credential store',
          configureProviderAction(
            'configure-browserbase',
            'Configure Browserbase',
            'Add the API key and exact project ID, then run the authenticated project probe.'
          ),
          'unconfigured'
        )
      );
    } else {
      try {
        await runtime.probeBrowserbase(apiKey, projectId, AbortSignal.timeout(15_000));
        checks.push(
          check(
            'browser',
            'browserbase.healthy',
            'Browserbase cloud browser',
            'pass',
            `Authenticated access to Browserbase project ${projectId} was verified`,
            'Browserbase project API',
            null,
            'healthy'
          )
        );
      } catch (error) {
        checks.push(
          check(
            'browser',
            'browserbase.probe-failed',
            'Browserbase cloud browser',
            'fail',
            `Browserbase project probe failed: ${doctorError(error, runtime.environment)}`,
            'Browserbase project API',
            configureProviderAction(
              'repair-browserbase',
              'Review Browserbase connection',
              'Correct the API key or project ID, then run the authenticated project probe.'
            ),
            'error'
          )
        );
      }
    }
  } else {
    const browser = await runtime.detectBrowser(
      options.config?.browser.executablePath ?? runtime.environment.QAGENT_BROWSER_PATH,
      join(options.qagentHome, 'browsers')
    );
    checks.push(
      check(
        'browser',
        browser ? 'browser.configured' : 'browser.unconfigured',
        'Local browser',
        browser ? 'pass' : 'warn',
        browser
          ? `${browser.name} (${browser.source}) is configured at ${browser.executablePath}; startup and an end-to-end flow remain unverified`
          : 'No Chrome-compatible browser found; install the managed browser from QAgent',
        browser?.source ?? 'filesystem scan',
        browser
          ? null
          : {
              id: 'install-managed-browser',
              type: 'application',
              label: 'Install managed Chrome',
              description: 'Download QAgent-managed Chromium and re-run this check.',
              action: 'install_browser',
            },
        browser ? 'configured' : 'unconfigured'
      )
    );
  }

  if (options.projectPath) {
    try {
      await runtime.access(options.projectPath);
      const detected = await runtime.detectProject(options.projectPath, {
        configPath: options.projectConfigPath,
      });
      checks.push(
        check(
          'project-config',
          detected.config ? 'project-config.ready' : 'project-config.missing',
          'Project configuration',
          detected.config ? 'pass' : 'warn',
          detected.config
            ? `QAgent configuration is valid for a ${detected.stack} project`
            : `${detected.stack} project detected; run qagent init to create .qagent.yml`,
          detected.configPath ?? 'local project detection',
          detected.config
            ? null
            : {
                id: 'configure-project',
                type: 'application',
                label: 'Configure project',
                description:
                  'Review detected commands and create a validated QAgent configuration.',
                action: 'configure_project',
              }
        )
      );
    } catch (error) {
      checks.push(
        check(
          'project-config',
          'project-config.invalid',
          'Project configuration',
          'fail',
          error instanceof Error ? error.message : String(error),
          'local project detection',
          {
            id: 'repair-project-config',
            type: 'application',
            label: 'Repair project configuration',
            description: 'Return to project setup and correct the invalid configuration.',
            action: 'configure_project',
          }
        )
      );
    }
  }

  const modelConfig = options.config?.model;
  if (modelConfig) {
    const configured = credentialPresent(modelConfig.provider, runtime.environment);
    if (!configured) {
      checks.push(
        check(
          'model',
          'model.unconfigured',
          'Model provider',
          'fail',
          `${credentialName(modelConfig.provider)} is not configured`,
          'environment or secure credential store',
          {
            id: 'configure-model-provider',
            type: 'application',
            label: 'Configure model',
            description: 'Add the required credential or endpoint, then run the structured probe.',
            action: 'configure_provider',
          },
          'unconfigured'
        )
      );
    } else {
      try {
        await runtime.probeModel(
          modelConfig,
          runtime.environment,
          AbortSignal.timeout(runtime.modelProbeTimeoutMs)
        );
        checks.push(
          check(
            'model',
            'model.healthy',
            'Model provider',
            'pass',
            `${modelConfig.provider}/${modelConfig.model} returned valid structured output`,
            'structured provider probe',
            null,
            'healthy'
          )
        );
      } catch (error) {
        checks.push(
          check(
            'model',
            'model.probe-failed',
            'Model provider',
            'fail',
            `${modelConfig.provider}/${modelConfig.model} probe failed: ${doctorError(
              error,
              runtime.environment
            )}`,
            'structured provider probe',
            {
              id: 'repair-model-provider',
              type: 'application',
              label: 'Review model connection',
              description:
                'Correct the model ID, endpoint, or credential, then re-run the structured probe.',
              action: 'configure_provider',
            },
            'error'
          )
        );
      }
    }
  }

  if (options.config?.publish.provider === 'github') {
    const token = runtime.environment.GITHUB_TOKEN;
    if (!token || !options.projectPath) {
      checks.push(
        check(
          'github',
          'github.unconfigured',
          'GitHub publication',
          'fail',
          token
            ? 'A trusted project path is required to inspect the GitHub origin'
            : 'GITHUB_TOKEN is not configured',
          'environment or secure credential store',
          configureProviderAction(
            'configure-github',
            'Configure GitHub',
            'Connect a PAT and a GitHub origin, then run the authenticated repository probe.'
          ),
          'unconfigured'
        )
      );
    } else {
      try {
        const probe = await runtime.probeGitHub(
          options.projectPath,
          token,
          options.config.publish.baseBranch,
          AbortSignal.timeout(30_000)
        );
        assertGitHubReady(probe);
        checks.push(
          check(
            'github',
            'github.healthy',
            'GitHub publication',
            'pass',
            `${probe.identity.login} has verified push and pull-request write access to ${probe.repository.fullName}; ${probe.rules.active.length} active rules; checks ${probe.checks.combinedStatus}`,
            'GitHub authenticated repository probe',
            null,
            'healthy'
          )
        );
      } catch (error) {
        checks.push(
          check(
            'github',
            'github.probe-failed',
            'GitHub publication',
            'fail',
            `GitHub repository probe failed: ${doctorError(error, runtime.environment)}`,
            'GitHub authenticated repository probe',
            configureProviderAction(
              'repair-github',
              'Review GitHub connection',
              'Correct the token permissions, origin, or repository policy, then run the probe again.'
            ),
            'error'
          )
        );
      }
    }
  }

  if (options.config?.telemetry.weave.enabled) {
    const apiKey = runtime.environment.WANDB_API_KEY;
    if (!apiKey) {
      checks.push(
        check(
          'weave',
          'weave.unconfigured',
          'W&B Weave',
          'warn',
          'WANDB_API_KEY is not configured; local runs remain available',
          'environment or secure credential store',
          configureProviderAction(
            'configure-weave',
            'Configure Weave',
            'Add the W&B credential and verify the configured entity/project.'
          ),
          'unconfigured'
        )
      );
    } else {
      try {
        const project = await runtime.probeWeave(
          apiKey,
          options.config.telemetry.weave.project,
          AbortSignal.timeout(15_000)
        );
        const disclosureAccepted = truthy(runtime.environment.QAGENT_WEAVE_DISCLOSURE_ACCEPTED);
        checks.push(
          check(
            'weave',
            disclosureAccepted ? 'weave.healthy' : 'weave.disclosure-required',
            'W&B Weave',
            disclosureAccepted ? 'pass' : 'warn',
            disclosureAccepted
              ? `Authenticated access to ${project} was verified and trace disclosure is accepted`
              : `Authenticated access to ${project} was verified; trace disclosure is not accepted`,
            'W&B and Weave project APIs',
            disclosureAccepted
              ? null
              : {
                  id: 'review-weave-disclosure',
                  type: 'application',
                  label: 'Review Weave disclosure',
                  description: 'Review and explicitly accept the trace data boundary.',
                  action: 'review_policy',
                },
            'healthy'
          )
        );
      } catch (error) {
        checks.push(
          check(
            'weave',
            'weave.probe-failed',
            'W&B Weave',
            'warn',
            `Weave project probe failed: ${doctorError(error, runtime.environment)}; local runs remain available`,
            'W&B and Weave project APIs',
            configureProviderAction(
              'repair-weave',
              'Review Weave connection',
              'Correct the credential or entity/project; local execution will continue without telemetry.'
            ),
            'error'
          )
        );
      }
    }
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

function configureProviderAction(id: string, label: string, description: string): CorrectiveAction {
  return { id, type: 'application', label, description, action: 'configure_provider' };
}

function assertGitHubReady(probe: GitHubRepositoryProbe): void {
  if (
    probe.repository.archived ||
    probe.repository.disabled ||
    !probe.permissions.canPull ||
    !probe.permissions.canPush ||
    probe.permissions.pullRequests !== 'write' ||
    probe.rules.classicProtection === 'unavailable' ||
    probe.merge.allowedMethods.length === 0
  ) {
    throw new Error('GitHub did not verify the required publication capabilities');
  }
}

function doctorError(error: unknown, environment: NodeJS.ProcessEnv): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [key, value] of Object.entries(environment)) {
    if (!value || !/(key|token|secret|password|authorization|credential)/i.test(key)) continue;
    message = message.replaceAll(value, '[REDACTED]');
  }
  return String(redactForTelemetry(message)).slice(0, 1_000);
}

function truthy(value: string | undefined): boolean {
  return Boolean(value && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()));
}
