import { randomUUID } from 'node:crypto';
import type { Integration, Provenance } from '@qagent/contracts';

interface IntegrationDefinition {
  provider: string;
  requirements: Array<{
    variable: string;
    label: string;
    secret: boolean;
  }>;
}

const definitions: IntegrationDefinition[] = [
  {
    provider: 'github',
    requirements: [{ variable: 'GITHUB_TOKEN', label: 'Access token', secret: true }],
  },
  {
    provider: 'browserbase',
    requirements: [
      { variable: 'BROWSERBASE_API_KEY', label: 'API key', secret: true },
      { variable: 'BROWSERBASE_PROJECT_ID', label: 'Project ID', secret: false },
    ],
  },
  {
    provider: 'weave',
    requirements: [{ variable: 'WANDB_API_KEY', label: 'API key', secret: true }],
  },
  {
    provider: 'redis',
    requirements: [{ variable: 'REDIS_URL', label: 'Migration URL', secret: true }],
  },
  {
    provider: 'vercel',
    requirements: [
      { variable: 'VERCEL_TOKEN', label: 'Access token', secret: true },
      { variable: 'VERCEL_PROJECT_ID', label: 'Project ID', secret: false },
    ],
  },
  {
    provider: 'daytona',
    requirements: [{ variable: 'DAYTONA_API_KEY', label: 'API key', secret: true }],
  },
];

export function localIntegrationStatus(env: NodeJS.ProcessEnv = process.env): Integration[] {
  const timestamp = new Date().toISOString();
  const provenance: Provenance = { source: 'local', capturedAt: timestamp };
  return definitions.map((definition) => {
    const requirements = definition.requirements.map((requirement) => ({
      id: requirement.variable.toLowerCase().replaceAll('_', '-'),
      label: requirement.label,
      state: env[requirement.variable] ? ('configured' as const) : ('missing' as const),
      secret: requirement.secret,
    }));
    const missing = definition.requirements.filter((requirement) => !env[requirement.variable]);
    return {
      id: randomUUID(),
      provider: definition.provider,
      status: missing.length === 0 ? 'configured' : 'unconfigured',
      detail:
        missing.length === 0
          ? 'Credentials are configured; run a live check before treating this adapter as verified.'
          : `Missing ${missing.map((requirement) => requirement.variable).join(', ')}`,
      requirements,
      provenance,
      updatedAt: timestamp,
    };
  });
}
