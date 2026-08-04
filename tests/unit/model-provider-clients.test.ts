import { createModelProvider, type ModelClientFactories } from '@qagent/adapters';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  openAIOptions: [] as Array<{ apiKey: string; baseURL?: string }>,
  openAIResponse: {
    output_text: '{"answer":"openai"}',
    usage: { input_tokens: 7, output_tokens: 3 },
  } as {
    output_text: string;
    usage?: { input_tokens?: number; output_tokens?: number } | null;
  },
  compatibleResponse: {
    choices: [{ message: { content: '```json\n{"answer":"compatible"}\n```' } }],
    usage: { prompt_tokens: 9, completion_tokens: 4 },
  } as {
    choices: Array<{ message: { content?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  },
  anthropicOptions: [] as Array<{ apiKey: string }>,
  anthropicResponse: {
    content: [
      { type: 'text', text: '{"answer":"anthropic"}' },
      { type: 'tool_use', id: 'ignored' },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  } as {
    content: Array<{ type: string; text?: string; id?: string }>;
    stop_reason?: string | null;
    usage: { input_tokens: number; output_tokens: number };
  },
  googleOptions: [] as Array<{ apiKey: string }>,
  googleResponse: {
    text: '{"answer":"google"}',
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6 },
  } as {
    text?: string;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  },
  responseCreate: vi.fn(),
  chatCreate: vi.fn(),
  anthropicCreate: vi.fn(),
  googleGenerate: vi.fn(),
  openAIError: null as Error | null,
  openAIWaitForAbort: false,
};

const factories: ModelClientFactories = {
  openai: (options) => {
    state.openAIOptions.push(options);
    return {
      responses: {
        create: async (input, requestOptions) => {
          state.responseCreate(input, requestOptions);
          if (state.openAIError) throw state.openAIError;
          if (state.openAIWaitForAbort) {
            return new Promise<never>((_resolve, reject) => {
              const signal = requestOptions.signal;
              if (signal?.aborted) reject(signal.reason);
              else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          }
          return state.openAIResponse;
        },
      },
      chat: {
        completions: {
          create: async (input, requestOptions) => {
            state.chatCreate(input, requestOptions);
            return state.compatibleResponse;
          },
        },
      },
    };
  },
  anthropic: (options) => {
    state.anthropicOptions.push(options);
    return {
      messages: {
        create: async (input, requestOptions) => {
          state.anthropicCreate(input, requestOptions);
          return state.anthropicResponse;
        },
      },
    };
  },
  google: (options) => {
    state.googleOptions.push(options);
    return {
      models: {
        generateContent: async (input) => {
          state.googleGenerate(input);
          return state.googleResponse;
        },
      },
    };
  },
};

const schema = z.object({ answer: z.string() });

beforeEach(() => {
  state.openAIOptions.length = 0;
  state.anthropicOptions.length = 0;
  state.googleOptions.length = 0;
  state.openAIResponse = {
    output_text: '{"answer":"openai"}',
    usage: { input_tokens: 7, output_tokens: 3 },
  };
  state.compatibleResponse = {
    choices: [{ message: { content: '```json\n{"answer":"compatible"}\n```' } }],
    usage: { prompt_tokens: 9, completion_tokens: 4 },
  };
  state.anthropicResponse = {
    content: [
      { type: 'text', text: '{"answer":"anthropic"}' },
      { type: 'tool_use', id: 'ignored' },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  state.googleResponse = {
    text: '{"answer":"google"}',
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6 },
  };
  state.responseCreate.mockClear();
  state.chatCreate.mockClear();
  state.anthropicCreate.mockClear();
  state.googleGenerate.mockClear();
  state.openAIError = null;
  state.openAIWaitForAbort = false;
});

describe('hosted model adapters', () => {
  it('requires HTTPS for remote compatible endpoints and permits loopback HTTP', () => {
    expect(() =>
      createModelProvider({
        provider: 'openai-compatible',
        model: 'remote-model',
        baseUrl: 'http://models.example.test/v1',
      })
    ).toThrow('must use HTTPS');
    expect(() =>
      createModelProvider({
        provider: 'openai-compatible',
        model: 'remote-model',
        baseUrl: 'https://user:password@models.example.test/v1',
      })
    ).toThrow('must use HTTPS');
    expect(() =>
      createModelProvider({
        provider: 'openai-compatible',
        model: 'local-model',
        baseUrl: 'http://127.0.0.1:11434/v1',
      })
    ).not.toThrow();
  });

  it('uses OpenAI Responses strict JSON schema output and usage provenance', async () => {
    const provider = createModelProvider(
      { provider: 'openai', model: 'gpt-test' },
      { openai: 'session-openai' },
      factories
    );
    await expect(complete(provider)).resolves.toEqual({
      value: { answer: 'openai' },
      inputTokens: 7,
      outputTokens: 3,
    });
    expect(state.openAIOptions).toEqual([{ apiKey: 'session-openai' }]);
    expect(state.responseCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-test',
        instructions: 'System',
        input: 'Prompt',
        store: false,
        text: { format: expect.objectContaining({ type: 'json_schema', strict: true }) },
      }),
      { signal: expect.any(AbortSignal) }
    );
  });

  it('uses Anthropic JSON schema output and ignores non-text blocks', async () => {
    const provider = createModelProvider(
      { provider: 'anthropic', model: 'claude-test' },
      { anthropic: 'session-anthropic' },
      factories
    );
    await expect(complete(provider)).resolves.toEqual({
      value: { answer: 'anthropic' },
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(state.anthropicOptions).toEqual([{ apiKey: 'session-anthropic' }]);
    expect(state.anthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-test',
        max_tokens: 16_000,
        system: 'System',
        messages: [{ role: 'user', content: 'Prompt' }],
        output_config: {
          format: {
            type: 'json_schema',
            schema: expect.objectContaining({ type: 'object' }),
          },
        },
      }),
      { signal: expect.any(AbortSignal) }
    );
  });

  it('uses Google JSON schema generation and preserves unavailable token counts', async () => {
    state.googleResponse = { text: '{"answer":"google"}' };
    const provider = createModelProvider(
      { provider: 'google', model: 'gemini-test' },
      { google: 'session-google' },
      factories
    );
    await expect(complete(provider)).resolves.toEqual({
      value: { answer: 'google' },
      inputTokens: null,
      outputTokens: null,
    });
    expect(state.googleOptions).toEqual([{ apiKey: 'session-google' }]);
    expect(state.googleGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-test',
        contents: 'Prompt',
        config: expect.objectContaining({
          responseMimeType: 'application/json',
          responseJsonSchema: expect.objectContaining({ type: 'object' }),
          abortSignal: expect.any(AbortSignal),
        }),
      })
    );
  });

  it('uses strict OpenAI-compatible JSON schema, deterministic sampling, and local defaults', async () => {
    state.compatibleResponse = {
      choices: [{ message: { content: '[1, 2, 3]' } }],
    };
    const arrayProvider = createModelProvider(
      { provider: 'openai-compatible', model: 'ollama-test' },
      {},
      factories
    );
    const arrayCompletion = await arrayProvider.complete({
      purpose: 'other',
      system: 'System',
      prompt: 'Prompt',
      schemaName: 'numbers',
      schema: z.array(z.number()),
    });
    expect(arrayCompletion).toEqual({ value: [1, 2, 3], inputTokens: null, outputTokens: null });
    expect(state.openAIOptions.at(-1)).toEqual({
      apiKey: 'local',
      baseURL: 'http://127.0.0.1:11434/v1',
    });
    expect(state.chatCreate).toHaveBeenLastCalledWith(
      {
        model: 'ollama-test',
        messages: [
          { role: 'system', content: 'System' },
          { role: 'user', content: 'Prompt' },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'numbers',
            schema: expect.objectContaining({ type: 'array' }),
            strict: true,
          },
        },
        temperature: 0,
      },
      { signal: expect.any(AbortSignal) }
    );
    expect(state.chatCreate.mock.calls.at(-1)?.[0]).not.toHaveProperty('seed');

    state.compatibleResponse = {
      choices: [{ message: { content: '{"answer":"compatible"}' } }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    };
    await expect(
      complete(
        createModelProvider(
          {
            provider: 'openai-compatible',
            model: 'remote-compatible',
            baseUrl: 'https://models.example.test/v1',
          },
          { openaiCompatible: 'compatible-key' },
          factories
        )
      )
    ).resolves.toEqual({
      value: { answer: 'compatible' },
      inputTokens: 9,
      outputTokens: 4,
    });
  });

  it('rejects decorated OpenAI-compatible output instead of extracting embedded JSON', async () => {
    state.compatibleResponse = {
      choices: [{ message: { content: '```json\n{"answer":"compatible"}\n```' } }],
    };
    const provider = createModelProvider(
      { provider: 'openai-compatible', model: 'strict-compatible' },
      {},
      factories
    );

    await expect(complete(provider)).rejects.toThrow(/returned invalid structured output/);
    expect(state.chatCreate).toHaveBeenCalledTimes(1);
  });

  it('rejects provider output that does not match the declared schema', async () => {
    state.openAIResponse = { output_text: '{"answer":42}' };
    const provider = createModelProvider(
      { provider: 'openai', model: 'gpt-test' },
      { openai: 'session-openai' },
      factories
    );
    await expect(complete(provider)).rejects.toThrow();
  });

  it('bounds provider calls and distinguishes caller cancellation from timeout', async () => {
    state.openAIWaitForAbort = true;
    const provider = createModelProvider(
      { provider: 'openai', model: 'gpt-test' },
      { openai: 'session-openai' },
      factories
    );
    await expect(
      provider.complete({
        purpose: 'other',
        system: 'System',
        prompt: 'Prompt',
        schemaName: 'answer',
        schema,
        timeoutMs: 5,
      })
    ).rejects.toThrow(/timed out after 5ms/);

    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.complete({
        purpose: 'other',
        system: 'System',
        prompt: 'Prompt',
        schemaName: 'answer',
        schema,
        signal: controller.signal,
      })
    ).rejects.toThrow(/request was cancelled/);
  });

  it('redacts credentials from provider failures', async () => {
    state.openAIError = new Error(
      'Authorization: Bearer sk-abcdefghijklmnop api_key=another-secret-value'
    );
    const provider = createModelProvider(
      { provider: 'openai', model: 'gpt-test' },
      { openai: 'session-openai' },
      factories
    );
    const failure = await complete(provider).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('[REDACTED]');
    expect((failure as Error).message).not.toContain('sk-abcdefghijklmnop');
    expect((failure as Error).message).not.toContain('another-secret-value');
  });
});

function complete(provider: ReturnType<typeof createModelProvider>) {
  return provider.complete({
    purpose: 'triage',
    system: 'System',
    prompt: 'Prompt',
    schemaName: 'answer',
    schema,
  });
}
