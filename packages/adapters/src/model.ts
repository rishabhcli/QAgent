import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import type { QAgentConfig } from '@qagent/contracts';
import OpenAI from 'openai';
import { z } from 'zod';

export interface ModelCredentials {
  openai?: string;
  anthropic?: string;
  google?: string;
  openaiCompatible?: string;
}

export interface ModelRequest<T> {
  purpose: 'triage' | 'patch' | 'browser' | 'other';
  system: string;
  prompt: string;
  schemaName: string;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ModelCompletion<T> {
  value: T;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ModelProvider {
  readonly provider: string;
  readonly model: string;
  complete<T>(request: ModelRequest<T>): Promise<ModelCompletion<T>>;
}

interface OpenAIClient {
  responses: {
    create(
      input: Record<string, unknown>,
      options: { signal?: AbortSignal }
    ): Promise<{
      output_text: string;
      usage?: { input_tokens?: number; output_tokens?: number } | null;
    }>;
  };
  chat: {
    completions: {
      create(
        input: Record<string, unknown>,
        options: { signal?: AbortSignal }
      ): Promise<{
        choices: Array<{ message: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      }>;
    };
  };
}

interface AnthropicClient {
  messages: {
    create(
      input: Record<string, unknown>,
      options: { signal?: AbortSignal }
    ): Promise<{
      content: Array<{ type: string; text?: string }>;
      stop_reason?: string | null;
      usage: { input_tokens: number; output_tokens: number };
    }>;
  };
}

interface GoogleClient {
  models: {
    generateContent(input: Record<string, unknown>): Promise<{
      text?: string;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }>;
  };
}

export interface ModelClientFactories {
  openai(options: { apiKey: string; baseURL?: string }): OpenAIClient;
  anthropic(options: { apiKey: string }): AnthropicClient;
  google(options: { apiKey: string }): GoogleClient;
}

const defaultFactories: ModelClientFactories = {
  openai: (options) => new OpenAI(options) as unknown as OpenAIClient,
  anthropic: (options) => new Anthropic(options) as unknown as AnthropicClient,
  google: (options) => new GoogleGenAI(options) as unknown as GoogleClient,
};

const DEFAULT_MODEL_TIMEOUT_MS = 60_000;
const OPENAI_COMPATIBLE_TEMPERATURE = 0;
const PROVIDER_SECRET =
  /(?:bearer|basic)\s+[a-z0-9+/=._-]+|sk-(?:ant-)?[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]+/gi;
const PROVIDER_SECRET_ASSIGNMENT =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie|credential)[=:]\s*)[^&\s,;]+/gi;

export function createModelProvider(
  config: QAgentConfig['model'],
  credentials: ModelCredentials = {},
  factories: ModelClientFactories = defaultFactories
): ModelProvider {
  switch (config.provider) {
    case 'openai': {
      const apiKey = requireCredential(
        credentials.openai ?? process.env.OPENAI_API_KEY,
        'OPENAI_API_KEY'
      );
      return new OpenAIResponsesProvider(config.model, factories.openai({ apiKey }));
    }
    case 'anthropic': {
      const apiKey = requireCredential(
        credentials.anthropic ?? process.env.ANTHROPIC_API_KEY,
        'ANTHROPIC_API_KEY'
      );
      return new AnthropicProvider(config.model, factories.anthropic({ apiKey }));
    }
    case 'google': {
      const apiKey = requireCredential(
        credentials.google ?? process.env.GOOGLE_API_KEY,
        'GOOGLE_API_KEY'
      );
      return new GoogleProvider(config.model, factories.google({ apiKey }));
    }
    case 'openai-compatible': {
      const apiKey = credentials.openaiCompatible ?? process.env.OPENAI_API_KEY ?? 'local';
      const baseURL = validateOpenAICompatibleBaseUrl(
        config.baseUrl ?? process.env.QAGENT_OPENAI_BASE_URL ?? 'http://127.0.0.1:11434/v1'
      );
      return new OpenAICompatibleProvider(config.model, factories.openai({ apiKey, baseURL }));
    }
  }
}

class OpenAIResponsesProvider implements ModelProvider {
  readonly provider = 'openai';

  constructor(
    readonly model: string,
    private readonly client: OpenAIClient
  ) {}

  async complete<T>(request: ModelRequest<T>): Promise<ModelCompletion<T>> {
    return runBoundedModelRequest(this.provider, this.model, request, async (signal) => {
      const response = await this.client.responses.create(
        {
          model: this.model,
          instructions: request.system,
          input: request.prompt,
          store: false,
          text: {
            format: {
              type: 'json_schema',
              name: request.schemaName,
              schema: providerJsonSchema(request.schema),
              strict: true,
            },
          },
        },
        { signal }
      );
      return {
        value: parseStructuredResponse(request.schema, response.output_text),
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
      };
    });
  }
}

class AnthropicProvider implements ModelProvider {
  readonly provider = 'anthropic';

  constructor(
    readonly model: string,
    private readonly client: AnthropicClient
  ) {}

  async complete<T>(request: ModelRequest<T>): Promise<ModelCompletion<T>> {
    return runBoundedModelRequest(this.provider, this.model, request, async (signal) => {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 16_000,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
          output_config: {
            format: {
              type: 'json_schema',
              schema: providerJsonSchema(request.schema),
            },
          },
        },
        { signal }
      );
      if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
        throw new InvalidStructuredOutputError(
          `Model response stopped with ${response.stop_reason}`
        );
      }
      const text = response.content
        .filter((block): block is { type: string; text: string } =>
          Boolean(block.type === 'text' && block.text)
        )
        .map((block) => block.text)
        .join('\n');
      return {
        value: parseStructuredResponse(request.schema, text),
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    });
  }
}

class GoogleProvider implements ModelProvider {
  readonly provider = 'google';

  constructor(
    readonly model: string,
    private readonly client: GoogleClient
  ) {}

  async complete<T>(request: ModelRequest<T>): Promise<ModelCompletion<T>> {
    return runBoundedModelRequest(this.provider, this.model, request, async (signal) => {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: request.prompt,
        config: {
          systemInstruction: request.system,
          responseMimeType: 'application/json',
          responseJsonSchema: providerJsonSchema(request.schema),
          abortSignal: signal,
        },
      });
      return {
        value: parseStructuredResponse(request.schema, response.text ?? ''),
        inputTokens: response.usageMetadata?.promptTokenCount ?? null,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
      };
    });
  }
}

class OpenAICompatibleProvider implements ModelProvider {
  readonly provider = 'openai-compatible';

  constructor(
    readonly model: string,
    private readonly client: OpenAIClient
  ) {}

  async complete<T>(request: ModelRequest<T>): Promise<ModelCompletion<T>> {
    return runBoundedModelRequest(this.provider, this.model, request, async (signal) => {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: request.schemaName,
              schema: providerJsonSchema(request.schema),
              strict: true,
            },
          },
          temperature: OPENAI_COMPATIBLE_TEMPERATURE,
        },
        { signal }
      );
      const content = response.choices[0]?.message.content ?? '';
      return {
        value: parseStructuredResponse(request.schema, content),
        inputTokens: response.usage?.prompt_tokens ?? null,
        outputTokens: response.usage?.completion_tokens ?? null,
      };
    });
  }
}

async function runBoundedModelRequest<T>(
  provider: string,
  model: string,
  request: ModelRequest<T>,
  operation: (signal: AbortSignal) => Promise<ModelCompletion<T>>
): Promise<ModelCompletion<T>> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Model request timeoutMs must be a positive integer');
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;

  try {
    signal.throwIfAborted();
    const completion = await operation(signal);
    signal.throwIfAborted();
    return completion;
  } catch (error) {
    let failureMessage: string;
    if (request.signal?.aborted) {
      failureMessage = `${provider}/${model} request was cancelled`;
    } else if (timeoutSignal.aborted) {
      failureMessage = `${provider}/${model} request timed out after ${timeoutMs}ms`;
    } else if (error instanceof InvalidStructuredOutputError) {
      failureMessage = `${provider}/${model} returned invalid structured output: ${error.message}`;
    } else {
      failureMessage = `${provider}/${model} request failed: ${safeProviderError(error)}`;
    }
    // Raw SDK errors can include credentials or request content, so do not retain them as causes.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(failureMessage);
  }
}

function parseStructuredResponse<T>(schema: z.ZodType<T>, input: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.trim());
  } catch {
    throw new InvalidStructuredOutputError('Model response did not contain JSON');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidStructuredOutputError('Model response did not match the requested schema');
  }
  return result.data;
}

function providerJsonSchema<T>(schema: z.ZodType<T>): Record<string, unknown> {
  const providerSchema = {
    ...(z.toJSONSchema(schema) as Record<string, unknown>),
  };
  delete providerSchema.$schema;
  return providerSchema;
}

function safeProviderError(error: unknown): string {
  const record =
    error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
  const status =
    typeof record?.status === 'number' && Number.isInteger(record.status)
      ? `HTTP ${record.status}`
      : null;
  const code =
    typeof record?.code === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(record.code)
      ? record.code
      : null;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage
    .replace(PROVIDER_SECRET, '[REDACTED]')
    .replace(PROVIDER_SECRET_ASSIGNMENT, '$1[REDACTED]')
    .slice(0, 500);
  return [status, code, message].filter(Boolean).join(' / ') || 'provider error';
}

function requireCredential(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function validateOpenAICompatibleBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OpenAI-compatible base URL must be a valid HTTP(S) URL');
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !loopback) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'OpenAI-compatible base URL must use HTTPS, or credential-free HTTP on loopback'
    );
  }
  return url.toString().replace(/\/$/, '');
}

class InvalidStructuredOutputError extends Error {}
