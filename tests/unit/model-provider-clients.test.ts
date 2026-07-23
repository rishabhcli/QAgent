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
      { type: 'text', text: 'Response: {"answer":"anthropic"}' },
      { type: 'tool_use', id: 'ignored' },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  } as {
    content: Array<{ type: string; text?: string; id?: string }>;
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
};

const factories: ModelClientFactories = {
  openai: (options) => {
    state.openAIOptions.push(options);
    return {
      responses: {
        create: async (input, requestOptions) => {
          state.responseCreate(input, requestOptions);
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
      { type: 'text', text: 'Response: {"answer":"anthropic"}' },
      { type: 'tool_use', id: 'ignored' },
    ],
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
});

describe('hosted model adapters', () => {
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
        text: { format: expect.objectContaining({ type: 'json_schema', strict: true }) },
      }),
      { signal: undefined }
    );
  });

  it('extracts Anthropic text blocks and ignores non-text blocks', async () => {
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
        messages: [{ role: 'user', content: 'Prompt' }],
      }),
      { signal: undefined }
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
        config: expect.objectContaining({ responseMimeType: 'application/json' }),
      })
    );
  });

  it('supports OpenAI-compatible fenced JSON, local defaults, and nullable usage', async () => {
    state.compatibleResponse = {
      choices: [{ message: { content: 'before [1, 2, 3]' } }],
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

    state.compatibleResponse = {
      choices: [{ message: { content: '```json\n{"answer":"compatible"}\n```' } }],
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

  it('rejects provider output that does not match the declared schema', async () => {
    state.openAIResponse = { output_text: '{"answer":42}' };
    const provider = createModelProvider(
      { provider: 'openai', model: 'gpt-test' },
      { openai: 'session-openai' },
      factories
    );
    await expect(complete(provider)).rejects.toThrow();
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
