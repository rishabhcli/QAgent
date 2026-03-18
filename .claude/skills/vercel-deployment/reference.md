# Reference: Vercel Deployment

Copy-paste code patterns for automated deployment.

---

## Quick Start

```typescript
// Using Vercel REST API directly
const response = await fetch('https://api.vercel.com/v13/deployments', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.VERCEL_TOKEN}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'qagent-demo',
    gitSource: {
      type: 'github',
      ref: 'main',
      repoId: process.env.GITHUB_REPO_ID
    }
  })
});

const deployment = await response.json();
console.log('Deployment URL:', deployment.url);
```

---

## Code Patterns

### Pattern 1: Complete Verifier Deployment Flow

**Use when:** Implementing the Verifier Agent

```typescript
import { execSync } from 'child_process';

interface DeploymentResult {
  success: boolean;
  url?: string;
  error?: string;
  duration: number;
}

async function deployPatch(
  patchedFiles: string[],
  commitMessage: string
): Promise<DeploymentResult> {
  const startTime = Date.now();

  try {
    // 1. Stage patched files
    for (const file of patchedFiles) {
      execSync(`git add "${file}"`, { stdio: 'pipe' });
    }

    // 2. Commit changes
    execSync(`git commit -m "${commitMessage}"`, { stdio: 'pipe' });

    // 3. Push to trigger Vercel
    execSync('git push origin main', { stdio: 'pipe' });

    // 4. Get latest deployment from Vercel API
    const deployment = await getLatestDeployment();

    // 5. Wait for deployment to be ready
    const readyDeployment = await waitForReady(deployment.uid);

    return {
      success: true,
      url: `https://${readyDeployment.url}`,
      duration: Date.now() - startTime
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime
    };
  }
}

async function getLatestDeployment(): Promise<any> {
  const response = await fetch(
    `https://api.vercel.com/v6/deployments?projectId=${process.env.VERCEL_PROJECT_ID}&limit=1`,
    {
      headers: {
        'Authorization': `Bearer ${process.env.VERCEL_TOKEN}`
      }
    }
  );

  const data = await response.json();
  return data.deployments[0];
}

async function waitForReady(
  deploymentId: string,
  timeout: number = 120000
): Promise<any> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const response = await fetch(
      `https://api.vercel.com/v13/deployments/${deploymentId}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.VERCEL_TOKEN}`
        }
      }
    );

    const deployment = await response.json();

    if (deployment.readyState === 'READY') {
      return deployment;
    }

    if (deployment.readyState === 'ERROR') {
      throw new Error(`Build failed: ${deployment.errorMessage || 'Unknown error'}`);
    }

    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  throw new Error('Deployment timeout');
}
```

### Pattern 2: Get Deployment Status

**Use when:** Checking if a deployment is ready

```typescript
interface DeploymentStatus {
  id: string;
  state: 'QUEUED' | 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED';
  url: string | null;
  errorMessage: string | null;
  createdAt: number;
  buildingAt: number | null;
  readyAt: number | null;
}

async function getDeploymentStatus(deploymentId: string): Promise<DeploymentStatus> {
  const response = await fetch(
    `https://api.vercel.com/v13/deployments/${deploymentId}`,
    {
      headers: {
        'Authorization': `Bearer ${process.env.VERCEL_TOKEN}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to get deployment: ${response.statusText}`);
  }

  const data = await response.json();

  return {
    id: data.uid,
    state: data.readyState,
    url: data.url ? `https://${data.url}` : null,
    errorMessage: data.errorMessage || null,
    createdAt: data.createdAt,
    buildingAt: data.buildingAt,
    readyAt: data.ready
  };
}
```

### Pattern 3: List Recent Deployments

**Use when:** Finding deployments for a project

```typescript
interface DeploymentSummary {
  id: string;
  url: string;
  state: string;
  createdAt: Date;
  meta?: {
    githubCommitSha?: string;
    githubCommitMessage?: string;
  };
}

async function listDeployments(limit: number = 10): Promise<DeploymentSummary[]> {
  const response = await fetch(
    `https://api.vercel.com/v6/deployments?projectId=${process.env.VERCEL_PROJECT_ID}&limit=${limit}`,
    {
      headers: {
        'Authorization': `Bearer ${process.env.VERCEL_TOKEN}`
      }
    }
  );

  const data = await response.json();

  return data.deployments.map((d: any) => ({
    id: d.uid,
    url: `https://${d.url}`,
    state: d.readyState,
    createdAt: new Date(d.createdAt),
    meta: d.meta
  }));
}
```

### Pattern 4: Rollback to Previous Deployment

**Use when:** Fix caused regression, need to undo

```typescript
async function rollback(deploymentId: string): Promise<void> {
  // Promote a previous deployment to production
  const response = await fetch(
    `https://api.vercel.com/v13/deployments/${deploymentId}/aliases`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.VERCEL_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        alias: process.env.PRODUCTION_DOMAIN
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Rollback failed: ${response.statusText}`);
  }
}
```

### Pattern 5: Get Build Logs

**Use when:** Debugging build failures

```typescript
async function getBuildLogs(deploymentId: string): Promise<string[]> {
  const response = await fetch(
    `https://api.vercel.com/v2/deployments/${deploymentId}/events`,
    {
      headers: {
        'Authorization': `Bearer ${process.env.VERCEL_TOKEN}`
      }
    }
  );

  const events = await response.json();

  return events
    .filter((e: any) => e.type === 'stdout' || e.type === 'stderr')
    .map((e: any) => `[${e.type}] ${e.payload.text}`);
}
```

---

## Configuration Examples

### Environment Variables

```bash
# .env.local
VERCEL_TOKEN=your_token_here
VERCEL_PROJECT_ID=prj_xxxxx
VERCEL_TEAM_ID=team_xxxxx  # Optional, for team projects
GITHUB_REPO_ID=123456789
```

### Getting Your Token

1. Go to https://vercel.com/account/tokens
2. Create new token with scope "Full Access"
3. Copy and save securely

### Getting Project ID

```bash
# Using Vercel CLI
vercel project ls

# Or from dashboard URL
# https://vercel.com/team/project-name/settings
# Project ID shown in settings
```

---

## Common Commands

```bash
# Install Vercel CLI
pnpm add -g vercel

# Link project
vercel link

# Deploy manually
vercel deploy

# Deploy to production
vercel --prod

# List deployments
vercel ls

# Get deployment URL
vercel inspect <deployment-url>
```

---

## Troubleshooting

### Issue: 401 Unauthorized

**Symptom:** API returns "Unauthorized"

**Solution:**
```typescript
// Check token is set
if (!process.env.VERCEL_TOKEN) {
  throw new Error('VERCEL_TOKEN not set');
}

// Ensure correct header format
headers: {
  'Authorization': `Bearer ${process.env.VERCEL_TOKEN}`
}
```

### Issue: Build fails with dependency error

**Symptom:** "Module not found" in build logs

**Solution:**
```bash
# Ensure package.json is committed
git add package.json pnpm-lock.yaml
git commit -m "Update dependencies"
```

### Issue: Deployment stuck in QUEUED

**Symptom:** Deployment never starts building

**Solution:**
```typescript
// Check if team has available concurrent builds
const response = await fetch('https://api.vercel.com/v2/teams/current', {
  headers: { 'Authorization': `Bearer ${process.env.VERCEL_TOKEN}` }
});
// Review usage limits
```

---

## Cheat Sheet

| Task | API Endpoint |
|------|-------------|
| Create deployment | `POST /v13/deployments` |
| Get deployment | `GET /v13/deployments/{id}` |
| List deployments | `GET /v6/deployments` |
| Get build logs | `GET /v2/deployments/{id}/events` |
| Cancel deployment | `PATCH /v12/deployments/{id}/cancel` |
| Delete deployment | `DELETE /v13/deployments/{id}` |
| Set alias | `POST /v13/deployments/{id}/aliases` |
