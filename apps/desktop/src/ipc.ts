import { z } from 'zod';

export const WorkerRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('bootstrap'), params: z.object({}) }),
  z.object({ method: z.literal('project.inspect'), params: z.object({ path: z.string() }) }),
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
      publish: z.enum(['github', 'local']),
      testExecutable: z.string().min(1).optional(),
      testArgs: z.array(z.string()).default([]),
    }),
  }),
  z.object({ method: z.literal('run.start'), params: z.object({ projectId: z.uuid() }) }),
  z.object({ method: z.literal('run.cancel'), params: z.object({ runId: z.uuid() }) }),
  z.object({ method: z.literal('run.detail'), params: z.object({ runId: z.uuid() }) }),
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

export interface DesktopPreferences {
  weaveDisclosureAccepted: boolean;
  weaveEnabled: boolean;
}

export interface CredentialStatus {
  provider: string;
  configured: boolean;
  storage: 'encrypted' | 'session-only' | 'unavailable';
}
