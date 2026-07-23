import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { CommandSpec, QAgentConfig } from '@qagent/contracts';
import { QAgentConfigSchema } from '@qagent/contracts';
import YAML from 'yaml';

export type ProjectStack = 'node' | 'python' | 'ruby' | 'go' | 'java' | 'dotnet' | 'unknown';

export interface DetectedProject {
  name: string;
  path: string;
  stack: ProjectStack;
  configPath: string | null;
  config: QAgentConfig | null;
  suggestedTestCommands: CommandSpec[];
  suggestedVerifyCommands: CommandSpec[];
  suggestedStartCommand: CommandSpec | null;
  needsConfiguration: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function command(executable: string, args: string[], timeoutMs = 120_000): CommandSpec {
  return { executable, args, cwd: '.', env: {}, timeoutMs };
}

async function detectNode(root: string): Promise<Omit<DetectedProject, 'name' | 'path'>> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = manifest.scripts ?? {};
  const packageManager = (await exists(join(root, 'pnpm-lock.yaml')))
    ? 'pnpm'
    : (await exists(join(root, 'yarn.lock')))
      ? 'yarn'
      : (await exists(join(root, 'bun.lockb'))) || (await exists(join(root, 'bun.lock')))
        ? 'bun'
        : 'npm';
  const run = (script: string, timeout?: number) =>
    command(packageManager, packageManager === 'npm' ? ['run', script] : [script], timeout);
  const tests = ['test', 'test:run', 'test:e2e']
    .filter((name) => scripts[name] && !scripts[name]?.includes('no test specified'))
    .slice(0, 1)
    .map((name) => run(name, 300_000));
  const verify = ['test', 'typecheck', 'lint', 'build']
    .filter((name, index, values) => scripts[name] && values.indexOf(name) === index)
    .map((name) => run(name, name === 'build' ? 600_000 : 300_000));
  const startScript = ['dev', 'start'].find((name) => scripts[name]);
  return {
    stack: 'node',
    configPath: null,
    config: null,
    suggestedTestCommands: tests,
    suggestedVerifyCommands: verify,
    suggestedStartCommand: startScript ? run(startScript, 600_000) : null,
    needsConfiguration: true,
  };
}

async function detectWithoutConfig(root: string): Promise<Omit<DetectedProject, 'name' | 'path'>> {
  if (await exists(join(root, 'package.json'))) return detectNode(root);
  if (
    (await exists(join(root, 'pyproject.toml'))) ||
    (await exists(join(root, 'requirements.txt')))
  ) {
    const test = command('python', ['-m', 'pytest'], 300_000);
    return detected('python', test);
  }
  if (await exists(join(root, 'Gemfile'))) {
    return detected('ruby', command('bundle', ['exec', 'rspec'], 300_000));
  }
  if (await exists(join(root, 'go.mod'))) {
    return detected('go', command('go', ['test', './...'], 300_000));
  }
  if ((await exists(join(root, 'pom.xml'))) || (await exists(join(root, 'mvnw')))) {
    const executable = (await exists(join(root, 'mvnw'))) ? './mvnw' : 'mvn';
    return detected('java', command(executable, ['test'], 600_000));
  }
  if ((await exists(join(root, 'build.gradle'))) || (await exists(join(root, 'gradlew')))) {
    const executable = (await exists(join(root, 'gradlew'))) ? './gradlew' : 'gradle';
    return detected('java', command(executable, ['test'], 600_000));
  }
  const entries = await readdir(root, { withFileTypes: true });
  if (
    entries.some(
      (entry) => entry.isFile() && (entry.name.endsWith('.sln') || entry.name.endsWith('.csproj'))
    )
  ) {
    return detected('dotnet', command('dotnet', ['test'], 600_000));
  }
  return {
    stack: 'unknown',
    configPath: null,
    config: null,
    suggestedTestCommands: [],
    suggestedVerifyCommands: [],
    suggestedStartCommand: null,
    needsConfiguration: true,
  };
}

function detected(stack: ProjectStack, test: CommandSpec): Omit<DetectedProject, 'name' | 'path'> {
  return {
    stack,
    configPath: null,
    config: null,
    suggestedTestCommands: [test],
    suggestedVerifyCommands: [test],
    suggestedStartCommand: null,
    needsConfiguration: true,
  };
}

export async function detectProject(projectPath: string): Promise<DetectedProject> {
  const root = resolve(projectPath);
  const configPath = join(root, '.qagent.yml');
  if (await exists(configPath)) {
    const parsed = QAgentConfigSchema.parse(YAML.parse(await readFile(configPath, 'utf8')));
    const detectedProject = await detectWithoutConfig(root);
    return {
      ...detectedProject,
      name: parsed.project.name ?? basename(root),
      path: root,
      configPath,
      config: parsed,
      suggestedTestCommands: parsed.test.commands,
      suggestedVerifyCommands:
        parsed.verify.commands.length > 0 ? parsed.verify.commands : parsed.test.commands,
      suggestedStartCommand: parsed.target.start ?? null,
      needsConfiguration: false,
    };
  }
  const detectedProject = await detectWithoutConfig(root);
  return { ...detectedProject, name: basename(root), path: root };
}

export async function writeProjectConfig(
  projectPath: string,
  config: QAgentConfig,
  options: { force?: boolean } = {}
): Promise<string> {
  const path = join(resolve(projectPath), '.qagent.yml');
  if (!options.force && (await exists(path))) throw new Error('.qagent.yml already exists');
  const parsed = QAgentConfigSchema.parse(config);
  const document = `# yaml-language-server: $schema=https://qagent.dev/schema/v1.json\n${YAML.stringify(parsed)}`;
  await writeFile(path, document, { encoding: 'utf8', flag: options.force ? 'w' : 'wx' });
  return path;
}

export function buildInitialConfig(
  detectedProject: DetectedProject,
  model: QAgentConfig['model']
): QAgentConfig {
  if (detectedProject.suggestedTestCommands.length === 0) {
    throw new Error('No test command was detected; provide one explicitly');
  }
  return QAgentConfigSchema.parse({
    version: 1,
    project: { name: detectedProject.name },
    target: detectedProject.suggestedStartCommand
      ? { start: detectedProject.suggestedStartCommand }
      : {},
    test: { commands: detectedProject.suggestedTestCommands, browserFlows: [] },
    verify: { commands: detectedProject.suggestedVerifyCommands },
    browser: { provider: 'local', headless: true },
    model,
    publish: { provider: 'github', baseBranch: 'main', autoMerge: true },
    telemetry: { weave: { enabled: true, project: 'qagent', uploadArtifacts: false } },
  });
}
