import { resolve } from 'node:path';
import {
  buildInitialConfig,
  detectProject,
  migrateLegacyRedis,
  runDoctor,
  writeProjectConfig,
} from '@qagent/adapters';
import type { QAgentConfig, Run, RunEvent } from '@qagent/contracts';
import { createLocalRuntime, type LocalRuntime } from '@qagent/core';
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

  const run = program.command('run').description('start and inspect durable QA runs');
  run
    .command('start')
    .argument('<project-id>', 'trusted project UUID')
    .action(async (projectId: string) => {
      await withRuntime(program, async (runtime) => {
        const handle = await runtime.engine.startRun({ projectId, requestedBy: 'cli' });
        const completion = handle.result();
        for await (const event of handle.events()) printEvent(program, event);
        const result = await completion;
        output(program, result, `${result.status}: ${result.summary ?? result.error ?? result.id}`);
        process.exitCode = exitCodeForRun(result);
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
    .action(async (runId: string) => {
      await withRuntime(program, async (runtime) => {
        const record = runtime.engine.getRun(runId);
        if (!record) throw new Error('Run was not found');
        const detail = {
          run: record,
          events: runtime.engine.getRunEvents(runId),
          artifacts: runtime.storage.listArtifacts(runId),
          diagnosis: runtime.storage.getDiagnosis(runId),
          patch: runtime.storage.getPatch(runId),
          verification: runtime.storage.getVerification(runId),
          providerCalls: runtime.storage.listProviderCalls(runId),
        };
        output(program, detail, JSON.stringify(detail, null, 2));
      });
    });
  run
    .command('cancel')
    .argument('<run-id>')
    .action(async (runId: string) => {
      await withRuntime(program, async (runtime) => {
        await runtime.engine.cancelRun(runId, 'Cancellation requested through CLI');
        const record = runtime.engine.getRun(runId);
        output(
          program,
          record,
          record ? `${record.id}: cancellation requested` : 'Run was not found'
        );
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
