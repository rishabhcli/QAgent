import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { detectProject, writeProjectConfig } from '@qagent/adapters';
import { QAgentEngine } from '@qagent/core';
import { ArtifactStore, QAgentStorage } from '@qagent/storage';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import {
  git,
  playwrightBrowserInstallation,
  temporaryDirectory,
  temporaryFixtureRepository,
} from '../helpers.js';

interface ModelRequestRecord {
  method: string;
  url: string;
  purpose: 'browser' | 'patch' | 'triage' | 'unknown';
  body: string;
}

interface ChatOnlyModelServer {
  baseUrl: string;
  requests: ModelRequestRecord[];
  server: Server;
  setBrowserFailure(failure: 'invalid_output' | 'provider' | undefined): void;
}

const engines = new Set<QAgentEngine>();
const storages = new Set<QAgentStorage>();
const servers = new Set<Server>();

afterEach(async () => {
  await Promise.all(
    [...engines].map((engine) =>
      engine.shutdown({ reason: 'OpenAI-compatible browser integration complete', graceMs: 5_000 })
    )
  );
  engines.clear();
  await Promise.all([...servers].map(closeServer));
  servers.clear();
  for (const storage of storages) storage.close();
  storages.clear();
});

describe('OpenAI-compatible Stagehand integration', () => {
  it('uses chat completions for real Chromium checks and persists final verification evidence', async () => {
    const provider = await startChatOnlyModelServer();
    const repository = await temporaryFixtureRepository();
    const targetUrl = await configureFixture(repository, provider.baseUrl);
    const { engine, storage, artifactStore } = await createEngine();
    const project = await engine.addProject(repository, true);

    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'cli' })
    ).result();

    expect(result.status, result.error ?? undefined).toBe('succeeded');
    expect(provider.requests.map((request) => request.purpose)).toEqual([
      'browser',
      'triage',
      'patch',
      'browser',
    ]);
    expect(provider.requests.every((request) => request.method === 'POST')).toBe(true);
    expect(provider.requests.map((request) => request.url)).toEqual([
      '/v1/chat/completions',
      '/v1/chat/completions',
      '/v1/chat/completions',
      '/v1/chat/completions',
    ]);
    expect(provider.requests.some((request) => request.url.endsWith('/responses'))).toBe(false);
    const structuredRequests = provider.requests.filter((request) =>
      ['triage', 'patch'].includes(request.purpose)
    );
    expect(structuredRequests).toHaveLength(2);
    expect(structuredRequests.every((request) => hasStrictJsonSchema(request.body))).toBe(true);
    expect(storage.listPatches(result.id)).toEqual([
      expect.objectContaining({ applied: true, files: ['src/counter.mjs'] }),
    ]);
    expect(storage.listProviderCalls(result.id).map((call) => call.purpose)).toEqual([
      'triage',
      'patch',
    ]);

    const checkpoints = engine
      .getRunEvents(result.id)
      .filter((event) => event.kind === 'browser.checkpoint');
    expect(checkpoints.map((event) => event.stage)).toEqual(['test', 'verify']);
    for (const checkpoint of checkpoints) {
      expect(
        checkpoint.artifactIds.map((artifactId) => storage.getArtifact(artifactId)?.kind).sort()
      ).toEqual(['dom', 'report', 'screenshot']);
    }

    const verification = storage.getVerification(result.id);
    const verifyCheckpoint = checkpoints.find((event) => event.stage === 'verify');
    expect(verification?.passed).toBe(true);
    expect(verifyCheckpoint).toBeDefined();
    for (const artifactId of verifyCheckpoint!.artifactIds) {
      expect(verification?.artifactIds).toContain(artifactId);
    }

    const verifyArtifacts = verifyCheckpoint!.artifactIds.map((artifactId) => {
      const artifact = storage.getArtifact(artifactId);
      if (!artifact) throw new Error(`Missing browser artifact ${artifactId}`);
      return artifact;
    });
    const domArtifact = verifyArtifacts.find((artifact) => artifact.kind === 'dom');
    const screenshotArtifact = verifyArtifacts.find((artifact) => artifact.kind === 'screenshot');
    const reportArtifact = verifyArtifacts.find((artifact) => artifact.kind === 'report');
    expect(domArtifact).toBeDefined();
    expect(screenshotArtifact).toBeDefined();
    expect(reportArtifact).toBeDefined();

    const dom = (await artifactStore.read(domArtifact!)).toString('utf8');
    expect(dom).toContain('id="count"');
    expect(dom).toMatch(/<output[^>]*>\s*1\s*<\/output>/);
    const screenshot = await artifactStore.read(screenshotArtifact!);
    expect([...screenshot.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const screenshotStats = await decodePngWithChromium(screenshot);
    expect(screenshotStats.width).toBeGreaterThan(100);
    expect(screenshotStats.height).toBeGreaterThan(100);
    expect(screenshotStats.opaquePixels).toBeGreaterThan(0);
    expect(screenshotStats.maximumLuminance - screenshotStats.minimumLuminance).toBeGreaterThan(20);
    const report = JSON.parse((await artifactStore.read(reportArtifact!)).toString('utf8')) as {
      flow: string;
      title: string;
      url: string;
      session: { provider: string; liveViewAvailable: boolean };
    };
    expect(report).toMatchObject({
      flow: 'Increment the counter once',
      title: 'Sample counter',
      session: { provider: 'local', liveViewAvailable: false },
    });
    expect(report.url).toBe(`${targetUrl.replace(new URL(targetUrl).port, '[REDACTED]')}/`);

    const verifiedIntegration = storage.getIntegration('browser');
    expect(verifiedIntegration).toMatchObject({
      status: 'end-to-end-verified',
      provenance: {
        source: 'local',
        provider: 'Playwright Chromium',
      },
    });

    provider.setBrowserFailure('provider');
    const laterFailure = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'desktop' })
    ).result();
    expect(laterFailure).toMatchObject({
      status: 'waiting_for_intervention',
      failureCode: 'provider_outage',
    });
    const downgradedIntegration = storage.getIntegration('browser');
    expect(downgradedIntegration).toMatchObject({
      id: verifiedIntegration?.id,
      status: 'error',
      provenance: {
        source: 'local',
        provider: 'Playwright Chromium',
      },
    });
    expect(downgradedIntegration?.detail).toContain(laterFailure.id);
    expect(downgradedIntegration?.detail).toContain('at test using local');
    expect(downgradedIntegration?.detail).toContain('Verify the configured model endpoint');
  }, 120_000);

  it('requires provider intervention before patching when browser chat capability fails', async () => {
    const provider = await startChatOnlyModelServer({ browserFailure: 'provider' });
    const repository = await temporaryFixtureRepository();
    await configureFixture(repository, provider.baseUrl);
    const { engine, storage } = await createEngine();
    const project = await engine.addProject(repository, true);

    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'desktop' })
    ).result();

    expect(result).toMatchObject({
      status: 'waiting_for_intervention',
      failureCode: 'provider_outage',
      availableActions: ['resolve_intervention', 'cancel'],
      intervention: {
        reason: 'provider_outage',
        resolutionOptions: ['provider_reconfigured'],
        requiredAction: {
          type: 'application',
          action: 'configure_provider',
          label: 'Repair browser model connection',
        },
      },
    });
    expect(result.error).toContain('Browser model provider is unavailable or incompatible');
    expect(result.intervention?.evidenceArtifactIds.length).toBeGreaterThan(0);
    expect(storage.getDiagnosis(result.id)).toBeNull();
    expect(storage.listPatches(result.id)).toHaveLength(0);
    expect(storage.listProviderCalls(result.id)).toHaveLength(0);
    expect(provider.requests.map((request) => request.purpose)).toEqual(['browser']);
    expect(provider.requests.map((request) => request.url)).toEqual(['/v1/chat/completions']);
    expect(
      engine
        .getRunEvents(result.id)
        .filter((event) => event.kind === 'diagnosis.created' || event.kind === 'patch.created')
    ).toHaveLength(0);
    expect(storage.getIntegration('browser')).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('Browser model provider failed'),
    });
  }, 60_000);

  it('distinguishes invalid browser model output from provider availability failures', async () => {
    const provider = await startChatOnlyModelServer({ browserFailure: 'invalid_output' });
    const repository = await temporaryFixtureRepository();
    await configureFixture(repository, provider.baseUrl);
    const { engine, storage } = await createEngine();
    const project = await engine.addProject(repository, true);

    const result = await (
      await engine.startRun({ projectId: project.id, requestedBy: 'mcp' })
    ).result();

    expect(result).toMatchObject({
      status: 'waiting_for_intervention',
      failureCode: 'invalid_model_output',
      availableActions: ['resolve_intervention', 'cancel'],
      intervention: {
        reason: 'invalid_model_output',
        resolutionOptions: ['provider_reconfigured'],
        requiredAction: {
          type: 'application',
          action: 'configure_provider',
          label: 'Repair browser model output',
        },
      },
    });
    expect(result.error).toContain('Browser model returned invalid structured output');
    expect(result.intervention?.evidenceArtifactIds.length).toBeGreaterThan(0);
    expect(storage.getDiagnosis(result.id)).toBeNull();
    expect(storage.listPatches(result.id)).toHaveLength(0);
    expect(storage.listProviderCalls(result.id)).toHaveLength(0);
    expect(provider.requests.length).toBeGreaterThan(0);
    expect(provider.requests.every((request) => request.purpose === 'browser')).toBe(true);
    expect(provider.requests.every((request) => request.url === '/v1/chat/completions')).toBe(true);
    expect(storage.getIntegration('browser')).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('Browser model output was invalid'),
    });
  }, 60_000);
});

async function createEngine(): Promise<{
  engine: QAgentEngine;
  storage: QAgentStorage;
  artifactStore: ArtifactStore;
}> {
  const home = await temporaryDirectory('qagent-compatible-browser-');
  const storage = new QAgentStorage(join(home, 'qagent.sqlite'));
  const artifactStore = new ArtifactStore(join(home, 'artifacts'), storage);
  const engine = new QAgentEngine({
    storage,
    artifactStore,
    qagentHome: home,
    modelCredentials: { openaiCompatible: 'integration-key' },
    browserDetector: async () => playwrightBrowserInstallation(),
  });
  storages.add(storage);
  engines.add(engine);
  return { engine, storage, artifactStore };
}

async function configureFixture(repository: string, modelBaseUrl: string): Promise<string> {
  const detected = await detectProject(repository);
  if (!detected.config?.target.start) {
    throw new Error('Fixture target configuration was not found');
  }
  const port = await availableLoopbackPort();
  detected.config.target.url = `http://127.0.0.1:${port}`;
  detected.config.target.start.env.PORT = String(port);
  detected.config.model = {
    provider: 'openai-compatible',
    model: 'qagent-chat-only',
    baseUrl: modelBaseUrl,
  };
  detected.config.publish.provider = 'local';
  await writeProjectConfig(repository, detected.config, { force: true });
  await git(repository, ['add', '.qagent.yml']);
  await git(repository, [
    '-c',
    'user.name=QAgent tests',
    '-c',
    'user.email=tests@qagent.local',
    'commit',
    '-m',
    'configure chat-only browser provider',
  ]);
  return detected.config.target.url;
}

async function startChatOnlyModelServer(
  options: { browserFailure?: 'invalid_output' | 'provider' } = {}
): Promise<ChatOnlyModelServer> {
  const requests: ModelRequestRecord[] = [];
  const state = { browserFailure: options.browserFailure };
  const server = createServer((request, response) => {
    void handleModelRequest(request, response, requests, state).catch((error: unknown) => {
      respondJson(response, 500, {
        error: error instanceof Error ? error.message : 'Unknown model fixture error',
      });
    });
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    server,
    setBrowserFailure: (failure) => {
      state.browserFailure = failure;
    },
  };
}

async function handleModelRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: ModelRequestRecord[],
  options: { browserFailure?: 'invalid_output' | 'provider' }
): Promise<void> {
  const body = await requestBody(request);
  const prompt = completionPrompt(body);
  const purpose = modelPurpose(body, prompt);
  requests.push({
    method: request.method ?? 'UNKNOWN',
    url: request.url ?? '/',
    purpose,
    body,
  });
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    respondJson(response, 404, { error: { message: 'Only chat completions are supported' } });
    return;
  }
  if (options.browserFailure === 'provider' && purpose === 'browser') {
    respondJson(response, 400, {
      error: {
        type: 'unsupported_capability',
        message: 'This model cannot produce Stagehand browser actions',
      },
    });
    return;
  }
  if (options.browserFailure === 'invalid_output' && purpose === 'browser') {
    respondWithCompletion(response, 'not structured JSON');
    return;
  }
  respondWithCompletion(response, modelCompletion(prompt, purpose));
}

function modelPurpose(body: string, prompt: string): ModelRequestRecord['purpose'] {
  const schemaProperties = responseSchemaProperties(body);
  if (schemaProperties.has('rootCause')) return 'triage';
  if (schemaProperties.has('unifiedDiff')) return 'patch';
  if (schemaProperties.has('twoStep') && schemaProperties.has('elementId')) return 'browser';
  if (prompt.includes('"rootCause"')) return 'triage';
  if (prompt.includes('"unifiedDiff"')) return 'patch';
  if (prompt.includes('"twoStep"') && prompt.includes('"elementId"')) return 'browser';
  return 'unknown';
}

function responseSchemaProperties(body: string): Set<string> {
  try {
    const value = JSON.parse(body) as {
      response_format?: {
        json_schema?: {
          schema?: { properties?: Record<string, unknown> };
        };
      };
    };
    return new Set(Object.keys(value.response_format?.json_schema?.schema?.properties ?? {}));
  } catch {
    return new Set();
  }
}

function hasStrictJsonSchema(body: string): boolean {
  try {
    const value = JSON.parse(body) as {
      response_format?: {
        type?: string;
        json_schema?: { strict?: boolean; schema?: unknown };
      };
    };
    return (
      value.response_format?.type === 'json_schema' &&
      value.response_format.json_schema?.strict === true &&
      Boolean(value.response_format.json_schema.schema)
    );
  } catch {
    return false;
  }
}

function modelCompletion(prompt: string, purpose: ModelRequestRecord['purpose']): string {
  if (purpose === 'triage') {
    return JSON.stringify({
      summary: 'Counter increments by two',
      rootCause: 'src/counter.mjs adds 2 although the grounded check requires 1.',
      confidence: 1,
    });
  }
  if (purpose === 'patch') {
    return JSON.stringify({
      summary: 'Increment the counter by one',
      unifiedDiff: [
        'diff --git a/src/counter.mjs b/src/counter.mjs',
        '--- a/src/counter.mjs',
        '+++ b/src/counter.mjs',
        '@@ -3,1 +3,1 @@',
        '-  return value + 2;',
        '+  return value + 1;',
      ].join('\n'),
    });
  }
  if (purpose === 'browser') {
    const incrementLine = prompt
      .split('\n')
      .find((line) => /increment/i.test(line) && /\d+-\d+/.test(line));
    const elementId = incrementLine?.match(/(?:^|[\s[])(\d+-\d+)(?:[\]\s]|$)/)?.[1] ?? null;
    return JSON.stringify({
      action: elementId
        ? {
            elementId,
            description: 'Increment button',
            method: 'click',
            arguments: [],
          }
        : null,
      twoStep: false,
    });
  }
  return '{"ready":true}';
}

function respondWithCompletion(response: ServerResponse, content: string): void {
  respondJson(response, 200, {
    id: 'chatcmpl_qagent_integration',
    object: 'chat.completion',
    created: 1,
    model: 'qagent-chat-only',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
}

function completionPrompt(body: string): string {
  try {
    const value = JSON.parse(body) as {
      messages?: Array<{ content?: unknown }>;
      input?: unknown;
    };
    const messages = value.messages?.map((message) => textContent(message.content)).join('\n');
    return messages || textContent(value.input) || body;
  } catch {
    return body;
  }
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textContent).join('\n');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  return [record.text, record.content, record.input_text].map(textContent).join('\n');
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    'content-type': 'application/json',
    connection: 'close',
  });
  response.end(JSON.stringify(body));
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await closeServer(server);
  return port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function decodePngWithChromium(image: Buffer): Promise<{
  width: number;
  height: number;
  opaquePixels: number;
  minimumLuminance: number;
  maximumLuminance: number;
}> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await page.evaluate(
      async (source) => {
        const image = document.createElement('img');
        image.src = source;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 18;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Chromium did not provide a 2D canvas context');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let opaquePixels = 0;
        let minimumLuminance = 255;
        let maximumLuminance = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if ((pixels[index + 3] ?? 0) === 0) continue;
          opaquePixels += 1;
          const luminance =
            0.2126 * (pixels[index] ?? 0) +
            0.7152 * (pixels[index + 1] ?? 0) +
            0.0722 * (pixels[index + 2] ?? 0);
          minimumLuminance = Math.min(minimumLuminance, luminance);
          maximumLuminance = Math.max(maximumLuminance, luminance);
        }
        return {
          width: image.naturalWidth,
          height: image.naturalHeight,
          opaquePixels,
          minimumLuminance,
          maximumLuminance,
        };
      },
      `data:image/png;base64,${image.toString('base64')}`
    );
  } finally {
    await browser.close();
  }
}
