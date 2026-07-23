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
      const baseURL =
        config.baseUrl ?? process.env.QAGENT_OPENAI_BASE_URL ?? 'http://127.0.0.1:11434/v1';
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
    const response = await this.client.responses.create(
      {
        model: this.model,
        instructions: request.system,
        input: request.prompt,
        text: {
          format: {
            type: 'json_schema',
            name: request.schemaName,
            schema: z.toJSONSchema(request.schema),
            strict: true,
          },
        },
      },
      { signal: request.signal }
    );
    return {
      value: request.schema.parse(JSON.parse(response.output_text)),
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
    };
  }
}

class AnthropicProvider implements ModelProvider {
  readonly provider = 'anthropic';

  constructor(
    readonly model: string,
    private readonly client: AnthropicClient
  ) {}

  async complete<T>(request: ModelRequest<T>): Promise<ModelCompletion<T>> {
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 16_000,
        system: `${request.system}\nReturn only JSON matching this schema:\n${JSON.stringify(
          z.toJSONSchema(request.schema)
        )}`,
        messages: [{ role: 'user', content: request.prompt }],
      },
      { signal: request.signal }
    );
    const text = response.content
      .filter((block): block is { type: string; text: string } =>
        Boolean(block.type === 'text' && block.text)
      )
      .map((block) => block.text)
      .join('\n');
    return {
      value: request.schema.parse(extractJson(text)),
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}

class GoogleProvider implements ModelProvider {
  readonly provider = 'google';

  constructor(
    readonly model: string,
    private readonly client: GoogleClient
  ) {}

  async complete<T>(request: ModelRequest<T>): Promise<ModelCompletion<T>> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: request.prompt,
      config: {
        systemInstruction: request.system,
        responseMimeType: 'application/json',
        responseJsonSchema: z.toJSONSchema(request.schema),
        abortSignal: request.signal,
      },
    });
    return {
      value: request.schema.parse(extractJson(response.text ?? '')),
      inputTokens: response.usageMetadata?.promptTokenCount ?? null,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
    };
  }
}

class OpenAICompatibleProvider implements ModelProvider {
  readonly provider = 'openai-compatible';

  constructor(
    readonly model: string,
    private readonly client: OpenAIClient
  ) {}

  async complete<T>(request: ModelRequest<T>): Promise<ModelCompletion<T>> {
    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: [
          { role: 'system', content: request.system },
          {
            role: 'user',
            content: `${request.prompt}\n\nReturn only JSON matching:\n${JSON.stringify(
              z.toJSONSchema(request.schema)
            )}`,
          },
        ],
        response_format: { type: 'json_object' },
      },
      { signal: request.signal }
    );
    const content = response.choices[0]?.message.content ?? '';
    return {
      value: request.schema.parse(extractJson(content)),
      inputTokens: response.usage?.prompt_tokens ?? null,
      outputTokens: response.usage?.completion_tokens ?? null,
    };
  }
}

function extractJson(input: string): unknown {
  const trimmed = input
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = Math.min(
    ...['{', '['].map((character) => trimmed.indexOf(character)).filter((index) => index >= 0)
  );
  if (!Number.isFinite(start)) throw new Error('Model response did not contain JSON');
  return JSON.parse(trimmed.slice(start));
}

function requireCredential(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
