/**
 * E2E Test Runner
 *
 * Runs all test specifications using the Tester Agent
 * and reports results.
 */

import { TesterAgent } from '@/agents/tester';
import { allTestSpecs } from './specs';
import { encrypt } from '@/lib/auth/session';
import type { TestResult } from '@/lib/types';
import fs from 'node:fs';
import path from 'node:path';

interface RunnerResult {
  total: number;
  passed: number;
  failed: number;
  results: Array<{
    spec: string;
    result: TestResult;
  }>;
}

const LOCAL_SMOKE_USER = {
  id: 1,
  login: 'patchpilot',
  name: 'PatchPilot',
  avatarUrl: 'https://github.com/identicons/patchpilot.png',
};

const LOCAL_SMOKE_REPO = {
  id: 101,
  name: 'demo',
  fullName: 'patchpilot/demo',
  url: 'https://github.com/patchpilot/demo',
  defaultBranch: 'main',
};

function readEnvFileValue(filePath: string, key: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const line = fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${key}=`));

  if (!line) {
    return null;
  }

  return line.slice(key.length + 1).trim() || null;
}

async function createLocalSmokeCookie(): Promise<string | null> {
  const localTarget = process.env.TARGET_URL || 'http://localhost:3000';
  const targetOrigin = new URL(localTarget).origin;

  if (!targetOrigin.startsWith('http://localhost') && !targetOrigin.startsWith('http://127.0.0.1')) {
    return null;
  }

  if (!process.env.SESSION_SECRET) {
    const envCandidates = [
      path.join(process.cwd(), '.env.local'),
      path.join(process.cwd(), '.env.development.local'),
      path.join(process.cwd(), '.env'),
    ];

    for (const envFile of envCandidates) {
      const secret = readEnvFileValue(envFile, 'SESSION_SECRET');
      if (secret) {
        process.env.SESSION_SECRET = secret;
        break;
      }
    }
  }

  if (!process.env.SESSION_SECRET) {
    return null;
  }

  const token = await encrypt({
    user: LOCAL_SMOKE_USER,
    accessToken: 'local-smoke-token',
    repos: [LOCAL_SMOKE_REPO],
    selectedRepoIds: [LOCAL_SMOKE_REPO.id],
  });

  return `qagent_session=${token}`;
}

function installLocalSmokeFetchCookie(cookie: string): void {
  const originalFetch = globalThis.fetch.bind(globalThis);
  const targetOrigin = new URL(process.env.TARGET_URL || 'http://localhost:3000').origin;

  globalThis.fetch = (async (resource: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const requestUrl =
      typeof resource === 'string'
        ? resource
        : resource instanceof URL
          ? resource.toString()
          : resource.url;
    const resolvedOrigin = new URL(requestUrl, targetOrigin).origin;

    if (resolvedOrigin !== targetOrigin) {
      return originalFetch(resource as never, init);
    }

    const headers = new Headers(
      resource instanceof Request ? resource.headers : (init?.headers as HeadersInit | undefined)
    );
    headers.set('Cookie', cookie);

    if (resource instanceof Request) {
      return originalFetch(new Request(resource, { ...init, headers }));
    }

    return originalFetch(resource as never, { ...init, headers });
  }) as typeof globalThis.fetch;
}

async function runAllTests(): Promise<RunnerResult> {
  console.log('🚀 Starting E2E Test Runner\n');
  const targetUrl = process.env.TARGET_URL || 'http://localhost:3000';
  console.log(`🎯 Target URL: ${targetUrl}`);
  console.log(`📋 Found ${allTestSpecs.length} test specifications\n`);

  const localSmokeCookie = await createLocalSmokeCookie();
  if (localSmokeCookie) {
    installLocalSmokeFetchCookie(localSmokeCookie);
    console.log('🍪 Local authenticated smoke session enabled');
  }

  const testerAgent = new TesterAgent();
  const results: RunnerResult = {
    total: allTestSpecs.length,
    passed: 0,
    failed: 0,
    results: [],
  };

  try {
    await testerAgent.init();
    console.log('✅ Tester Agent initialized\n');

    for (const spec of allTestSpecs) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`📝 Running: ${spec.name} (${spec.id})`);
      console.log(`   URL: ${spec.url}`);
      console.log(`   Steps: ${spec.steps.length}`);
      console.log('='.repeat(60));

      const result = await testerAgent.runTest(spec);

      results.results.push({
        spec: spec.id,
        result,
      });

      if (result.passed) {
        results.passed++;
        console.log(`\n✅ PASSED in ${result.duration}ms`);
      } else {
        results.failed++;
        console.log(`\n❌ FAILED at step ${result.failureReport?.step ?? 'unknown'}`);
        console.log(`   Error: ${result.failureReport?.error.message}`);

        if (result.failureReport?.context.consoleLogs.length) {
          console.log(`\n   Console Logs:`);
          for (const log of result.failureReport.context.consoleLogs.slice(-5)) {
            console.log(`   [${log.type}] ${log.message}`);
          }
        }
      }
    }
  } finally {
    await testerAgent.close();
    console.log('\n🔒 Tester Agent closed');
  }

  // Print summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total:  ${results.total}`);
  console.log(`Passed: ${results.passed} ✅`);
  console.log(`Failed: ${results.failed} ❌`);
  console.log(`Pass Rate: ${((results.passed / results.total) * 100).toFixed(1)}%`);

  if (results.failed > 0) {
    console.log('\n❌ Failed Tests:');
    for (const { spec, result } of results.results) {
      if (!result.passed) {
        console.log(`   - ${spec}: ${result.failureReport?.error.message}`);
      }
    }
  }

  return results;
}

// Run if executed directly
runAllTests()
  .then((results) => {
    process.exit(results.failed > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

export { runAllTests };
