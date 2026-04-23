# Skill: Vercel Deployment

## When to Use This Skill

Use this skill when:
- Implementing the Verifier Agent
- Deploying patched code automatically
- Monitoring deployment status
- Getting deployment URLs for testing

Do NOT use this skill when:
- Running browser tests (use browserbase-stagehand)
- Working with the knowledge base (use redis-vectorstore)

---

## Overview

Vercel provides instant deployment for Next.js applications. The Verifier Agent uses Vercel to:
1. Deploy patched code after fixes are applied
2. Get deployment URLs for re-testing
3. Monitor deployment status

Two deployment approaches:
1. **Git-based**: Push to GitHub, Vercel auto-deploys
2. **API-based**: Use Vercel API to trigger deployments directly

---

## Key Concepts

### Deployment Lifecycle

```
Git Push → Build → Deploy → Ready
   │         │        │        │
   │         │        │        └── Deployment URL available
   │         │        └── Files being distributed
   │         └── npm install, next build
   └── Triggers Vercel webhook
```

### Deployment States

- `QUEUED` - Waiting to start
- `BUILDING` - Build in progress
- `READY` - Deployment successful
- `ERROR` - Build or deploy failed
- `CANCELED` - Deployment was canceled

### Preview vs Production

- **Preview**: Auto-deploys for every push/PR
- **Production**: Only deploys from main branch (or manual promotion)

For QAgent, we use preview deployments for testing fixes.

---

## Common Patterns

### Git-Based Deployment Flow

```typescript
import { execSync } from 'child_process';

async function deployViaPush(
  patchFile: string,
  commitMessage: string
): Promise<string> {
  // Apply patch (already done by Fixer)

  // Commit changes
  execSync(`git add ${patchFile}`);
  execSync(`git commit -m "${commitMessage}"`);

  // Push to trigger Vercel
  execSync('git push origin main');

  // Get deployment URL from Vercel API
  const deployment = await waitForDeployment();
  return deployment.url;
}
```

### API-Based Deployment

```typescript
import { Vercel } from '@vercel/sdk';

const vercel = new Vercel({ token: process.env.VERCEL_TOKEN });

async function triggerDeployment(): Promise<Deployment> {
  const deployment = await vercel.deployments.create({
    name: process.env.VERCEL_PROJECT_ID,
    target: 'preview',
    gitSource: {
      type: 'github',
      ref: 'main',
      repoId: process.env.GITHUB_REPO_ID
    }
  });

  return deployment;
}
```

### Poll for Deployment Status

```typescript
async function waitForDeployment(
  deploymentId: string,
  timeout: number = 120000
): Promise<Deployment> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const deployment = await vercel.deployments.get(deploymentId);

    if (deployment.readyState === 'READY') {
      return deployment;
    }

    if (deployment.readyState === 'ERROR') {
      throw new Error(`Deployment failed: ${deployment.errorMessage}`);
    }

    await sleep(5000); // Poll every 5 seconds
  }

  throw new Error('Deployment timeout');
}
```

---

## Best Practices

1. **Use preview deployments** - Don't deploy directly to production
2. **Set reasonable timeouts** - Builds typically take 30-60 seconds
3. **Handle build failures** - Check for errors in deployment response
4. **Clean up old deployments** - Vercel has deployment limits
5. **Use environment variables** - Never hardcode tokens

---

## Common Pitfalls

### Deployment Limits
- Free tier: 100 deployments/day
- Handle rate limiting gracefully

### Build Failures
- Always check `readyState` before using URL
- Parse error messages for debugging

### Git State Issues
- Ensure working directory is clean before commit
- Handle merge conflicts

---

## Related Skills

- `qagent-agents/` - Verifier Agent implementation
- `wandb-weave/` - Logging deployment metrics

---

## References

- [Vercel API Documentation](https://vercel.com/docs/rest-api)
- [Vercel SDK](https://www.npmjs.com/package/@vercel/sdk)
- [Git Integration](https://vercel.com/docs/git)
