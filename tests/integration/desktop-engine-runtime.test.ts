import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { detectProject, writeProjectConfig } from '@qagent/adapters';
import { QAgentStorage } from '@qagent/storage';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkerDispatcher,
  type WorkerRuntimeController,
} from '../../apps/desktop/src/engine-runtime.js';
import type { WorkerEnvelope } from '../../apps/desktop/src/ipc.js';
import { git, temporaryDirectory, temporaryFixtureRepository } from '../helpers.js';

const controllers = new Set<WorkerRuntimeController>();

afterEach(async () => {
  await Promise.allSettled(
    [...controllers].map((controller) => controller.shutdown({ graceMs: 10_000 }))
  );
  controllers.clear();
});

describe.sequential('desktop engine runtime recovery', () => {
  it('recovers the same durable run and persists provider intervention at the dispatcher boundary', async () => {
    const repository = await temporaryFixtureRepository();
    const modelServer = await startInvalidModelServer();
    const detected = await detectProject(repository);
    if (!detected.config) throw new Error('Fixture config was not detected');
    detected.config.test.browserFlows = [];
    detected.config.model = {
      provider: 'openai-compatible',
      model: 'invalid-structured-output',
      baseUrl: modelServer.baseUrl,
    };
    await writeProjectConfig(repository, detected.config, { force: true });
    await git(repository, ['add', '.qagent.yml']);
    await git(repository, [
      '-c',
      'user.name=QAgent tests',
      '-c',
      'user.email=tests@qagent.local',
      'commit',
      '-m',
      'configure desktop runtime model',
    ]);
    const home = await temporaryDirectory('qagent-desktop-runtime-');
    const storage = new QAgentStorage(join(home, 'qagent.sqlite'));
    const project = storage.createProject({
      name: 'Desktop recovery fixture',
      path: repository,
      trusted: true,
      configPath: join(repository, '.qagent.yml'),
    });
    const interrupted = storage.createRun({
      projectId: project.id,
      requestedBy: 'desktop',
    });
    storage.updateRun(interrupted.id, { status: 'running', stage: 'preflight' });
    storage.close();

    const messages: unknown[] = [];
    let rejectedOneLiveEvent = false;

    try {
      const controller = await createWorkerDispatcher(
        {
          postMessage(message) {
            if (!rejectedOneLiveEvent && isWorkerMessage(message) && message.type === 'run.event') {
              rejectedOneLiveEvent = true;
              throw new Error('simulated parent delivery interruption');
            }
            messages.push(message);
          },
        },
        { home, shutdownGraceMs: 20_000 }
      );
      controllers.add(controller);

      expect(controller.recoveredRunIds).toEqual([interrupted.id]);
      try {
        await waitFor(
          () =>
            messages.some(
              (message) =>
                isWorkerMessage(message) &&
                message.type === 'run.updated' &&
                (message.data as { id?: unknown; status?: unknown }).id === interrupted.id &&
                (message.data as { status?: unknown }).status === 'waiting_for_intervention'
            ),
          20_000
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(messages, null, 2)}`,
          { cause: error }
        );
      }
      const shutdown = await controller.shutdown({ graceMs: 20_000 });
      controllers.delete(controller);
      expect(shutdown).toEqual({ drained: true, activeRunIds: [] });
    } finally {
      await modelServer.close();
    }

    const reopened = new QAgentStorage(join(home, 'qagent.sqlite'));
    const result = reopened.getRun(interrupted.id);
    const events = reopened.listEvents(interrupted.id);
    reopened.close();

    expect(rejectedOneLiveEvent).toBe(true);
    expect(result?.id).toBe(interrupted.id);
    expect(result).toMatchObject({
      status: 'waiting_for_intervention',
      failureCode: 'invalid_model_output',
      availableActions: ['resolve_intervention', 'cancel'],
      intervention: {
        reason: 'invalid_model_output',
        resolutionOptions: ['provider_reconfigured'],
        requiredAction: {
          type: 'application',
          action: 'configure_provider',
        },
      },
    });
    expect(
      events.some((event) => event.kind === 'command.started'),
      JSON.stringify({ result, events }, null, 2)
    ).toBe(true);
    expect(
      events.filter((event) => event.kind.startsWith('run.')).map((event) => event.kind)
    ).toEqual(expect.arrayContaining(['run.interrupted', 'run.resumed']));
    expect(
      events.filter((event) =>
        ['run.completed', 'run.failed', 'run.cancelled', 'run.policy_blocked'].includes(event.kind)
      ),
      JSON.stringify({ result, events }, null, 2)
    ).toHaveLength(0);
    expect(events.filter((event) => event.kind === 'intervention.required')).toHaveLength(1);
    expect(
      messages.filter(
        (message) =>
          isWorkerMessage(message) &&
          message.type === 'run.updated' &&
          (message.data as { id?: unknown }).id === interrupted.id
      )
    ).toHaveLength(1);
    expect(
      messages.filter(
        (message) =>
          isWorkerMessage(message) &&
          message.type === 'run.completed' &&
          (message.data as { id?: unknown }).id === interrupted.id
      )
    ).toHaveLength(0);
  }, 30_000);

  it('responds once to an invalid request and closes an idle runtime', async () => {
    const home = await temporaryDirectory('qagent-desktop-runtime-invalid-');
    const messages: unknown[] = [];
    const secretShapedMethod = 'sk-invalid-request-secret';
    const controller = await createWorkerDispatcher(
      { postMessage: (message) => messages.push(message) },
      { home }
    );
    controllers.add(controller);

    await controller.dispatch({
      id: 'invalid-request',
      request: { method: secretShapedMethod, params: {} },
    } as unknown as WorkerEnvelope);
    expect(messages).toEqual([
      expect.objectContaining({
        id: 'invalid-request',
        ok: false,
        error: expect.any(String),
      }),
    ]);
    expect(JSON.stringify(messages)).not.toContain(secretShapedMethod);

    expect(await controller.shutdown()).toEqual({ drained: true, activeRunIds: [] });
    controllers.delete(controller);
  });
});

function isWorkerMessage(value: unknown): value is { type: string; data: unknown } {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

async function startInvalidModelServer(): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl_invalid',
        object: 'chat.completion',
        created: 1,
        model: 'invalid-structured-output',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'definitely not JSON' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
