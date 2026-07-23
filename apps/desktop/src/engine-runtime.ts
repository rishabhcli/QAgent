import { join } from 'node:path';
import {
  buildInitialConfig,
  detectProject,
  installManagedBrowser,
  localIntegrationStatus,
  runDoctor,
  writeProjectConfig,
} from '@qagent/adapters';
import { createLocalRuntime, type RunHandle } from '@qagent/core';
import { WorkerRequestSchema, type WorkerEnvelope, type WorkerResponse } from './ipc.js';

interface WorkerParentPort {
  postMessage(message: unknown): void;
}

export function createWorkerDispatcher(
  parentPort: WorkerParentPort
): (envelope: WorkerEnvelope) => Promise<void> {
  const runtime = createLocalRuntime({ home: process.env.QAGENT_HOME });
  const handles = new Map<string, RunHandle>();

  function observe(handle: RunHandle): void {
    handles.set(handle.id, handle);
    void (async () => {
      try {
        for await (const event of handle.events()) {
          parentPort.postMessage({ type: 'run.event', data: event });
        }
        const run = await handle.result();
        parentPort.postMessage({ type: 'run.completed', data: run });
      } finally {
        handles.delete(handle.id);
      }
    })();
  }

  void runtime.engine.resumeInterruptedRuns().then((recovered) => recovered.forEach(observe));
  process.on('exit', () => runtime.close());

  async function handleEnvelope(envelope: WorkerEnvelope): Promise<void> {
    const response: WorkerResponse = { id: envelope.id, ok: false };
    try {
      const request = WorkerRequestSchema.parse(envelope.request);
      response.data = await dispatchRequest(request);
      response.ok = true;
    } catch (error) {
      response.error = error instanceof Error ? error.message : String(error);
    }
    parentPort.postMessage(response);
  }

  async function dispatchRequest(
    request: ReturnType<typeof WorkerRequestSchema.parse>
  ): Promise<unknown> {
    switch (request.method) {
      case 'bootstrap': {
        for (const integration of localIntegrationStatus()) {
          runtime.storage.upsertIntegration(integration);
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
        return detectProject(request.params.path);
      case 'project.add':
        return runtime.engine.addProject(request.params.path, request.params.trusted);
      case 'project.trust':
        return runtime.engine.trustProject(request.params.projectId, request.params.trusted);
      case 'project.configure': {
        const project = runtime.storage.getProject(request.params.projectId);
        if (!project?.trusted) throw new Error('Trust the project before writing .qagent.yml');
        const detected = await detectProject(project.path);
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
        const config = buildInitialConfig(detected, {
          provider: request.params.provider,
          model: request.params.model,
          baseUrl: request.params.baseUrl,
        });
        config.publish.provider = request.params.publish;
        const configPath = await writeProjectConfig(project.path, config, { force: true });
        return runtime.storage.setProjectConfigPath(project.id, configPath);
      }
      case 'run.start': {
        const handle = await runtime.engine.startRun({
          projectId: request.params.projectId,
          requestedBy: 'desktop',
        });
        observe(handle);
        return runtime.engine.getRun(handle.id);
      }
      case 'run.cancel':
        await runtime.engine.cancelRun(request.params.runId, 'Cancellation requested from desktop');
        return runtime.engine.getRun(request.params.runId);
      case 'run.detail': {
        const run = runtime.engine.getRun(request.params.runId);
        if (!run) throw new Error('Run was not found');
        return {
          run,
          events: runtime.engine.getRunEvents(run.id),
          artifacts: runtime.storage.listArtifacts(run.id),
          diagnosis: runtime.storage.getDiagnosis(run.id),
          patch: runtime.storage.getPatch(run.id),
          verification: runtime.storage.getVerification(run.id),
          providerCalls: runtime.storage.listProviderCalls(run.id),
        };
      }
      case 'doctor': {
        const project = request.params.projectId
          ? runtime.storage.getProject(request.params.projectId)
          : null;
        const detected = project ? await detectProject(project.path) : null;
        return runDoctor({
          projectPath: project?.path,
          qagentHome: runtime.home,
          config: detected?.config ?? undefined,
        });
      }
      case 'browser.install':
        return installManagedBrowser(
          join(runtime.home, 'browsers'),
          (downloadedBytes, totalBytes) => {
            parentPort.postMessage({
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

  return handleEnvelope;
}

function envelope<T>(data: T) {
  return {
    availability:
      Array.isArray(data) && data.length === 0 ? ('empty' as const) : ('ready' as const),
    data,
    provenance: { source: 'local' as const, capturedAt: new Date().toISOString() },
  };
}
