import { z } from 'zod';

const authSchema = z.object({
  sessionSecret: z.string().min(1).default('default-dev-secret-do-not-use-in-prod'),
  githubClientId: z.string().default(''),
  githubClientSecret: z.string().default(''),
  githubToken: z.string().optional(),
  githubRepo: z.string().optional(),
  githubWebhookSecret: z.string().optional(),
});

const browserbaseSchema = z.object({
  apiKey: z.string().optional(),
  projectId: z.string().optional(),
});

const llmSchema = z.object({
  openaiApiKey: z.string().optional(),
  googleApiKey: z.string().optional(),
  anthropicApiKey: z.string().optional(),
});

const redisSchema = z.object({
  url: z.string().optional(),
});

const weaveSchema = z.object({
  wandbApiKey: z.string().optional(),
  wandbEntity: z.string().optional(),
  wandbProject: z.string().default('qagent'),
  weaveProject: z.string().default('qagent'),
});

const vercelSchema = z.object({
  token: z.string().optional(),
  projectId: z.string().optional(),
  teamId: z.string().optional(),
});

const appSchema = z.object({
  nodeEnv: z.string().default('development'),
  appUrl: z.string().default('http://localhost:3000'),
  targetUrl: z.string().default('http://localhost:3000'),
  debug: z.coerce.boolean().default(false),
});

const agentSchema = z.object({
  maxIterations: z.coerce.number().int().positive().default(5),
  maxConcurrentRuns: z.coerce.number().int().positive().default(3),
  runRetentionDays: z.coerce.number().int().positive().default(30),
  patchTimeoutMs: z.coerce.number().int().positive().default(30000),
  deployTimeoutMs: z.coerce.number().int().positive().default(120000),
  testTimeoutMs: z.coerce.number().int().positive().default(60000),
});

const featureSchema = z.object({
  enableRedisCache: z.coerce.boolean().default(true),
  enableWeaveLogging: z.coerce.boolean().default(true),
  enableTraceTriage: z.coerce.boolean().default(false),
  enableRedteam: z.coerce.boolean().default(false),
});

const configSchema = z.object({
  auth: authSchema,
  browserbase: browserbaseSchema,
  llm: llmSchema,
  redis: redisSchema,
  weave: weaveSchema,
  vercel: vercelSchema,
  app: appSchema,
  agent: agentSchema,
  features: featureSchema,
});

export type AppConfig = z.infer<typeof configSchema>;

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (_config) return _config;

  const raw = {
    auth: {
      sessionSecret: process.env.SESSION_SECRET,
      githubClientId: process.env.GITHUB_CLIENT_ID,
      githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
      githubToken: process.env.GITHUB_TOKEN,
      githubRepo: process.env.GITHUB_REPO,
      githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    },
    browserbase: {
      apiKey: process.env.BROWSERBASE_API_KEY,
      projectId: process.env.BROWSERBASE_PROJECT_ID,
    },
    llm: {
      openaiApiKey: process.env.OPENAI_API_KEY,
      googleApiKey: process.env.GOOGLE_API_KEY,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    },
    redis: {
      url: process.env.REDIS_URL,
    },
    weave: {
      wandbApiKey: process.env.WANDB_API_KEY,
      wandbEntity: process.env.WANDB_ENTITY,
      wandbProject: process.env.WANDB_PROJECT,
      weaveProject: process.env.WEAVE_PROJECT,
    },
    vercel: {
      token: process.env.VERCEL_TOKEN,
      projectId: process.env.VERCEL_PROJECT_ID,
      teamId: process.env.VERCEL_TEAM_ID,
    },
    app: {
      nodeEnv: process.env.NODE_ENV,
      appUrl: process.env.NEXT_PUBLIC_APP_URL,
      targetUrl: process.env.TARGET_URL,
      debug: process.env.DEBUG,
    },
    agent: {
      maxIterations: process.env.MAX_ITERATIONS,
      maxConcurrentRuns: process.env.MAX_CONCURRENT_RUNS,
      runRetentionDays: process.env.RUN_RETENTION_DAYS,
      patchTimeoutMs: process.env.PATCH_TIMEOUT_MS,
      deployTimeoutMs: process.env.DEPLOY_TIMEOUT_MS,
      testTimeoutMs: process.env.TEST_TIMEOUT_MS,
    },
    features: {
      enableRedisCache: process.env.ENABLE_REDIS_CACHE,
      enableWeaveLogging: process.env.ENABLE_WEAVE_LOGGING,
      enableTraceTriage: process.env.ENABLE_TRACE_TRIAGE,
      enableRedteam: process.env.ENABLE_REDTEAM,
    },
  };

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `  ${i.path.join('.')}: ${i.message}`
    );
    throw new Error(
      `Invalid configuration:\n${issues.join('\n')}`
    );
  }

  _config = result.data;
  return _config;
}

/** Reset cached config (for testing) */
export function resetConfig(): void {
  _config = null;
}

export function isTraceTriageEnabled(): boolean {
  return getConfig().features.enableTraceTriage;
}

export function isRedTeamEnabled(): boolean {
  return getConfig().features.enableRedteam;
}

export function hasLLMConfig(): boolean {
  const c = getConfig();
  return !!(c.llm.googleApiKey || c.llm.openaiApiKey || c.llm.anthropicApiKey);
}
