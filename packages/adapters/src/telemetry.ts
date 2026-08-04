import type { RunEvent } from '@qagent/contracts';
import { z } from 'zod';

export type TraceState = 'local' | 'queued' | 'synced' | 'failed' | 'disabled';

export interface TraceSink {
  readonly state: TraceState;
  readonly evidenceSourceUrl?: string;
  send(event: RunEvent, signal?: AbortSignal): Promise<TraceState>;
  flush(signal?: AbortSignal): Promise<TraceState>;
}

const SECRET_KEY =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|tokens?|secrets?|passwords?|authorization|cookies?|credentials?)(?:$|[_-])|^(?:apiKey|accessToken|refreshToken|clientSecret)$/i;
const SECRET_VALUE =
  /(?:bearer|basic)\s+[a-z0-9+/=._-]+|sk-(?:ant-)?[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]+/gi;
const SECRET_ASSIGNMENT =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie|credential)=)[^&\s]+/gi;

export function redactForTelemetry(value: unknown, key = ''): unknown {
  return redactTelemetryValue(value, key, false);
}

function redactTelemetryValue(value: unknown, key: string, inheritedSecret: boolean): unknown {
  const secretContext = inheritedSecret || SECRET_KEY.test(key);
  if (typeof value === 'string') {
    if (secretContext) return '[REDACTED]';
    return value.replace(SECRET_VALUE, '[REDACTED]').replace(SECRET_ASSIGNMENT, '$1[REDACTED]');
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactTelemetryValue(item, '', secretContext));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactTelemetryValue(child, childKey, secretContext),
      ])
    );
  }
  return value;
}

export class LocalTraceSink implements TraceSink {
  readonly state: TraceState = 'local';

  async send(_event: RunEvent, _signal?: AbortSignal): Promise<TraceState> {
    return this.state;
  }

  async flush(_signal?: AbortSignal): Promise<TraceState> {
    return this.state;
  }
}

export class DisabledTraceSink implements TraceSink {
  readonly state: TraceState = 'disabled';

  async send(_event: RunEvent, _signal?: AbortSignal): Promise<TraceState> {
    return this.state;
  }

  async flush(_signal?: AbortSignal): Promise<TraceState> {
    return this.state;
  }
}

interface QueuedTrace {
  id: string;
  runId: string;
  kind: string;
  stage: string;
  occurredAt: string;
  event: unknown;
}

export interface WeaveTraceSinkOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  maxQueueSize?: number;
  timeoutMs?: number;
  traceBaseUrl?: string;
  wandbBaseUrl?: string;
}

const DefaultEntityResponseSchema = z.object({
  data: z.object({
    viewer: z.object({
      defaultEntity: z.object({ name: z.string().min(1) }),
    }),
  }),
});

const ProjectInfoResponseSchema = z
  .array(
    z.object({
      external_project_id: z.string().min(1),
      internal_project_id: z.string().min(1),
    })
  )
  .min(1);

const BatchResponseSchema = z.object({
  res: z.array(z.record(z.string(), z.unknown())),
});

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_QUEUE_SIZE = 500;
const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_WANDB_BASE_URL = 'https://api.wandb.ai';
const DEFAULT_TRACE_BASE_URL = 'https://trace.wandb.ai';
const DEFAULT_ENTITY_QUERY = `
  query DefaultEntity {
    viewer {
      defaultEntity {
        name
      }
    }
  }
`;

export class WeaveTraceSink implements TraceSink {
  state: TraceState;
  lastError: string | null = null;
  resolvedProject: string | null = null;

  private readonly apiKey: string | undefined;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly maxQueueSize: number;
  private readonly timeoutMs: number;
  private readonly traceBaseUrl: string;
  private readonly wandbBaseUrl: string;
  private readonly queue: QueuedTrace[] = [];
  private flushPromise: Promise<TraceState> | null = null;

  constructor(
    private readonly project: string,
    private readonly acceptedDisclosure: boolean,
    options: WeaveTraceSinkOptions = {}
  ) {
    this.apiKey = options.apiKey ?? process.env.WANDB_API_KEY;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.maxQueueSize = positiveInteger(
      options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      'maxQueueSize'
    );
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.wandbBaseUrl = normalizeBaseUrl(
      options.wandbBaseUrl ?? process.env.WANDB_BASE_URL ?? DEFAULT_WANDB_BASE_URL,
      'W&B base URL'
    );
    const defaultTraceUrl =
      this.wandbBaseUrl === DEFAULT_WANDB_BASE_URL
        ? DEFAULT_TRACE_BASE_URL
        : `${this.wandbBaseUrl}/traces`;
    this.traceBaseUrl = normalizeBaseUrl(
      options.traceBaseUrl ?? process.env.WF_TRACE_SERVER_URL ?? defaultTraceUrl,
      'Weave trace base URL'
    );
    validateProjectInput(project);
    this.state = this.acceptedDisclosure && this.apiKey ? 'queued' : 'disabled';
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get evidenceSourceUrl(): string | undefined {
    if (!this.resolvedProject) return undefined;
    return `https://wandb.ai/${this.resolvedProject
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')}/weave`;
  }

  async probeProject(signal?: AbortSignal): Promise<string> {
    if (!this.apiKey) throw new Error('WANDB_API_KEY is not configured');
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    return this.resolveAndProbeProject(requestSignal);
  }

  async send(event: RunEvent, signal?: AbortSignal): Promise<TraceState> {
    if (!this.acceptedDisclosure || !this.apiKey) {
      this.state = 'disabled';
      return this.state;
    }
    if (this.queue.length >= this.maxQueueSize) {
      this.state = 'failed';
      this.lastError = `Weave trace queue reached its ${this.maxQueueSize}-event limit`;
      return this.state;
    }

    this.queue.push({
      id: event.id,
      runId: event.runId,
      kind: event.kind,
      stage: event.stage,
      occurredAt: event.occurredAt,
      event: redactExactSecret(redactForTelemetry(event), this.apiKey),
    });
    this.state = 'queued';
    return this.flush(signal);
  }

  async flush(signal?: AbortSignal): Promise<TraceState> {
    if (!this.acceptedDisclosure || !this.apiKey) {
      this.state = 'disabled';
      return this.state;
    }
    if (this.queue.length === 0 && !this.flushPromise) {
      return this.state;
    }
    if (!this.flushPromise) {
      this.flushPromise = this.drain(signal).finally(() => {
        this.flushPromise = null;
      });
    }
    return this.flushPromise;
  }

  private async drain(externalSignal?: AbortSignal): Promise<TraceState> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      this.state = 'disabled';
      return this.state;
    }
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, timeoutSignal])
      : timeoutSignal;
    let pendingBatch: QueuedTrace[] = [];

    try {
      signal.throwIfAborted();
      const projectId = await this.resolveAndProbeProject(signal);

      while (this.queue.length > 0) {
        pendingBatch = this.queue.splice(0, this.queue.length);
        await this.deliverBatch(projectId, pendingBatch, signal);
        pendingBatch = [];
      }

      this.lastError = null;
      this.state = 'synced';
    } catch (error) {
      if (pendingBatch.length > 0) this.queue.unshift(...pendingBatch);
      this.lastError = telemetryFailureMessage(error, externalSignal, timeoutSignal, apiKey);
      this.state = 'failed';
    }
    return this.state;
  }

  private async resolveAndProbeProject(signal: AbortSignal): Promise<string> {
    if (this.resolvedProject) return this.resolvedProject;

    const parts = this.project.trim().split('/');
    const projectId =
      parts.length === 2
        ? parts.join('/')
        : `${await this.resolveDefaultEntity(signal)}/${parts[0]}`;
    const response = await this.request(
      this.traceBaseUrl,
      '/service/projects_info',
      { project_ids: [projectId] },
      signal
    );
    const projects = ProjectInfoResponseSchema.parse(await readJson(response));
    if (!projects.some((item) => item.external_project_id === projectId)) {
      throw new Error('Weave did not confirm access to the configured entity/project');
    }
    this.resolvedProject = projectId;
    return projectId;
  }

  private async resolveDefaultEntity(signal: AbortSignal): Promise<string> {
    const response = await this.request(
      this.wandbBaseUrl,
      '/graphql',
      { query: DEFAULT_ENTITY_QUERY, variables: {} },
      signal
    );
    return DefaultEntityResponseSchema.parse(await readJson(response)).data.viewer.defaultEntity
      .name;
  }

  private async deliverBatch(
    projectId: string,
    batch: QueuedTrace[],
    signal: AbortSignal
  ): Promise<void> {
    const operations = batch.flatMap((trace) => [
      {
        mode: 'start',
        req: {
          start: {
            project_id: projectId,
            id: trace.id,
            op_name: 'qagent.run.event',
            display_name: trace.kind,
            trace_id: trace.runId,
            started_at: trace.occurredAt,
            attributes: {
              source: 'qagent',
              schema_version: 1,
              stage: trace.stage,
              kind: trace.kind,
            },
            inputs: { event: trace.event },
          },
        },
      },
      {
        mode: 'end',
        req: {
          end: {
            project_id: projectId,
            id: trace.id,
            trace_id: trace.runId,
            started_at: trace.occurredAt,
            ended_at: new Date().toISOString(),
            output: { accepted: true },
            summary: {},
          },
        },
      },
    ]);
    const response = await this.request(
      this.traceBaseUrl,
      '/call/upsert_batch',
      { batch: operations },
      signal
    );
    const parsed = BatchResponseSchema.parse(await readJson(response));
    if (parsed.res.length !== operations.length) {
      throw new Error('Weave returned an incomplete batch acknowledgement');
    }
    for (let index = 0; index < batch.length; index += 1) {
      const acknowledgement = parsed.res[index * 2];
      const trace = batch[index];
      if (
        !acknowledgement ||
        !trace ||
        acknowledgement.id !== trace.id ||
        acknowledgement.trace_id !== trace.runId
      ) {
        throw new Error('Weave returned an invalid trace acknowledgement');
      }
    }
  }

  private async request(
    baseUrl: string,
    path: string,
    body: unknown,
    signal: AbortSignal
  ): Promise<Response> {
    signal.throwIfAborted();
    const response = await this.fetchImplementation(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`api:${this.apiKey}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      throw new Error(`Weave ${path} request failed with HTTP ${response.status}`);
    }
    return response;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error('Weave response exceeded the size limit');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Weave returned an invalid JSON response');
  }
}

function validateProjectInput(project: string): void {
  const trimmed = project.trim();
  const parts = trimmed.split('/');
  if (
    !trimmed ||
    trimmed !== project ||
    parts.length > 2 ||
    parts.some(
      (part) =>
        !part ||
        [...part].some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        })
    )
  ) {
    throw new Error('Weave project must be "project" or "entity/project"');
  }
}

function normalizeBaseUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} must be a credential-free HTTP(S) URL`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function telemetryFailureMessage(
  error: unknown,
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  apiKey: string
): string {
  if (externalSignal?.aborted) return 'Weave delivery was cancelled';
  if (timeoutSignal.aborted) return 'Weave delivery timed out';
  const message = error instanceof Error ? error.message : String(error);
  return String(redactExactSecret(redactForTelemetry(message), apiKey)).slice(0, 500);
}

function redactExactSecret(value: unknown, secret: string): unknown {
  if (typeof value === 'string') return value.replaceAll(secret, '[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => redactExactSecret(item, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key.replaceAll(secret, '[REDACTED]'),
        redactExactSecret(child, secret),
      ])
    );
  }
  return value;
}
