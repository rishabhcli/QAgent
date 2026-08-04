import { z } from 'zod';

export const CommandSchema = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().default('.'),
  env: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().max(3_600_000).default(120_000),
});

export const BrowserFlowSchema = z.object({
  name: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
});

export const QAgentConfigSchema = z.object({
  version: z.literal(1),
  project: z
    .object({
      name: z.string().min(1).optional(),
    })
    .prefault({}),
  target: z
    .object({
      url: z.url().optional(),
      healthPath: z.string().startsWith('/').default('/'),
      start: CommandSchema.optional(),
    })
    .prefault({}),
  test: z.object({
    commands: z.array(CommandSchema).min(1),
    browserFlows: z.array(BrowserFlowSchema).default([]),
  }),
  verify: z
    .object({
      commands: z.array(CommandSchema).default([]),
    })
    .prefault({}),
  browser: z
    .object({
      provider: z.enum(['local', 'browserbase']).default('local'),
      executablePath: z.string().optional(),
      headless: z.boolean().default(true),
    })
    .prefault({}),
  model: z.object({
    provider: z.enum(['openai', 'anthropic', 'google', 'openai-compatible']),
    model: z.string().min(1),
    baseUrl: z.url().optional(),
  }),
  publish: z
    .object({
      provider: z.enum(['github', 'local']).default('github'),
      baseBranch: z.string().min(1).default('main'),
      autoMerge: z.boolean().default(true),
      mergeMethod: z.enum(['squash', 'merge', 'rebase']).default('squash'),
    })
    .prefault({}),
  limits: z
    .object({
      maxIterations: z.number().int().min(1).max(20).default(5),
      maxRunMinutes: z.number().int().min(1).max(720).default(30),
      maxPatchBytes: z.number().int().min(1_024).max(2_000_000).default(250_000),
      maxProviderCostUsd: z.number().positive().max(1_000).optional(),
    })
    .prefault({}),
  telemetry: z
    .object({
      weave: z
        .object({
          enabled: z.boolean().default(false),
          project: z.string().min(1).default('qagent'),
          uploadArtifacts: z.boolean().default(false),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type CommandSpec = z.infer<typeof CommandSchema>;
export type BrowserFlow = z.infer<typeof BrowserFlowSchema>;
export type QAgentConfig = z.infer<typeof QAgentConfigSchema>;

export function qagentConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(QAgentConfigSchema, {
    target: 'draft-2020-12',
    reused: 'ref',
  }) as Record<string, unknown>;
}
