import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCli } from '@qagent/cli';
import {
  RunActionResultSchema,
  RunSchema,
  type InterventionResolution,
  type Run,
  type RunAttentionReason,
  type RunIntervention,
} from '@qagent/contracts';
import { createLocalRuntime } from '@qagent/core';
import { createQAgentMcpServer } from '@qagent/mcp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { temporaryDirectory } from '../helpers.js';

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('accepted CLI and MCP action parity', () => {
  it('preserves durable identities, outcomes, and action events for every supported continuation', async () => {
    const cliHome = await temporaryDirectory('qagent-cli-actions-');
    const mcpHome = await temporaryDirectory('qagent-mcp-actions-');
    const cliRepository = await temporaryDirectory('qagent-cli-project-');
    const mcpRepository = await temporaryDirectory('qagent-mcp-project-');
    const cliRuns = seedActionRuns(cliHome, cliRepository);
    const mcpRuns = seedActionRuns(mcpHome, mcpRepository);
    const session = await mcpSession(mcpHome);

    try {
      for (const scenario of [
        {
          action: 'retry' as const,
          cliRun: cliRuns.retry,
          mcpRun: mcpRuns.retry,
          cliArgs: (run: Run) => ['run', 'retry', run.id],
          mcpTool: 'run_retry',
          mcpArgs: (run: Run) => ({ runId: run.id }),
          expectedEvent: 'run.retrying',
          createsLinkedRun: true,
        },
        {
          action: 'resume' as const,
          cliRun: cliRuns.resume,
          mcpRun: mcpRuns.resume,
          cliArgs: (run: Run) => ['run', 'resume', run.id],
          mcpTool: 'run_resume',
          mcpArgs: (run: Run) => ({ runId: run.id }),
          expectedEvent: 'run.resumed',
          createsLinkedRun: false,
        },
        {
          action: 'reconnect' as const,
          cliRun: cliRuns.reconnect,
          mcpRun: mcpRuns.reconnect,
          cliArgs: (run: Run) => ['run', 'reconnect', run.id, '--after-sequence', '0'],
          mcpTool: 'run_reconnect',
          mcpArgs: (run: Run) => ({ runId: run.id, afterSequence: 0 }),
          expectedEvent: 'run.reconnected',
          createsLinkedRun: false,
        },
        {
          action: 'resolve_intervention' as const,
          cliRun: cliRuns.resolve,
          mcpRun: mcpRuns.resolve,
          cliArgs: (run: Run) => [
            'run',
            'resolve-intervention',
            run.id,
            '--intervention',
            run.intervention!.id,
            '--resolution',
            'provider_reconfigured',
            '--note',
            'Provider configuration was corrected',
          ],
          mcpTool: 'run_resolve_intervention',
          mcpArgs: (run: Run) => ({
            runId: run.id,
            interventionId: run.intervention!.id,
            resolution: 'provider_reconfigured',
            note: 'Provider configuration was corrected',
            evidenceArtifactIds: [],
          }),
          expectedEvent: 'run.retrying',
          createsLinkedRun: true,
        },
      ]) {
        const cliLines = await cliJsonLines(cliHome, scenario.cliArgs(scenario.cliRun));
        const cliAction = cliLines
          .map((line) => RunActionResultSchema.safeParse(line))
          .find((candidate) => candidate.success)?.data;
        expect(cliAction).toBeDefined();

        const mcpResult = await session.client.callTool({
          name: scenario.mcpTool,
          arguments: scenario.mcpArgs(scenario.mcpRun),
        });
        expect(mcpResult.isError).not.toBe(true);
        const mcpAction = RunActionResultSchema.parse(mcpResult.structuredContent?.action);

        expect(cliAction).toMatchObject({
          action: scenario.action,
          accepted: true,
          requestedRunId: scenario.cliRun.id,
          reason: null,
        });
        expect(mcpAction).toMatchObject({
          action: scenario.action,
          accepted: true,
          requestedRunId: scenario.mcpRun.id,
          reason: null,
        });
        expect(cliAction!.runId === cliAction!.requestedRunId).toBe(
          mcpAction.runId === mcpAction.requestedRunId
        );
        expect(cliAction!.runId === cliAction!.requestedRunId).toBe(!scenario.createsLinkedRun);

        const cliOutcome = await durableRun(cliHome, cliAction!.runId);
        const mcpOutcome = await waitForMcpRun(session.client, mcpAction.runId);
        expect([cliOutcome.status, cliOutcome.failureCode, cliOutcome.availableActions]).toEqual([
          mcpOutcome.status,
          mcpOutcome.failureCode,
          mcpOutcome.availableActions,
        ]);
        expect(['waiting_for_intervention', 'failed', 'policy_blocked']).toContain(
          cliOutcome.status
        );
        expect(cliOutcome.failureCode).not.toBeNull();
        expect(cliOutcome.availableActions.length).toBeGreaterThan(0);
        if (scenario.createsLinkedRun) {
          expect(cliOutcome).toMatchObject({
            status: 'waiting_for_intervention',
            failureCode: 'configuration_invalid',
            availableActions: ['resolve_intervention', 'cancel'],
            intervention: {
              reason: 'configuration_invalid',
              requiredAction: {
                type: 'application',
                action: 'configure_project',
              },
            },
          });
          expect(mcpOutcome).toMatchObject({
            status: 'waiting_for_intervention',
            failureCode: 'configuration_invalid',
            availableActions: ['resolve_intervention', 'cancel'],
            intervention: {
              reason: 'configuration_invalid',
              requiredAction: {
                type: 'application',
                action: 'configure_project',
              },
            },
          });
        }

        const cliEvidence = durableActionEvidence(cliHome, scenario.cliRun.id, cliAction!.runId);
        const mcpEvidence = durableActionEvidence(
          mcpHome,
          scenario.mcpRun.id,
          mcpAction.runId,
          session.runtime
        );
        expect(cliEvidence.kinds).toContain(scenario.expectedEvent);
        expect(mcpEvidence.kinds).toContain(scenario.expectedEvent);
        if (scenario.action === 'resolve_intervention') {
          expect(cliEvidence.kinds).toContain('intervention.resolved');
          expect(mcpEvidence.kinds).toContain('intervention.resolved');
        }
        for (const eventId of cliAction!.eventIds) {
          expect(cliEvidence.ids).toContain(eventId);
        }
        for (const eventId of mcpAction.eventIds) {
          expect(mcpEvidence.ids).toContain(eventId);
        }

        if (scenario.createsLinkedRun) {
          if (scenario.action === 'resolve_intervention') {
            expect(cliEvidence.requestedArtifactIds.length).toBeGreaterThan(0);
            expect(mcpEvidence.requestedArtifactIds.length).toBeGreaterThan(0);
          }
          expect(cliEvidence.retrying).toEqual([{ runId: cliAction!.runId, artifactIds: [] }]);
          expect(mcpEvidence.retrying).toEqual([{ runId: mcpAction.runId, artifactIds: [] }]);
          expect(cliOutcome).toMatchObject({
            retryOfRunId: scenario.cliRun.id,
            attempt: 2,
          });
          expect(mcpOutcome).toMatchObject({
            retryOfRunId: scenario.mcpRun.id,
            attempt: 2,
          });
        } else {
          expect(cliOutcome.id).toBe(scenario.cliRun.id);
          expect(mcpOutcome.id).toBe(scenario.mcpRun.id);
        }
        await delay(50);
      }
    } finally {
      await session.close();
    }
  });
});

function seedActionRuns(home: string, repository: string) {
  const runtime = createLocalRuntime({ home, weaveEnabled: false });
  try {
    const project = runtime.storage.createProject({
      name: 'Interface actions',
      path: repository,
      trusted: true,
    });
    const retry = runtime.storage.createRun({
      projectId: project.id,
      requestedBy: 'desktop',
    });
    runtime.storage.updateRun(retry.id, {
      status: 'failed',
      stage: 'complete',
      failureCode: 'unexpected_failure',
      error: 'Seeded retryable failure',
      availableActions: ['retry'],
      completedAt: new Date().toISOString(),
    });

    const resume = runtime.storage.createRun({
      projectId: project.id,
      requestedBy: 'desktop',
    });
    runtime.storage.updateRun(resume.id, {
      status: 'interrupted',
      failureCode: 'interrupted_recovery',
      error: 'Seeded interrupted runtime',
      availableActions: ['resume', 'cancel'],
    });

    const reconnect = interventionRun(
      runtime.storage,
      project.id,
      'merge_waiting',
      ['github_requirements_recheck_requested'],
      true
    );
    const resolve = interventionRun(runtime.storage, project.id, 'provider_outage', [
      'provider_reconfigured',
    ]);
    return { retry: runtime.storage.getRun(retry.id)!, resume, reconnect, resolve };
  } finally {
    runtime.close();
  }
}

async function cliJsonLines(home: string, args: string[]): Promise<unknown[]> {
  const chunks: string[] = [];
  const output = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await createCli().parseAsync(['node', 'qagent', '--home', home, '--json', ...args]);
  } finally {
    output.mockRestore();
    process.exitCode = undefined;
  }
  return chunks
    .join('')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

async function durableRun(home: string, runId: string): Promise<Run> {
  const runtime = createLocalRuntime({ home, weaveEnabled: false });
  try {
    return RunSchema.parse(runtime.storage.getRun(runId));
  } finally {
    runtime.close();
  }
}

function durableActionEvidence(
  home: string,
  requestedRunId: string,
  resultRunId: string,
  existingRuntime?: ReturnType<typeof createLocalRuntime>
) {
  const runtime = existingRuntime ?? createLocalRuntime({ home, weaveEnabled: false });
  try {
    const events = [
      ...runtime.storage.listEvents(requestedRunId),
      ...(resultRunId === requestedRunId ? [] : runtime.storage.listEvents(resultRunId)),
    ];
    return {
      ids: events.map((event) => event.id),
      kinds: events.map((event) => event.kind),
      requestedArtifactIds: runtime.storage
        .listArtifacts(requestedRunId)
        .map((artifact) => artifact.id),
      retrying: events
        .filter((event) => event.kind === 'run.retrying')
        .map((event) => ({ runId: event.runId, artifactIds: event.artifactIds })),
    };
  } finally {
    if (!existingRuntime) runtime.close();
  }
}

async function mcpSession(home: string) {
  const runtime = createLocalRuntime({ home, weaveEnabled: false });
  const server = createQAgentMcpServer(runtime);
  const client = new Client({ name: 'qagent-action-parity', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    runtime,
    close: async () => {
      await client.close();
      await server.close();
      await runtime.engine.shutdown({ reason: 'Interface parity complete', graceMs: 1_000 });
      runtime.close();
    },
  };
}

async function waitForMcpRun(client: Client, runId: string): Promise<Run> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.callTool({ name: 'run_get', arguments: { runId } });
    const run = RunSchema.parse(result.structuredContent?.run);
    if (!['queued', 'running', 'interrupted'].includes(run.status)) return run;
    await delay(25);
  }
  throw new Error(`Run ${runId} did not reach an actionable durable state`);
}

function interventionRun(
  storage: ReturnType<typeof createLocalRuntime>['storage'],
  projectId: string,
  reason: RunAttentionReason,
  resolutionOptions: InterventionResolution[],
  reconnect = false
): Run {
  const run = storage.createRun({ projectId, requestedBy: 'desktop' });
  const intervention: RunIntervention = {
    id: randomUUID(),
    runId: run.id,
    reason,
    summary: `Seeded ${reason}`,
    requiredAction: {
      id: `resolve-${reason}`,
      type: 'application',
      label: 'Resolve condition',
      description: 'Correct the durable condition and continue.',
      action: reason === 'merge_waiting' ? 'review_pull_request' : 'configure_provider',
    },
    resolutionOptions,
    evidenceArtifactIds: [],
    requestedAt: new Date().toISOString(),
    resolvedAt: null,
    resolution: null,
  };
  return storage.updateRun(run.id, {
    status: 'waiting_for_intervention',
    failureCode: reason,
    error: intervention.summary,
    availableActions: reconnect
      ? ['resolve_intervention', 'reconnect', 'cancel']
      : ['resolve_intervention', 'cancel'],
    intervention,
  });
}
