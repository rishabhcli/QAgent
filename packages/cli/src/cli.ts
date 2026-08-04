import { resolve } from 'node:path';
import {
  buildInitialConfig,
  detectProject,
  migrateLegacyRedis,
  runDoctor,
  writeProjectConfig,
} from '@qagent/adapters';
import {
  IntegrationProviderSchema,
  IntegrationVerifyRequestSchema,
  InterventionResolutionSchema,
  type IntegrationProvider,
  type IntegrationVerifyResult,
  type InterventionResolution,
  type QAgentConfig,
  type Run,
  type RunActionRequest,
  type RunActionResult,
  type RunEvent,
  type RunLaunch,
} from '@qagent/contracts';
import { createLocalRuntime, type LocalRuntime, type RunHandle } from '@qagent/core';
import { startMcpServer } from '@qagent/mcp';
import { Command, InvalidArgumentError } from 'commander';

interface GlobalOptions {
  home?: string;
  json?: boolean;
}

interface InitOptions {
  provider: QAgentConfig['model']['provider'];
  model: string;
  baseUrl?: string;
  force?: boolean;
  publish?: QAgentConfig['publish']['provider'];
  testExecutable?: string;
  testArg?: string[];
}

interface ResolveInterventionOptions {
  intervention: string;
  resolution: InterventionResolution;
  note?: string;
  evidence?: string[];
}

export function createCli(): Command {
  const program = new Command()
    .name('qagent')
    .description('Local-first autonomous QA for web applications')
    .version('0.2.0-beta.1')
    .option('--home <path>', 'QAgent state directory')
    .option('--json', 'emit stable JSON or NDJSON');

  program
    .command('init')
    .description('detect a web project and create .qagent.yml')
    .argument('[path]', 'project directory', '.')
    .requiredOption(
      '--provider <provider>',
      'openai, anthropic, google, or openai-compatible',
      parseProvider
    )
    .requiredOption('--model <model>', 'provider model identifier')
    .option('--base-url <url>', 'OpenAI-compatible endpoint')
    .option('--publish <provider>', 'github or local', parsePublishProvider, 'github')
    .option('--test-executable <command>', 'test executable when detection is ambiguous')
    .option('--test-arg <argument...>', 'arguments for --test-executable')
    .option('--force', 'replace an existing .qagent.yml')
    .action(async (path: string, options: InitOptions) => {
      const detected = await detectProject(resolve(path));
      if (options.testExecutable) {
        const command = {
          executable: options.testExecutable,
          args: options.testArg ?? [],
          cwd: '.',
          env: {},
          timeoutMs: 300_000,
        };
        detected.suggestedTestCommands = [command];
        detected.suggestedVerifyCommands = [command];
      }
      const config = buildInitialConfig(detected, {
        provider: options.provider,
        model: options.model,
        baseUrl: options.baseUrl,
      });
      config.publish.provider = options.publish ?? 'github';
      const pathWritten = await writeProjectConfig(detected.path, config, { force: options.force });
      output(
        program,
        { path: pathWritten, stack: detected.stack, config },
        `Created ${pathWritten}`
      );
    });

  program
    .command('doctor')
    .description('check local runtime, browser, Git, project, and model readiness')
    .argument('[path]', 'optional project directory')
    .action(async (path?: string) => {
      const globals = program.opts<GlobalOptions>();
      const detected = path ? await detectProject(resolve(path)) : null;
      const runtime = createLocalRuntime({ home: globals.home });
      try {
        const report = await runDoctor({
          projectPath: detected?.path,
          qagentHome: runtime.home,
          config: detected?.config ?? undefined,
        });
        output(program, report, formatDoctor(report));
        if (report.status === 'blocked') process.exitCode = 2;
      } finally {
        runtime.close();
      }
    });

  const project = program.command('project').description('manage trusted local projects');
  project
    .command('add')
    .argument('<path>', 'project directory')
    .option('--trust', 'trust the project to execute its configured commands')
    .action(async (path: string, options: { trust?: boolean }) => {
      await withRuntime(program, async (runtime) => {
        const record = await runtime.engine.addProject(resolve(path), options.trust ?? false);
        output(
          program,
          record,
          `${record.name} added (${record.trusted ? 'trusted' : 'not trusted'})\n${record.id}`
        );
      });
    });
  project.command('list').action(async () => {
    await withRuntime(program, async (runtime) => {
      const projects = runtime.engine.listProjects();
      output(
        program,
        projects,
        projects.length
          ? projects
              .map(
                (item) =>
                  `${item.id}  ${item.trusted ? 'trusted' : 'untrusted'}  ${item.name}  ${item.path}`
              )
              .join('\n')
          : 'No projects registered.'
      );
    });
  });

  const integration = program.command('integration').description('verify provider integrations');
  integration
    .command('verify')
    .argument('<provider>', 'model, browser, github, or weave', parseIntegrationProvider)
    .option('--project <project-id>', 'trusted project UUID for project-scoped probes')
    .option(
      '--weave-disclosure-accepted',
      'confirm the Weave telemetry disclosure before an end-to-end trace probe'
    )
    .action(
      async (
        provider: IntegrationProvider,
        options: { project?: string; weaveDisclosureAccepted?: boolean }
      ) => {
        await withRuntime(program, async (runtime) => {
          const request = IntegrationVerifyRequestSchema.parse({
            provider,
            projectId: options.project,
            requestedBy: 'cli',
            weaveDisclosureAccepted: options.weaveDisclosureAccepted ?? false,
          });
          if (request.projectId && !runtime.storage.getProject(request.projectId)?.trusted) {
            throw new Error('Trusted project was not found');
          }
          const result = await runtime.engine.verifyIntegration(request);
          output(program, result, formatIntegrationVerification(result));
        });
      }
    );

  const run = program.command('run').description('start and inspect durable QA runs');
  run
    .command('start')
    .argument('<project-id>', 'trusted project UUID')
    .action(async (projectId: string) => {
      await withRuntime(program, async (runtime) => {
        const handle = await runtime.engine.startRun({ projectId, requestedBy: 'cli' });
        const launch = await runtime.engine.waitForRunLaunch(handle.id);
        output(program, launch, formatRunLaunch(launch));
        await followRun(program, handle);
      });
    });
  run
    .command('list')
    .option('--project <project-id>', 'filter by project UUID')
    .action(async (options: { project?: string }) => {
      await withRuntime(program, async (runtime) => {
        const runs = runtime.engine.listRuns(options.project);
        output(
          program,
          runs,
          runs.length
            ? runs
                .map(
                  (item) =>
                    `${item.id}  ${item.status.padEnd(14)} ${item.stage.padEnd(12)} ${item.createdAt}`
                )
                .join('\n')
            : 'No runs recorded.'
        );
      });
    });
  run
    .command('show')
    .argument('<run-id>')
    .option(
      '--after-sequence <sequence>',
      'return events after this durable cursor',
      parseSequence,
      0
    )
    .action(async (runId: string, options: { afterSequence: number }) => {
      await withRuntime(program, async (runtime) => {
        const detail = runtime.engine.getRunDetail(runId, options.afterSequence);
        output(program, detail, JSON.stringify(detail, null, 2));
      });
    });
  run
    .command('cancel')
    .argument('<run-id>')
    .option(
      '--reason <reason>',
      'why the run is being cancelled',
      'Cancellation requested through CLI'
    )
    .action(async (runId: string, options: { reason: string }) => {
      await withRuntime(program, async (runtime) => {
        await executeCliRunAction(program, runtime, {
          action: 'cancel',
          runId,
          requestedBy: 'cli',
          reason: options.reason,
        });
      });
    });
  run
    .command('retry')
    .argument('<run-id>')
    .description('retry a terminal run only when its durable record offers retry')
    .action(async (runId: string) => {
      await withRuntime(program, async (runtime) => {
        await executeCliRunAction(program, runtime, {
          action: 'retry',
          runId,
          requestedBy: 'cli',
        });
      });
    });
  run
    .command('resume')
    .argument('<run-id>')
    .description('resume an interrupted run from its durable recovery checkpoint')
    .action(async (runId: string) => {
      await withRuntime(program, async (runtime) => {
        await executeCliRunAction(program, runtime, {
          action: 'resume',
          runId,
          requestedBy: 'cli',
        });
      });
    });
  run
    .command('reconnect')
    .argument('<run-id>')
    .description('reconnect a publication-waiting run without repeating completed work')
    .option(
      '--after-sequence <sequence>',
      'stream events after this durable cursor',
      parseSequence,
      0
    )
    .action(async (runId: string, options: { afterSequence: number }) => {
      await withRuntime(program, async (runtime) => {
        await executeCliRunAction(
          program,
          runtime,
          {
            action: 'reconnect',
            runId,
            requestedBy: 'cli',
            afterSequence: options.afterSequence,
          },
          options.afterSequence
        );
      });
    });
  run
    .command('resolve-intervention')
    .alias('resolve')
    .argument('<run-id>')
    .description('record an offered intervention resolution and continue its supported workflow')
    .requiredOption('--intervention <intervention-id>', 'active intervention UUID')
    .requiredOption(
      '--resolution <resolution>',
      'offered resolution kind',
      parseInterventionResolution
    )
    .option('--note <note>', 'concise operator note')
    .option('--evidence <artifact-id...>', 'artifact UUIDs supporting the resolution')
    .action(async (runId: string, options: ResolveInterventionOptions) => {
      await withRuntime(program, async (runtime) => {
        await executeCliRunAction(program, runtime, {
          action: 'resolve_intervention',
          runId,
          requestedBy: 'cli',
          interventionId: options.intervention,
          resolution: {
            kind: options.resolution,
            note: options.note,
            evidenceArtifactIds: options.evidence ?? [],
          },
        });
      });
    });

  const artifact = program
    .command('artifact')
    .description('inspect and export checksummed evidence');
  artifact
    .command('export')
    .argument('<artifact-id>')
    .argument('<destination>')
    .action(async (artifactId: string, destination: string) => {
      await withRuntime(program, async (runtime) => {
        const record = runtime.storage.getArtifact(artifactId);
        if (!record) throw new Error('Artifact was not found');
        const target = resolve(destination);
        await runtime.artifacts.export(record, target);
        output(
          program,
          { artifactId, destination: target },
          `Exported ${record.name} to ${target}`
        );
      });
    });

  program
    .command('migrate')
    .description('import durable data from v0.1 adapters')
    .command('redis')
    .requiredOption('--url <url>', 'legacy Redis URL')
    .action(async (options: { url: string }) => {
      await withRuntime(program, async (runtime) => {
        const result = await migrateLegacyRedis(runtime.storage, options.url);
        output(
          program,
          result,
          `Scanned ${result.scanned}; imported ${result.imported}; skipped ${result.skipped}.`
        );
      });
    });

  program
    .command('mcp')
    .description('serve trusted QAgent data and runs over stdio')
    .action(async () => {
      const globals = program.opts<GlobalOptions>();
      await startMcpServer(createLocalRuntime({ home: globals.home }));
    });

  return program;
}

async function withRuntime(
  program: Command,
  action: (runtime: LocalRuntime) => Promise<void>
): Promise<void> {
  const runtime = createLocalRuntime({ home: program.opts<GlobalOptions>().home });
  try {
    await action(runtime);
  } finally {
    runtime.close();
  }
}

function output(program: Command, value: unknown, human: string): void {
  if (program.opts<GlobalOptions>().json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else process.stdout.write(`${human}\n`);
}

function printEvent(program: Command, event: RunEvent): void {
  if (program.opts<GlobalOptions>().json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  const message = 'message' in event.payload ? event.payload.message : event.kind;
  process.stdout.write(
    `${String(event.sequence).padStart(3)}  ${event.stage.padEnd(12)} ${message}\n`
  );
}

async function executeCliRunAction(
  program: Command,
  runtime: LocalRuntime,
  request: RunActionRequest,
  afterSequence = 0
): Promise<RunActionResult> {
  const execution = await runtime.engine.executeRunAction(request);
  output(program, execution.result, formatRunActionResult(execution.result));
  if (!execution.result.accepted) {
    process.exitCode = 2;
    return execution.result;
  }
  if (execution.handle) await followRun(program, execution.handle, afterSequence);
  return execution.result;
}

async function followRun(program: Command, handle: RunHandle, afterSequence = 0): Promise<Run> {
  const completion = handle.result();
  for await (const event of handle.events(afterSequence)) printEvent(program, event);
  const result = await completion;
  output(program, result, `${result.status}: ${result.summary ?? result.error ?? result.id}`);
  process.exitCode = exitCodeForRun(result);
  return result;
}

function formatRunLaunch(launch: RunLaunch): string {
  const isolation =
    launch.isolation.state === 'ready'
      ? `${launch.isolation.worktreePath} (${launch.isolation.branch})`
      : `${launch.isolation.state}: ${launch.isolation.canonicalProjectPath}`;
  return [
    `Run ${launch.run.id}: ${launch.run.status}`,
    `Isolation: ${isolation}`,
    `Policy: dedicated worktree; active checkout mutation disabled`,
  ].join('\n');
}

function formatRunActionResult(result: RunActionResult): string {
  if (!result.accepted) {
    return `${result.action} rejected for ${result.requestedRunId}: ${result.reason}`;
  }
  const run =
    result.runId === result.requestedRunId
      ? result.runId
      : `${result.requestedRunId} -> ${result.runId}`;
  return `${result.action} accepted: ${run}`;
}

function formatIntegrationVerification(result: IntegrationVerifyResult): string {
  const correctiveAction = result.correctiveAction
    ? `\nAction: ${result.correctiveAction.label}: ${result.correctiveAction.description}`
    : '';
  return `${result.provider}: ${result.integration.status}\n${result.integration.detail}${correctiveAction}`;
}

function formatDoctor(report: Awaited<ReturnType<typeof runDoctor>>): string {
  return [
    `QAgent doctor: ${report.status}`,
    ...report.checks.map(
      (item) => `${item.status.toUpperCase().padEnd(4)} ${item.label}: ${item.detail}`
    ),
  ].join('\n');
}

function exitCodeForRun(run: Run): number {
  if (run.status === 'succeeded') return 0;
  if (run.status === 'cancelled') return 130;
  if (run.status === 'policy_blocked') return 4;
  if (run.error?.includes('API_KEY') || run.error?.includes('provider')) return 3;
  return 1;
}

function parseProvider(value: string): InitOptions['provider'] {
  const providers: InitOptions['provider'][] = [
    'openai',
    'anthropic',
    'google',
    'openai-compatible',
  ];
  if (!providers.includes(value as InitOptions['provider'])) {
    throw new InvalidArgumentError(`Unsupported provider: ${value}`);
  }
  return value as InitOptions['provider'];
}

function parsePublishProvider(value: string): QAgentConfig['publish']['provider'] {
  if (value !== 'github' && value !== 'local') {
    throw new InvalidArgumentError(`Unsupported publication provider: ${value}`);
  }
  return value;
}

function parseSequence(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError(`Sequence must be a non-negative integer: ${value}`);
  }
  return parsed;
}

function parseInterventionResolution(value: string): InterventionResolution {
  const result = InterventionResolutionSchema.safeParse(value);
  if (!result.success) {
    throw new InvalidArgumentError(`Unsupported intervention resolution: ${value}`);
  }
  return result.data;
}

function parseIntegrationProvider(value: string): IntegrationProvider {
  const result = IntegrationProviderSchema.safeParse(value);
  if (!result.success) {
    throw new InvalidArgumentError(`Unsupported integration provider: ${value}`);
  }
  return result.data;
}
