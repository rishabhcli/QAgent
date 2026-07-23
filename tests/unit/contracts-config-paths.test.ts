import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildInitialConfig,
  detectProject,
  projectDisplayName,
  assertPathContained,
  isSafeRelativePath,
  isSensitivePath,
  resolveQAgentHome,
  writeProjectConfig,
} from '@qagent/adapters';
import { QAgentConfigSchema, qagentConfigJsonSchema } from '@qagent/contracts';
import { describe, expect, it } from 'vitest';
import { temporaryDirectory, temporaryFixtureRepository } from '../helpers.js';

describe('configuration contract', () => {
  it('applies explicit defaults and publishes the same JSON Schema', () => {
    const parsed = QAgentConfigSchema.parse({
      version: 1,
      test: {
        commands: [{ executable: 'pnpm' }],
      },
      model: { provider: 'openai-compatible', model: 'qwen' },
    });

    expect(parsed.test.commands[0]).toEqual({
      executable: 'pnpm',
      args: [],
      cwd: '.',
      env: {},
      timeoutMs: 120_000,
    });
    expect(parsed.browser).toEqual({ provider: 'local', headless: true });
    expect(parsed.publish).toMatchObject({ provider: 'github', autoMerge: true });
    expect(qagentConfigJsonSchema()).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
    });
  });

  it('rejects shell strings, invalid URLs, and unknown fields', () => {
    expect(() =>
      QAgentConfigSchema.parse({
        version: 1,
        test: { commands: ['pnpm test'] },
        model: { provider: 'openai', model: 'model' },
      })
    ).toThrow();
    expect(() =>
      QAgentConfigSchema.parse({
        version: 1,
        target: { url: 'not a URL' },
        test: { commands: [{ executable: 'test' }] },
        model: { provider: 'openai', model: 'model', secret: 'nope' },
      })
    ).toThrow();
  });
});

describe('project detection and config writing', () => {
  it('loads the committed fixture configuration', async () => {
    const repository = await temporaryFixtureRepository();
    const detected = await detectProject(repository);

    expect(detected.stack).toBe('node');
    expect(detected.needsConfiguration).toBe(false);
    expect(detected.config?.target.healthPath).toBe('/health');
    expect(detected.suggestedTestCommands[0]?.executable).toBe('node');
  });

  it.each([
    ['python', 'pyproject.toml', '[project]\nname = "example"\n', 'python'],
    ['ruby', 'Gemfile', 'source "https://rubygems.org"\n', 'bundle'],
    ['go', 'go.mod', 'module example.test/app\n', 'go'],
    ['java', 'pom.xml', '<project/>\n', 'mvn'],
    ['dotnet', 'project.csproj', '<Project/>\n', 'dotnet'],
  ] as const)('detects %s repositories', async (stack, filename, content, executable) => {
    const root = await temporaryDirectory(`qagent-${stack}-`);
    await writeFile(join(root, filename), content);
    const detected = await detectProject(root);
    expect(detected.stack).toBe(stack);
    expect(detected.suggestedTestCommands[0]?.executable).toBe(executable);
  });

  it('detects Node scripts and writes a validated config once', async () => {
    const root = await temporaryDirectory('qagent-node-');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'example', scripts: { test: 'node --test', build: 'node build.js' } })
    );
    const detected = await detectProject(root);
    const config = buildInitialConfig(detected, {
      provider: 'openai-compatible',
      model: 'local-model',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
    config.publish.provider = 'local';
    const path = await writeProjectConfig(root, config);

    expect(path).toBe(join(root, '.qagent.yml'));
    expect((await detectProject(root)).config).toEqual(config);
    await expect(writeProjectConfig(root, config)).rejects.toThrow(/already exists/);
    await expect(writeProjectConfig(root, config, { force: true })).resolves.toBe(path);
  });

  it('requires an explicit test command for an unknown project', async () => {
    const root = await temporaryDirectory('qagent-unknown-');
    const detected = await detectProject(root);
    expect(detected.stack).toBe('unknown');
    expect(() => buildInitialConfig(detected, { provider: 'openai', model: 'gpt-5-mini' })).toThrow(
      /No test command/
    );
  });
});

describe('path boundaries', () => {
  it('contains paths and identifies secret-like files', async () => {
    const root = await temporaryDirectory('qagent-path-');
    await mkdir(join(root, 'src'));
    expect(assertPathContained(root, 'src/index.ts')).toBe(join(root, 'src/index.ts'));
    expect(() => assertPathContained(root, '../outside')).toThrow(/escapes/);
    expect(isSafeRelativePath('src/index.ts')).toBe(true);
    expect(isSafeRelativePath('../secret')).toBe(false);
    expect(isSafeRelativePath('..\\secret')).toBe(false);
    expect(isSensitivePath('config/.env.production')).toBe(true);
    expect(isSensitivePath('certs/release.p12')).toBe(true);
    expect(isSensitivePath('src/config.ts')).toBe(false);
    expect(projectDisplayName(root)).toBe(root.split('/').at(-1));
    expect(resolveQAgentHome({ QAGENT_HOME: join(root, 'home') })).toBe(join(root, 'home'));
  });
});
