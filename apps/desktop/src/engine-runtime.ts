import { join } from 'node:path';
import {
  buildInitialConfig,
  detectProject,
  installManagedBrowser,
  localIntegrationStatus,
  redactForTelemetry,
  runDoctor,
  writeProjectConfig,
} from '@qagent/adapters';
import type { Integration } from '@qagent/contracts';
import { createLocalRuntime, type RunHandle } from '@qagent/core';
import { WorkerRequestSchema, type WorkerEnvelope, type WorkerResponse } from './ipc.js';

interface WorkerParentPort {
  postMessage(message: unknown): void;
}

export interface WorkerShutdownResult {
  drained: boolean;
  activeRunIds: string[];
}

export interface WorkerRuntimeController {
  recoveredRunIds: string[];
  dispatch(envelope: WorkerEnvelope): Promise<void>;
  shutdown(options?: { graceMs?: number }): Promise<WorkerShutdownResult>;
}

interface ShutdownCapableEngine {
  shutdown?(options: {
    reason: 'runtime_shutdown';
    graceMs: number;
  }): Promise<{ drained: boolean; interruptedRunIds: string[] }>;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

export async function createWorkerDispatcher(
  parentPort: WorkerParentPort,
  options: { home?: string; shutdownGraceMs?: number } = {}
): Promise<WorkerRuntimeController> {
  const runtime = createLocalRuntime({ home: options.home ?? process.env.QAGENT_HOME });
  const handles = new Map<string, RunHandle>();
  const observers = new Map<string, Promise<void>>();
  const dispatches = new Set<Promise<void>>();
  let acceptingRequests = true;
  let closed = false;

  function observe(handle: RunHandle): void {
    if (handles.has(handle.id)) return;
    handles.set(handle.id, handle);
    const observer = (async () => {
      try {
        try {
          for await (const event of handle.events()) {
            safePost({ type: 'run.event', data: event });
          }
        } catch (error) {
          reportObserverError(handle.id, 'events', error);
        }
        try {
          const run = await handle.result();
          safePost({
            type: isTerminalRunStatus(run.status) ? 'run.completed' : 'run.updated',
            data: run,
          });
        } catch (error) {
          reportObserverError(handle.id, 'result', error);
        }
      } finally {
        handles.delete(handle.id);
      }
    })().finally(() => {
      if (observers.get(handle.id) === observer) observers.delete(handle.id);
    });
    observers.set(handle.id, observer);
  }

  function safePost(message: unknown): boolean {
    try {
      parentPort.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  function reportObserverError(runId: string, phase: 'events' | 'result', error: unknown): void {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = String(redactForTelemetry(rawMessage));
    safePost({
      type: 'worker.observer-error',
      data: { runId, phase, message },
    });
  }

  function closeRuntime(): void {
    if (closed) return;
    closed = true;
    try {
      runtime.close();
    } catch {
      // The process may already be tearing down after an external termination.
    }
  }

  const exitHandler = (): void => closeRuntime();
  process.once('exit', exitHandler);

  let recovered: RunHandle[];
  try {
    recovered = await runtime.engine.resumeInterruptedRuns();
    recovered.forEach(observe);
  } catch (error) {
    process.removeListener('exit', exitHandler);
    closeRuntime();
    throw error;
  }

  async function handleEnvelope(envelope: WorkerEnvelope): Promise<void> {
    const response: WorkerResponse = { id: envelope.id, ok: false };
    try {
      if (!acceptingRequests) throw new Error('QAgent engine worker is shutting down');
      const request = WorkerRequestSchema.parse(envelope.request);
      response.data = await dispatchRequest(request);
      response.ok = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.error = String(redactForTelemetry(message));
    }
    safePost(response);
  }

  function dispatch(envelope: WorkerEnvelope): Promise<void> {
    const task = handleEnvelope(envelope);
    dispatches.add(task);
    void task.finally(() => dispatches.delete(task));
    return task;
  }

  async function dispatchRequest(
    request: ReturnType<typeof WorkerRequestSchema.parse>
  ): Promise<unknown> {
    switch (request.method) {
      case 'bootstrap': {
        for (const integration of localIntegrationStatus()) {
          runtime.storage.upsertIntegration(
            mergeLocalIntegrationState(
              runtime.storage.getIntegration(integration.provider),
              integration
            )
          );
        }
        const projects = runtime.engine.listProjects();
        return {
          projects: envelope(projects),
          runs: envelope(runtime.engine.listRuns()),
          tests: envelope(projects.flatMap((project) => runtime.storage.listTestCases(project.id))),
          integrations: envelope(runtime.storage.listIntegrations()),
        };
      }
      case 'project.inspect':
        return detectProject(request.params.path, {
          configPath: request.params.configPath,
          tolerateInvalidConfig: true,
        });
      case 'project.add':
        return runtime.engine.addProject(request.params.path, request.params.trusted);
      case 'project.trust':
        return runtime.engine.trustProject(request.params.projectId, request.params.trusted);
      case 'project.configure': {
        const project = runtime.storage.getProject(request.params.projectId);
        if (!project?.trusted) throw new Error('Trust the project before writing .qagent.yml');
        const detected = await detectProject(project.path, {
          configPath: project.configPath,
          tolerateInvalidConfig: true,
        });
        if (request.params.testExecutable) {
          const command = {
            executable: request.params.testExecutable,
            args: request.params.testArgs,
            cwd: '.',
            env: {},
            timeoutMs: 300_000,
          };
          detected.suggestedTestCommands = [command];
          detected.suggestedVerifyCommands = [command];
        }
        const config =
          detected.config ??
          buildInitialConfig(detected, {
            provider: request.params.provider,
            model: request.params.model,
            baseUrl: request.params.baseUrl,
          });
        config.model = {
          provider: request.params.provider,
          model: request.params.model,
          baseUrl: request.params.baseUrl,
        };
        config.browser.provider = request.params.browserProvider;
        config.publish.provider = request.params.publish;
        config.telemetry.weave.enabled = request.params.weaveEnabled;
        const configPath = await writeProjectConfig(project.path, config, {
          force: true,
          destinationPath: join(runtime.home, 'projects', `${project.id}.qagent.yml`),
        });
        return runtime.storage.setProjectConfigPath(project.id, configPath);
      }
      case 'run.start': {
        const handle = await runtime.engine.startRun({
          projectId: request.params.projectId,
          requestedBy: 'desktop',
        });
        observe(handle);
        return runtime.engine.waitForRunLaunch(handle.id);
      }
      case 'run.action': {
        const execution = await runtime.engine.executeRunAction(request.params);
        if (execution.handle) observe(execution.handle);
        return execution.result;
      }
      case 'run.cancel':
        await runtime.engine.cancelRun(request.params.runId, 'Cancellation requested from desktop');
        return runtime.engine.getRun(request.params.runId);
      case 'run.detail':
        return runtime.engine.getRunDetail(request.params.runId);
      case 'integration.verify':
        return runtime.engine.verifyIntegration(request.params);
      case 'doctor': {
        const project = request.params.projectId
          ? runtime.storage.getProject(request.params.projectId)
          : null;
        const detected = project
          ? await detectProject(project.path, {
              configPath: project.configPath,
              tolerateInvalidConfig: true,
            })
          : null;
        return runDoctor({
          projectPath: project?.path,
          projectConfigPath: project?.configPath,
          qagentHome: runtime.home,
          config: detected?.config ?? undefined,
        });
      }
      case 'browser.install':
        return installManagedBrowser(
          join(runtime.home, 'browsers'),
          (downloadedBytes, totalBytes) => {
            safePost({
              type: 'browser.progress',
              data: { downloadedBytes, totalBytes },
            });
          }
        );
      case 'artifact.read': {
        const artifact = runtime.storage.getArtifact(request.params.artifactId);
        if (!artifact) throw new Error('Artifact was not found');
        if (artifact.bytes > 5 * 1024 * 1024) {
          throw new Error('Artifact exceeds the desktop preview limit');
        }
        const bytes = await runtime.artifacts.read(artifact);
        return {
          mimeType: artifact.mimeType,
          encoding: artifact.mimeType.startsWith('image/') ? 'base64' : 'utf8',
          data: artifact.mimeType.startsWith('image/')
            ? bytes.toString('base64')
            : bytes.toString('utf8'),
        };
      }
    }
  }

  async function shutdown(
    shutdownOptions: { graceMs?: number } = {}
  ): Promise<WorkerShutdownResult> {
    acceptingRequests = false;
    const graceMs = Math.max(
      0,
      shutdownOptions.graceMs ?? options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS
    );
    const engine = runtime.engine as typeof runtime.engine & ShutdownCapableEngine;
    const startedAt = Date.now();
    let engineDrained = true;

    if (engine.shutdown) {
      engineDrained = (await engine.shutdown({ reason: 'runtime_shutdown', graceMs })).drained;
    }

    const remainingMs = Math.max(0, graceMs - (Date.now() - startedAt));
    const pendingOperations = [...observers.values(), ...dispatches];
    const operationsDrained =
      pendingOperations.length === 0 ||
      (await settlesWithin(Promise.allSettled(pendingOperations), remainingMs));
    const drained = engineDrained && operationsDrained;

    if (drained) {
      process.removeListener('exit', exitHandler);
      closeRuntime();
    }
    return { drained, activeRunIds: [...handles.keys()] };
  }

  return {
    recoveredRunIds: recovered.map((handle) => handle.id),
    dispatch,
    shutdown,
  };
}

function isTerminalRunStatus(status: string): boolean {
  return ['succeeded', 'failed', 'cancelled', 'policy_blocked'].includes(status);
}

function mergeLocalIntegrationState(existing: Integration | null, local: Integration): Integration {
  const missingRequirement = local.requirements?.some(
    (requirement) => requirement.state === 'missing'
  );
  if (!existing || missingRequirement) return local;
  if (
    existing.status === 'healthy' ||
    existing.status === 'end-to-end-verified' ||
    existing.status === 'error'
  ) {
    const verifiedRequirements = new Map(
      existing.requirements?.map((requirement) => [requirement.id, requirement.state]) ?? []
    );
    return {
      ...existing,
      requirements: local.requirements?.map((requirement) => ({
        ...requirement,
        state:
          verifiedRequirements.get(requirement.id) === 'verified'
            ? ('verified' as const)
            : requirement.state,
      })),
    };
  }
  return local;
}

function envelope<T>(data: T) {
  return {
    availability:
      Array.isArray(data) && data.length === 0 ? ('empty' as const) : ('ready' as const),
    data,
    provenance: { source: 'local' as const, capturedAt: new Date().toISOString() },
  };
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
