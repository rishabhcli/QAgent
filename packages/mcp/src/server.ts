import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { LocalRuntime, RunHandle } from '@qagent/core';
import { createLocalRuntime } from '@qagent/core';
import { z } from 'zod';

function jsonResult(name: string, value: unknown) {
  const structuredContent = { [name]: value };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function requireTrustedProject(runtime: LocalRuntime, projectId: string) {
  const project = runtime.storage.getProject(projectId);
  if (!project || !project.trusted) throw new Error('Trusted project was not found');
  return project;
}

function requireTrustedRun(runtime: LocalRuntime, runId: string) {
  const run = runtime.engine.getRun(runId);
  if (!run) throw new Error('Run was not found');
  requireTrustedProject(runtime, run.projectId);
  return run;
}

function runDetail(runtime: LocalRuntime, runId: string) {
  const run = requireTrustedRun(runtime, runId);
  return {
    run,
    events: runtime.engine.getRunEvents(runId),
    artifacts: runtime.storage.listArtifacts(runId),
    diagnosis: runtime.storage.getDiagnosis(runId),
    patch: runtime.storage.getPatch(runId),
    verification: runtime.storage.getVerification(runId),
    providerCalls: runtime.storage.listProviderCalls(runId),
  };
}

function resourceJson(uri: URL | string, value: unknown) {
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: 'application/json',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function variable(value: string | string[] | undefined, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a single identifier`);
  return value;
}

export function createQAgentMcpServer(runtime: LocalRuntime): McpServer {
  const server = new McpServer({
    name: 'qagent',
    version: '0.2.0-beta.1',
    websiteUrl: 'https://github.com/rishabhcli/QAgent',
  });
  const handles = new Map<string, RunHandle>();

  server.registerTool(
    'project_list',
    {
      title: 'List trusted QAgent projects',
      description: 'Lists only projects explicitly trusted in local QAgent state.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      jsonResult(
        'projects',
        runtime.engine.listProjects().filter((project) => project.trusted)
      )
  );

  server.registerTool(
    'project_get',
    {
      title: 'Get trusted QAgent project',
      description:
        'Gets one previously trusted project; arbitrary filesystem paths are not accepted.',
      inputSchema: { projectId: z.uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId }) => jsonResult('project', requireTrustedProject(runtime, projectId))
  );

  server.registerTool(
    'run_start',
    {
      title: 'Start QAgent run',
      description: 'Starts an asynchronous run for a previously trusted project.',
      inputSchema: { projectId: z.uuid() },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ projectId }) => {
      requireTrustedProject(runtime, projectId);
      const handle = await runtime.engine.startRun({ projectId, requestedBy: 'mcp' });
      handles.set(handle.id, handle);
      void handle.result().finally(() => handles.delete(handle.id));
      return jsonResult('run', runtime.engine.getRun(handle.id));
    }
  );

  server.registerTool(
    'run_list',
    {
      title: 'List QAgent runs',
      description: 'Lists durable runs, optionally filtered to a trusted project.',
      inputSchema: { projectId: z.uuid().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId }) => {
      if (projectId) requireTrustedProject(runtime, projectId);
      const trusted = new Set(
        runtime.engine
          .listProjects()
          .filter((project) => project.trusted)
          .map((project) => project.id)
      );
      return jsonResult(
        'runs',
        runtime.engine.listRuns(projectId).filter((run) => trusted.has(run.projectId))
      );
    }
  );

  server.registerTool(
    'run_get',
    {
      title: 'Get QAgent run',
      description: 'Gets a durable run belonging to a trusted project.',
      inputSchema: { runId: z.uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId }) => jsonResult('run', requireTrustedRun(runtime, runId))
  );

  server.registerTool(
    'run_detail',
    {
      title: 'Get complete QAgent run detail',
      description:
        'Returns the same durable events, artifacts, diagnosis, patch, verification, and provider provenance used by desktop and CLI.',
      inputSchema: { runId: z.uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId }) => jsonResult('detail', runDetail(runtime, runId))
  );

  server.registerTool(
    'run_cancel',
    {
      title: 'Cancel QAgent run',
      description: 'Durably requests cancellation of an active run.',
      inputSchema: { runId: z.uuid() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ runId }) => {
      requireTrustedRun(runtime, runId);
      await runtime.engine.cancelRun(runId, 'Cancellation requested through MCP');
      return jsonResult('run', runtime.engine.getRun(runId));
    }
  );

  server.registerTool(
    'run_events',
    {
      title: 'Read QAgent run events',
      description: 'Reads ordered, provenance-aware events after a sequence cursor.',
      inputSchema: { runId: z.uuid(), afterSequence: z.number().int().min(0).default(0) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId, afterSequence }) => {
      requireTrustedRun(runtime, runId);
      return jsonResult('events', runtime.engine.getRunEvents(runId, afterSequence));
    }
  );

  server.registerTool(
    'test_list',
    {
      title: 'List grounded test cases',
      description: 'Lists test definitions persisted from the trusted project configuration.',
      inputSchema: { projectId: z.uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId }) => {
      requireTrustedProject(runtime, projectId);
      return jsonResult('tests', runtime.storage.listTestCases(projectId));
    }
  );

  server.registerTool(
    'patch_get',
    {
      title: 'Get QAgent patch metadata',
      description: 'Gets persisted patch metadata for a run without reading unrelated files.',
      inputSchema: { runId: z.uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId }) => {
      requireTrustedRun(runtime, runId);
      return jsonResult('patch', runtime.storage.getPatch(runId));
    }
  );

  server.registerTool(
    'artifact_list',
    {
      title: 'List QAgent artifacts',
      description: 'Lists checksummed artifacts belonging to one trusted run.',
      inputSchema: { runId: z.uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId }) => {
      requireTrustedRun(runtime, runId);
      return jsonResult('artifacts', runtime.storage.listArtifacts(runId));
    }
  );

  server.registerTool(
    'artifact_read',
    {
      title: 'Read QAgent artifact',
      description: 'Reads a checksummed QAgent artifact by ID, capped at one MiB.',
      inputSchema: { artifactId: z.uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ artifactId }) => {
      const artifact = runtime.storage.getArtifact(artifactId);
      if (!artifact) throw new Error('Artifact was not found');
      requireTrustedRun(runtime, artifact.runId);
      if (artifact.bytes > 1024 * 1024) throw new Error('Artifact exceeds the MCP read limit');
      const bytes = await runtime.artifacts.read(artifact);
      if (artifact.mimeType.startsWith('image/')) {
        return {
          content: [
            { type: 'image' as const, data: bytes.toString('base64'), mimeType: artifact.mimeType },
          ],
        };
      }
      return {
        content: [{ type: 'text' as const, text: bytes.toString('utf8') }],
      };
    }
  );

  server.registerResource(
    'qagent-projects',
    'qagent://projects',
    {
      title: 'Trusted QAgent projects',
      description: 'Current local list of trusted project records.',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [
        {
          uri: 'qagent://projects',
          mimeType: 'application/json',
          text: JSON.stringify(
            runtime.engine.listProjects().filter((project) => project.trusted),
            null,
            2
          ),
        },
      ],
    })
  );

  const trustedRuns = () => {
    const projectIds = new Set(
      runtime.engine
        .listProjects()
        .filter((project) => project.trusted)
        .map((project) => project.id)
    );
    return runtime.engine.listRuns().filter((run) => projectIds.has(run.projectId));
  };

  server.registerResource(
    'qagent-project',
    new ResourceTemplate('qagent://projects/{projectId}', {
      list: async () => ({
        resources: runtime.engine
          .listProjects()
          .filter((project) => project.trusted)
          .map((project) => ({
            uri: `qagent://projects/${project.id}`,
            name: project.name,
            mimeType: 'application/json',
          })),
      }),
    }),
    {
      title: 'Trusted QAgent project',
      description: 'A single registered, trusted project record.',
      mimeType: 'application/json',
    },
    async (uri, variables) =>
      resourceJson(uri, requireTrustedProject(runtime, variable(variables.projectId, 'projectId')))
  );

  server.registerResource(
    'qagent-run',
    new ResourceTemplate('qagent://runs/{runId}', {
      list: async () => ({
        resources: trustedRuns().map((run) => ({
          uri: `qagent://runs/${run.id}`,
          name: `Run ${run.id.slice(0, 8)}`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'QAgent run detail',
      description: 'A complete durable run record from a trusted project.',
      mimeType: 'application/json',
    },
    async (uri, variables) =>
      resourceJson(uri, runDetail(runtime, variable(variables.runId, 'runId')))
  );

  server.registerResource(
    'qagent-run-events',
    new ResourceTemplate('qagent://runs/{runId}/events', {
      list: async () => ({
        resources: trustedRuns().map((run) => ({
          uri: `qagent://runs/${run.id}/events`,
          name: `Events for ${run.id.slice(0, 8)}`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Ordered QAgent run events',
      description: 'Schema-versioned, ordered events for a trusted run.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const runId = variable(variables.runId, 'runId');
      requireTrustedRun(runtime, runId);
      return resourceJson(uri, runtime.engine.getRunEvents(runId));
    }
  );

  server.registerResource(
    'qagent-run-patch',
    new ResourceTemplate('qagent://runs/{runId}/patch', {
      list: async () => ({
        resources: trustedRuns()
          .filter((run) => runtime.storage.getPatch(run.id))
          .map((run) => ({
            uri: `qagent://runs/${run.id}/patch`,
            name: `Patch for ${run.id.slice(0, 8)}`,
            mimeType: 'application/json',
          })),
      }),
    }),
    {
      title: 'QAgent patch metadata',
      description: 'Latest persisted patch metadata for a trusted run.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const runId = variable(variables.runId, 'runId');
      requireTrustedRun(runtime, runId);
      return resourceJson(uri, runtime.storage.getPatch(runId));
    }
  );

  server.registerResource(
    'qagent-artifact',
    new ResourceTemplate('qagent://artifacts/{artifactId}', {
      list: async () => ({
        resources: trustedRuns().flatMap((run) =>
          runtime.storage.listArtifacts(run.id).map((artifact) => ({
            uri: `qagent://artifacts/${artifact.id}`,
            name: artifact.name,
            description: `${artifact.kind}; sha256 ${artifact.sha256}`,
            mimeType: artifact.mimeType,
          }))
        ),
      }),
    }),
    {
      title: 'Checksummed QAgent artifact',
      description: 'Artifact content from a trusted run, integrity-checked before delivery.',
    },
    async (uri, variables) => {
      const artifactId = variable(variables.artifactId, 'artifactId');
      const artifact = runtime.storage.getArtifact(artifactId);
      if (!artifact) throw new Error('Artifact was not found');
      requireTrustedRun(runtime, artifact.runId);
      if (artifact.bytes > 1024 * 1024) throw new Error('Artifact exceeds the MCP read limit');
      const bytes = await runtime.artifacts.read(artifact);
      return {
        contents: [
          artifact.mimeType.startsWith('image/')
            ? { uri: uri.toString(), mimeType: artifact.mimeType, blob: bytes.toString('base64') }
            : { uri: uri.toString(), mimeType: artifact.mimeType, text: bytes.toString('utf8') },
        ],
      };
    }
  );

  return server;
}

export async function startMcpServer(runtime = createLocalRuntime()): Promise<void> {
  const server = createQAgentMcpServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
