import { randomUUID } from 'node:crypto';
import type { Integration, Provenance } from '@qagent/contracts';

interface IntegrationDefinition {
  provider: string;
  variables: string[];
}

const definitions: IntegrationDefinition[] = [
  { provider: 'github', variables: ['GITHUB_TOKEN'] },
  { provider: 'browserbase', variables: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'] },
  { provider: 'weave', variables: ['WANDB_API_KEY'] },
  { provider: 'redis', variables: ['REDIS_URL'] },
  { provider: 'vercel', variables: ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID'] },
  { provider: 'daytona', variables: ['DAYTONA_API_KEY'] },
];

export function localIntegrationStatus(env: NodeJS.ProcessEnv = process.env): Integration[] {
  const timestamp = new Date().toISOString();
  const provenance: Provenance = { source: 'local', capturedAt: timestamp };
  return definitions.map((definition) => {
    const present = definition.variables.filter((variable) => Boolean(env[variable]));
    return {
      id: randomUUID(),
      provider: definition.provider,
      status: present.length === definition.variables.length ? 'configured' : 'unconfigured',
      detail:
        present.length === definition.variables.length
          ? 'Credentials are configured; run a live check before treating this adapter as verified.'
          : `Missing ${definition.variables.filter((variable) => !env[variable]).join(', ')}`,
      provenance,
      updatedAt: timestamp,
    };
  });
}
