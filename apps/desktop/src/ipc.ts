import { z } from 'zod';
import {
  ArtifactPreviewSchema,
  BootstrapSnapshotSchema,
  DoctorReportSchema,
  IntegrationVerifyRequestSchema,
  IntegrationVerifyResultSchema,
  ProjectInspectionSchema,
  ProjectSchema,
  RunActionRequestSchema,
  RunActionResultSchema,
  RunDetailSchema,
  RunEventSchema,
  RunLaunchSchema,
  RunSchema,
} from '@qagent/contracts';

export type { CredentialStatus, DesktopPreferences } from '@qagent/contracts';

export const WorkerRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('bootstrap'), params: z.object({}) }),
  z.object({
    method: z.literal('project.inspect'),
    params: z.object({ path: z.string(), configPath: z.string().nullable().optional() }),
  }),
  z.object({
    method: z.literal('project.add'),
    params: z.object({ path: z.string(), trusted: z.boolean() }),
  }),
  z.object({
    method: z.literal('project.trust'),
    params: z.object({ projectId: z.uuid(), trusted: z.boolean() }),
  }),
  z.object({
    method: z.literal('project.configure'),
    params: z.object({
      projectId: z.uuid(),
      provider: z.enum(['openai', 'anthropic', 'google', 'openai-compatible']),
      model: z.string().min(1),
      baseUrl: z.url().optional(),
      browserProvider: z.enum(['local', 'browserbase']),
      publish: z.enum(['github', 'local']),
      weaveEnabled: z.boolean(),
      testExecutable: z.string().min(1).optional(),
      testArgs: z.array(z.string()).default([]),
    }),
  }),
  z.object({ method: z.literal('run.start'), params: z.object({ projectId: z.uuid() }) }),
  z.object({ method: z.literal('run.action'), params: RunActionRequestSchema }),
  z.object({ method: z.literal('run.cancel'), params: z.object({ runId: z.uuid() }) }),
  z.object({ method: z.literal('run.detail'), params: z.object({ runId: z.uuid() }) }),
  z.object({ method: z.literal('integration.verify'), params: IntegrationVerifyRequestSchema }),
  z.object({ method: z.literal('doctor'), params: z.object({ projectId: z.uuid().optional() }) }),
  z.object({ method: z.literal('browser.install'), params: z.object({}) }),
  z.object({ method: z.literal('artifact.read'), params: z.object({ artifactId: z.uuid() }) }),
]);

export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;

export interface WorkerEnvelope {
  id: string;
  request: WorkerRequest;
}

export interface WorkerResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export const WorkerResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    id: z.uuid(),
    ok: z.literal(true),
    data: z.unknown(),
  }),
  z.object({
    id: z.uuid(),
    ok: z.literal(false),
    error: z.string().min(1).max(32_768),
  }),
]);

export const WorkerEventMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('worker.ready'),
    data: z.object({ recoveredRunIds: z.array(z.uuid()).max(10_000) }),
  }),
  z.object({
    type: z.literal('worker.failed'),
    data: z.object({
      message: z.string().min(1).max(32_768),
      recoveringRunIds: z.array(z.uuid()).max(10_000).optional(),
    }),
  }),
  z.object({
    type: z.literal('worker.observer-error'),
    data: z.object({
      runId: z.uuid(),
      phase: z.enum(['events', 'result']),
      message: z.string().min(1).max(32_768),
    }),
  }),
  z.object({ type: z.literal('run.event'), data: RunEventSchema }),
  z.object({ type: z.literal('run.completed'), data: RunSchema }),
  z.object({ type: z.literal('run.updated'), data: RunSchema }),
  z.object({
    type: z.literal('browser.progress'),
    data: z.object({
      downloadedBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
    }),
  }),
]);

const BrowserInstallationSchema = z.object({
  name: z.string().min(1),
  executablePath: z.string().min(1),
  source: z.enum(['system', 'managed', 'configured']),
});

const WorkerShutdownResultSchema = z.object({
  drained: z.boolean(),
  activeRunIds: z.array(z.uuid()).max(10_000),
});

export type WorkerEventMessage = z.infer<typeof WorkerEventMessageSchema>;

export function parseWorkerResponseData(method: string, data: unknown): unknown {
  switch (method) {
    case 'bootstrap':
      return BootstrapSnapshotSchema.parse(data);
    case 'project.inspect':
      return ProjectInspectionSchema.parse(data);
    case 'project.add':
    case 'project.trust':
    case 'project.configure':
      return ProjectSchema.parse(data);
    case 'run.start':
      return RunLaunchSchema.parse(data);
    case 'run.action':
      return RunActionResultSchema.parse(data);
    case 'run.cancel':
      return RunSchema.parse(data);
    case 'run.detail':
      return RunDetailSchema.parse(data);
    case 'integration.verify':
      return IntegrationVerifyResultSchema.parse(data);
    case 'doctor':
      return DoctorReportSchema.parse(data);
    case 'browser.install':
      return BrowserInstallationSchema.parse(data);
    case 'artifact.read':
      return ArtifactPreviewSchema.parse(data);
    case 'worker.shutdown':
      return WorkerShutdownResultSchema.parse(data);
    default:
      throw new Error(`Unsupported engine worker response method: ${method}`);
  }
}
