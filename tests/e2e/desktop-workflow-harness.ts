import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { BootstrapSnapshot, RunDetail } from '../../packages/contracts/dist/index.js';
import {
  _electron as electron,
  chromium,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const execFileAsync = promisify(execFile);
const temporaryPaths = new Set<string>();

export interface ScriptedModelServer {
  baseUrl: string;
  requests: Array<{ method: string; url: string; body: string }>;
  invalidateNextTriage(): void;
  close(): Promise<void>;
}

export interface LocalGitHubServer {
  baseUrl: string;
  readonly createCount: number;
  readonly snapshotCount: number;
  requests: Array<{ method: string; url: string }>;
  close(): Promise<void>;
}

export async function cleanupWorkflowFixtures(): Promise<void> {
  await Promise.all([...temporaryPaths].map((path) => rm(path, { recursive: true, force: true })));
  temporaryPaths.clear();
}

export async function fixtureRepository(): Promise<string> {
  const root = await temporaryDirectory('qagent-desktop-workflow-fixture-');
  await cp(resolve('fixtures/sample-web-app'), root, { recursive: true });
  const configPath = join(root, '.qagent.yml');
  const config = await readFile(configPath, 'utf8');
  await writeFile(
    configPath,
    config.replaceAll('41773', String(await availableLoopbackPort())),
    'utf8'
  );
  await git(root, ['init', '-b', 'main']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'fixture baseline']);
  return realpath(root);
}

export async function canonicalSelection(repository: string): Promise<{
  canonicalPath: string;
  selectedPath: string;
}> {
  const parent = await temporaryDirectory('qagent-desktop-workflow-selection-');
  const selectedPath = join(parent, 'selected-repository');
  await symlink(repository, selectedPath, 'dir');
  return { canonicalPath: await realpath(repository), selectedPath };
}

export async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.add(path);
  return path;
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync(
    'git',
    ['-c', 'user.name=QAgent tests', '-c', 'user.email=tests@qagent.local', ...args],
    { cwd }
  );
  return result.stdout.trim();
}

export async function launchDesktop(
  userData: string,
  environment: Record<string, string> = {}
): Promise<ElectronApplication> {
  const application = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      QAGENT_BROWSER_PATH: chromium.executablePath(),
      QAGENT_WEAVE_ENABLED: 'false',
      ...environment,
    },
  });
  return application;
}

export async function bootstrap(page: Page): Promise<BootstrapSnapshot> {
  return desktopRequest<BootstrapSnapshot>(page, { method: 'bootstrap', params: {} });
}

export async function runDetail(page: Page, runId: string): Promise<RunDetail> {
  return desktopRequest<RunDetail>(page, {
    method: 'run.detail',
    params: { runId },
  });
}

export async function desktopRequest<T>(page: Page, request: unknown): Promise<T> {
  return page.evaluate(async (value) => {
    const bridge = (
      window as unknown as {
        qagent: { request(input: unknown): Promise<unknown> };
      }
    ).qagent;
    return bridge.request(value);
  }, request) as Promise<T>;
}

export async function engineUtilityPid(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ app: electronApp }) => {
    const metric = electronApp
      .getAppMetrics()
      .find(
        (candidate) =>
          candidate.type === 'Utility' &&
          (candidate.serviceName === 'QAgent Engine' || candidate.name === 'QAgent Engine')
      );
    if (!metric) {
      throw new Error(
        `QAgent Engine utility process was not found: ${JSON.stringify(
          electronApp
            .getAppMetrics()
            .map(({ pid, type, name, serviceName }) => ({ pid, type, name, serviceName }))
        )}`
      );
    }
    return metric.pid;
  });
}

export async function killEngineUtility(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ app: electronApp }) => {
    const metric = electronApp
      .getAppMetrics()
      .find(
        (candidate) =>
          candidate.type === 'Utility' &&
          (candidate.serviceName === 'QAgent Engine' || candidate.name === 'QAgent Engine')
      );
    if (!metric) {
      throw new Error(
        `QAgent Engine utility process was not found: ${JSON.stringify(
          electronApp
            .getAppMetrics()
            .map(({ pid, type, name, serviceName }) => ({ pid, type, name, serviceName }))
        )}`
      );
    }
    process.kill(metric.pid, 'SIGKILL');
    return metric.pid;
  });
}

export async function startScriptedModelServer(): Promise<ScriptedModelServer> {
  const requests: ScriptedModelServer['requests'] = [];
  let invalidTriageRemaining = 0;
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    requests.push({
      method: request.method ?? 'UNKNOWN',
      url: request.url ?? '/',
      body,
    });

    const prompt = completionPrompt(body);
    const schemaProperties = responseSchemaProperties(body);
    const usesResponsesApi = request.url?.endsWith('/responses') ?? false;
    let content: string;
    if (usesResponsesApi || schemaProperties.has('twoStep')) {
      const incrementLine = prompt
        .split('\n')
        .find((line) => /increment/i.test(line) && /\d+-\d+/.test(line));
      const elementId = incrementLine?.match(/(?:^|[\s[])(\d+-\d+)(?:[\]\s]|$)/)?.[1] ?? null;
      content = JSON.stringify({
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
    } else if (schemaProperties.has('rootCause') || prompt.includes('"rootCause"')) {
      if (invalidTriageRemaining > 0) {
        invalidTriageRemaining -= 1;
        content = 'not structured json';
      } else {
        content = JSON.stringify({
          summary: 'Counter increments by two',
          rootCause: 'src/counter.mjs adds 2 while the committed test requires 1.',
          confidence: 1,
        });
      }
    } else if (schemaProperties.has('unifiedDiff') || prompt.includes('"unifiedDiff"')) {
      content = JSON.stringify({
        summary: 'Increment the counter by one',
        unifiedDiff: [
          'diff --git a/src/counter.mjs b/src/counter.mjs',
          '--- a/src/counter.mjs',
          '+++ b/src/counter.mjs',
          '@@ -1,4 +1,4 @@',
          ' export function increment(value) {',
          '   // Intentional fixture defect: QAgent should repair this to `value + 1`.',
          '-  return value + 2;',
          '+  return value + 1;',
          ' }',
          '',
        ].join('\n'),
      });
    } else if (
      (schemaProperties.has('twoStep') && schemaProperties.has('elementId')) ||
      (prompt.includes('"twoStep"') && prompt.includes('"elementId"'))
    ) {
      const incrementLine = prompt
        .split('\n')
        .find((line) => /increment/i.test(line) && /\d+-\d+/.test(line));
      const elementId = incrementLine?.match(/(?:^|[\s[])(\d+-\d+)(?:[\]\s]|$)/)?.[1] ?? null;
      content = JSON.stringify({
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
    } else if (schemaProperties.has('ok') || prompt.includes('"ok"')) {
      content = '{"ok":true}';
    } else {
      content = '{"ready":true}';
    }
    if (usesResponsesApi) {
      respondWithResponse(response, content);
    } else {
      respondWithCompletion(response, content);
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    invalidateNextTriage() {
      invalidTriageRemaining += 1;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}

export async function startLocalGitHubServer(bareRepository: string): Promise<LocalGitHubServer> {
  const requests: LocalGitHubServer['requests'] = [];
  let createCount = 0;
  let snapshotCount = 0;
  let headBranch: string | null = null;
  let mergeCommitSha: string | null = null;
  const pullUrl = 'https://github.com/qagent-tests/workflow-fixture/pull/1';

  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? 'UNKNOWN';
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      requests.push({ method, url: `${url.pathname}${url.search}` });

      if (method === 'GET' && url.pathname === '/user') {
        return respondJson(response, 200, { login: 'qagent-fixture' });
      }
      if (method === 'GET' && url.pathname === '/repos/qagent-tests/workflow-fixture') {
        return respondJson(
          response,
          200,
          {
            full_name: 'qagent-tests/workflow-fixture',
            default_branch: 'main',
            archived: false,
            disabled: false,
            allow_auto_merge: false,
            allow_merge_commit: true,
            allow_squash_merge: true,
            allow_rebase_merge: true,
            permissions: { pull: true, push: true, admin: true },
          },
          { 'x-oauth-scopes': 'repo' }
        );
      }
      if (
        method === 'GET' &&
        url.pathname ===
          '/repos/qagent-tests/workflow-fixture/collaborators/qagent-fixture/permission'
      ) {
        return respondJson(response, 200, { permission: 'admin', role_name: 'admin' });
      }
      if (
        method === 'GET' &&
        url.pathname === '/repos/qagent-tests/workflow-fixture/rules/branches/main'
      ) {
        return respondJson(response, 200, []);
      }
      if (
        method === 'GET' &&
        url.pathname === '/repos/qagent-tests/workflow-fixture/commits/main/check-runs'
      ) {
        return respondJson(response, 200, { total_count: 1, check_runs: [] });
      }
      if (
        method === 'GET' &&
        url.pathname === '/repos/qagent-tests/workflow-fixture/commits/main/status'
      ) {
        return respondJson(response, 200, { state: 'success', total_count: 1, statuses: [] });
      }
      if (
        method === 'GET' &&
        url.pathname === '/repos/qagent-tests/workflow-fixture/branches/main/protection'
      ) {
        return respondJson(response, 404, { message: 'Branch not protected' });
      }
      if (method === 'GET' && url.pathname === '/repos/qagent-tests/workflow-fixture/pulls') {
        return respondJson(
          response,
          200,
          headBranch
            ? [
                {
                  html_url: pullUrl,
                  number: 1,
                  state: 'open',
                  head: {
                    ref: headBranch,
                    repo: { full_name: 'qagent-tests/workflow-fixture' },
                  },
                  base: { ref: 'main' },
                },
              ]
            : []
        );
      }
      if (method === 'POST' && url.pathname === '/repos/qagent-tests/workflow-fixture/pulls') {
        const body = JSON.parse(await requestBody(request)) as { head?: unknown };
        if (typeof body.head !== 'string' || !body.head.startsWith('qagent/')) {
          return respondJson(response, 422, { message: 'Invalid head branch' });
        }
        createCount += 1;
        headBranch = body.head;
        return respondJson(response, 201, { html_url: pullUrl, number: 1 });
      }
      if (method === 'POST' && url.pathname === '/graphql') {
        const body = JSON.parse(await requestBody(request)) as { query?: unknown };
        if (typeof body.query !== 'string' || !body.query.includes('QAgentPullRequestState')) {
          return respondJson(response, 400, { message: 'Unexpected GraphQL operation' });
        }
        snapshotCount += 1;
        const merged = snapshotCount > 1;
        if (merged && headBranch && !mergeCommitSha) {
          mergeCommitSha = await git(bareRepository, ['rev-parse', `refs/heads/${headBranch}`]);
          await git(bareRepository, ['update-ref', 'refs/heads/main', mergeCommitSha]);
        }
        return respondJson(response, 200, {
          data: {
            repository: {
              pullRequest: {
                id: 'PR_qagent_fixture_1',
                number: 1,
                url: pullUrl,
                state: merged ? 'MERGED' : 'OPEN',
                merged,
                mergeable: 'MERGEABLE',
                mergeStateStatus: 'CLEAN',
                reviewDecision: null,
                mergeCommit: mergeCommitSha ? { oid: mergeCommitSha } : null,
                autoMergeRequest: null,
                mergeQueueEntry: null,
                statusCheckRollup: { state: 'SUCCESS' },
              },
            },
          },
        });
      }
      return respondJson(response, 404, {
        message: `Unhandled fixture route: ${method} ${url.pathname}`,
      });
    })().catch((error) => {
      if (!response.headersSent) {
        respondJson(response, 500, {
          message: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get createCount() {
      return createCount;
    },
    get snapshotCount() {
      return snapshotCount;
    },
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}

function respondWithCompletion(response: ServerResponse, content: string): void {
  response.writeHead(200, {
    'content-type': 'application/json',
    connection: 'close',
  });
  response.end(
    JSON.stringify({
      id: 'chatcmpl_qagent_e2e',
      object: 'chat.completion',
      created: 1,
      model: 'qagent-e2e-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    })
  );
}

function respondWithResponse(response: ServerResponse, content: string): void {
  response.writeHead(200, {
    'content-type': 'application/json',
    connection: 'close',
  });
  response.end(
    JSON.stringify({
      id: 'resp_qagent_e2e',
      object: 'response',
      created_at: 1,
      status: 'completed',
      model: 'qagent-e2e-model',
      output: [
        {
          id: 'msg_qagent_e2e',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              annotations: [],
              text: content,
            },
          ],
        },
      ],
      usage: {
        input_tokens: 11,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 18,
      },
    })
  );
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

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return port;
}

function respondJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    connection: 'close',
    ...headers,
  });
  response.end(JSON.stringify(value));
}
