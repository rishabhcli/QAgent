import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCli } from '@qagent/cli';
import { createLocalRuntime } from '@qagent/core';
import { createQAgentMcpServer } from '@qagent/mcp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { temporaryDirectory } from '../helpers.js';

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('CLI and MCP contract parity', () => {
  it('returns identical durable run detail and scoped resources', async () => {
    const fixture = await interfaceFixture();
    const cliDetail = await cliJson(fixture.home, ['run', 'show', fixture.runId]);

    const session = await mcpSession(fixture.home);
    try {
      const result = await session.client.callTool({
        name: 'run_detail',
        arguments: { runId: fixture.runId },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent?.detail).toEqual(cliDetail);

      const resources = await session.client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toEqual(
        expect.arrayContaining([
          `qagent://projects/${fixture.projectId}`,
          `qagent://runs/${fixture.runId}`,
          `qagent://runs/${fixture.runId}/events`,
          `qagent://runs/${fixture.runId}/patch`,
          `qagent://artifacts/${fixture.artifactId}`,
        ])
      );
      const templates = await session.client.listResourceTemplates();
      expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toEqual(
        expect.arrayContaining([
          'qagent://projects/{projectId}',
          'qagent://runs/{runId}',
          'qagent://runs/{runId}/events',
          'qagent://runs/{runId}/patch',
          'qagent://artifacts/{artifactId}',
        ])
      );

      const runResource = await session.client.readResource({
        uri: `qagent://runs/${fixture.runId}`,
      });
      expect(JSON.parse(runResource.contents[0]?.text ?? '{}')).toEqual(cliDetail);
      const artifactResource = await session.client.readResource({
        uri: `qagent://artifacts/${fixture.artifactId}`,
      });
      expect(artifactResource.contents[0]?.text).toBe('grounded command evidence');
    } finally {
      await session.close();
    }
  });

  it('matches queued cancellation semantics and preserves externally owned running work', async () => {
    const fixture = await interfaceFixture();
    const seeded = createLocalRuntime({ home: fixture.home, weaveEnabled: false });
    const cliQueued = seeded.storage.createRun({
      projectId: fixture.projectId,
      requestedBy: 'cli',
    });
    const mcpQueued = seeded.storage.createRun({
      projectId: fixture.projectId,
      requestedBy: 'mcp',
    });
    const externallyRunning = seeded.storage.createRun({
      projectId: fixture.projectId,
      requestedBy: 'desktop',
    });
    seeded.storage.updateRun(externallyRunning.id, { status: 'running' });
    seeded.close();

    const cliCancellation = await cliJson(fixture.home, ['run', 'cancel', cliQueued.id]);
    expect(cliCancellation).toMatchObject({
      action: 'cancel',
      requestedRunId: cliQueued.id,
      runId: cliQueued.id,
      accepted: true,
    });

    const session = await mcpSession(fixture.home);
    try {
      const mcpCancellation = await session.client.callTool({
        name: 'run_cancel',
        arguments: { runId: mcpQueued.id },
      });
      expect(mcpCancellation.structuredContent?.action).toMatchObject({
        action: 'cancel',
        requestedRunId: mcpQueued.id,
        runId: mcpQueued.id,
        accepted: true,
      });
      const cliRun = await session.client.callTool({
        name: 'run_get',
        arguments: { runId: cliQueued.id },
      });
      const mcpRun = await session.client.callTool({
        name: 'run_get',
        arguments: { runId: mcpQueued.id },
      });
      expect(cliRun.structuredContent?.run).toMatchObject({
        status: 'cancelled',
        completedAt: expect.any(String),
      });
      expect(mcpRun.structuredContent?.run).toMatchObject({
        status: 'cancelled',
        completedAt: expect.any(String),
      });
      const cliEvents = await session.client.callTool({
        name: 'run_events',
        arguments: { runId: cliQueued.id, afterSequence: 0 },
      });
      const mcpEvents = await session.client.callTool({
        name: 'run_events',
        arguments: { runId: mcpQueued.id, afterSequence: 0 },
      });
      const cliEventKinds = eventKinds(cliEvents.structuredContent?.events);
      const mcpEventKinds = eventKinds(mcpEvents.structuredContent?.events);
      expect(cliEventKinds).toEqual(mcpEventKinds);
      expect(cliEventKinds).toContain('run.cancelled');

      const externalRequest = await session.client.callTool({
        name: 'run_cancel',
        arguments: { runId: externallyRunning.id },
      });
      expect(externalRequest.structuredContent?.action).toMatchObject({
        action: 'cancel',
        requestedRunId: externallyRunning.id,
        runId: externallyRunning.id,
        accepted: true,
      });
      const externalRun = await session.client.callTool({
        name: 'run_get',
        arguments: { runId: externallyRunning.id },
      });
      expect(externalRun.structuredContent?.run).toMatchObject({
        status: 'running',
        cancelRequestedAt: expect.any(String),
        completedAt: null,
      });
    } finally {
      await session.close();
    }
  });

  it('offers the same contract-backed workflow actions and rejects unavailable work', async () => {
    const fixture = await interfaceFixture();
    const cliResult = await cliJson(fixture.home, ['run', 'retry', fixture.runId]);
    expect(cliResult).toMatchObject({
      action: 'retry',
      requestedRunId: fixture.runId,
      runId: fixture.runId,
      accepted: false,
      reason: expect.stringContaining('not available'),
    });

    const session = await mcpSession(fixture.home);
    try {
      const tools = await session.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'run_start',
          'run_detail',
          'run_retry',
          'run_resume',
          'run_reconnect',
          'run_cancel',
          'run_resolve_intervention',
        ])
      );
      const mcpResult = await session.client.callTool({
        name: 'run_retry',
        arguments: { runId: fixture.runId },
      });
      expect(mcpResult.structuredContent?.action).toMatchObject({
        action: 'retry',
        requestedRunId: fixture.runId,
        runId: fixture.runId,
        accepted: false,
        reason: expect.stringContaining('not available'),
      });

      const detail = await session.client.callTool({
        name: 'run_detail',
        arguments: { runId: fixture.runId, afterSequence: 1 },
      });
      expect(detail.structuredContent?.detail).toMatchObject({
        run: { id: fixture.runId },
        cursor: { runId: fixture.runId, afterSequence: 1 },
      });
    } finally {
      await session.close();
    }
  });

  it('returns the same grounded integration verification and remediation', async () => {
    const fixture = await interfaceFixture();
    const cliVerification = (await cliJson(fixture.home, ['integration', 'verify', 'model'])) as {
      provider: string;
      integration: { id: string; provider: string; status: string; detail: string };
      disclosureRequired: boolean;
      correctiveAction: unknown;
    };
    expect(cliVerification).toMatchObject({
      provider: 'model',
      integration: {
        provider: 'model',
        status: 'unconfigured',
        detail: expect.stringContaining('valid model configuration'),
      },
      disclosureRequired: false,
      correctiveAction: expect.objectContaining({ type: 'application' }),
    });

    const session = await mcpSession(fixture.home);
    try {
      const tools = await session.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('integration_verify');
      const result = await session.client.callTool({
        name: 'integration_verify',
        arguments: { provider: 'model' },
      });
      expect(result.structuredContent?.verification).toMatchObject({
        provider: cliVerification.provider,
        integration: {
          id: cliVerification.integration.id,
          provider: cliVerification.integration.provider,
          status: cliVerification.integration.status,
          detail: cliVerification.integration.detail,
        },
        disclosureRequired: cliVerification.disclosureRequired,
        correctiveAction: cliVerification.correctiveAction,
      });
    } finally {
      await session.close();
    }
  });

  it('never exposes untrusted project records through MCP', async () => {
    const fixture = await interfaceFixture();
    const runtime = createLocalRuntime({ home: fixture.home, weaveEnabled: false });
    const untrusted = runtime.storage.createProject({
      name: 'Untrusted',
      path: join(fixture.home, 'untrusted'),
      trusted: false,
    });
    runtime.close();

    const session = await mcpSession(fixture.home);
    try {
      const projects = await session.client.callTool({ name: 'project_list', arguments: {} });
      expect(JSON.stringify(projects.structuredContent)).not.toContain(untrusted.id);
      const result = await session.client.callTool({
        name: 'project_get',
        arguments: { projectId: untrusted.id },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('Trusted project'),
      });
    } finally {
      await session.close();
    }
  });
});

async function interfaceFixture() {
  const home = await temporaryDirectory('qagent-interfaces-');
  const runtime = createLocalRuntime({ home, weaveEnabled: false });
  const timestamp = new Date().toISOString();
  const provenance = { source: 'local' as const, capturedAt: timestamp };
  const project = runtime.storage.createProject({
    name: 'Interface fixture',
    path: join(home, 'repository'),
    trusted: true,
    configPath: join(home, 'repository', '.qagent.yml'),
  });
  const run = runtime.storage.createRun({ projectId: project.id, requestedBy: 'desktop' });
  runtime.storage.updateRun(run.id, {
    status: 'succeeded',
    stage: 'complete',
    summary: 'Grounded interface fixture complete.',
    branch: 'qagent/interface-fixture',
    availableActions: [],
    failureCode: null,
    completedAt: timestamp,
  });
  runtime.storage.appendEvent(run.id, {
    kind: 'run.completed',
    stage: 'complete',
    payload: { message: 'Grounded interface fixture complete.' },
    provenance,
    artifactIds: [],
  });
  const artifact = await runtime.artifacts.save({
    runId: run.id,
    kind: 'log',
    name: 'verification.log',
    mimeType: 'text/plain',
    data: 'grounded command evidence',
    provenance,
  });
  const patchArtifact = await runtime.artifacts.save({
    runId: run.id,
    kind: 'patch',
    name: 'repair.diff',
    mimeType: 'text/x-diff',
    data: 'diff --git a/src/app.ts b/src/app.ts\n',
    provenance: { source: 'provider', provider: 'test/model', capturedAt: timestamp },
  });
  const diagnosis = runtime.storage.createDiagnosis({
    id: randomUUID(),
    runId: run.id,
    summary: 'Counter increments twice',
    rootCause: 'The increment function adds two.',
    confidence: 1,
    evidenceArtifactIds: [artifact.id],
    provenance: { source: 'provider', provider: 'test/model', capturedAt: timestamp },
    createdAt: timestamp,
  });
  runtime.storage.createPatch({
    id: randomUUID(),
    runId: run.id,
    diagnosisId: diagnosis.id,
    artifactId: patchArtifact.id,
    summary: 'Increment once',
    files: ['src/app.ts'],
    risk: 'normal',
    applied: true,
    createdAt: timestamp,
  });
  runtime.storage.createVerification({
    id: randomUUID(),
    runId: run.id,
    passed: true,
    commands: [
      {
        executable: 'node',
        args: ['--test'],
        exitCode: 0,
        durationMs: 25,
        artifactId: artifact.id,
      },
    ],
    artifactIds: [artifact.id],
    createdAt: timestamp,
  });
  runtime.storage.recordProviderCall({
    id: randomUUID(),
    runId: run.id,
    provider: 'test',
    model: 'repair-model',
    purpose: 'patch',
    status: 'succeeded',
    inputTokens: 10,
    outputTokens: 5,
    costUsd: null,
    error: null,
    createdAt: timestamp,
  });
  runtime.close();
  return { home, projectId: project.id, runId: run.id, artifactId: artifact.id };
}

async function cliJson(home: string, args: string[]): Promise<unknown> {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  await createCli().parseAsync(['node', 'qagent', '--home', home, '--json', ...args]);
  vi.mocked(process.stdout.write).mockRestore();
  const lines = chunks.join('').trim().split('\n');
  return JSON.parse(lines.at(-1) ?? 'null') as unknown;
}

async function mcpSession(home: string) {
  const runtime = createLocalRuntime({ home, weaveEnabled: false });
  const server = createQAgentMcpServer(runtime);
  const client = new Client({ name: 'qagent-interface-tests', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
      runtime.close();
    },
  };
}

function eventKinds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((event) =>
    event && typeof event === 'object' && 'kind' in event ? [String(event.kind)] : []
  );
}
