import type { WorkerRequest } from '../ipc.js';
import type { BrowserInstallation } from '@qagent/adapters';
import type {
  ArtifactPreview,
  BootstrapSnapshot,
  CredentialStatus,
  DesktopPreferences,
  DoctorReport,
  IntegrationVerifyRequest,
  IntegrationVerifyResult,
  Project,
  ProjectInspection,
  Run,
  RunActionRequest,
  RunActionResult,
  RunDetail,
  RunLaunch,
} from '@qagent/contracts';

async function request<T>(request: WorkerRequest): Promise<T> {
  return (await window.qagent.request(request)) as T;
}

export const desktopApi = {
  bootstrap: () => request<BootstrapSnapshot>({ method: 'bootstrap', params: {} }),
  inspectProject: (path: string, configPath?: string | null) =>
    request<ProjectInspection>({ method: 'project.inspect', params: { path, configPath } }),
  addProject: (path: string, trusted: boolean) =>
    request<Project>({ method: 'project.add', params: { path, trusted } }),
  trustProject: (projectId: string, trusted: boolean) =>
    request<Project>({ method: 'project.trust', params: { projectId, trusted } }),
  configureProject: (params: {
    projectId: string;
    provider: 'openai' | 'anthropic' | 'google' | 'openai-compatible';
    model: string;
    baseUrl?: string;
    browserProvider: 'local' | 'browserbase';
    publish: 'github' | 'local';
    weaveEnabled: boolean;
    testExecutable?: string;
    testArgs: string[];
  }) => request<Project>({ method: 'project.configure', params }),
  startRun: (projectId: string) =>
    request<RunLaunch>({ method: 'run.start', params: { projectId } }),
  runAction: (params: RunActionRequest) =>
    request<RunActionResult>({ method: 'run.action', params }),
  cancelRun: (runId: string) => request<Run>({ method: 'run.cancel', params: { runId } }),
  runDetail: (runId: string) => request<RunDetail>({ method: 'run.detail', params: { runId } }),
  verifyIntegration: (params: IntegrationVerifyRequest) =>
    request<IntegrationVerifyResult>({ method: 'integration.verify', params }),
  doctor: (projectId?: string) =>
    request<DoctorReport>({ method: 'doctor', params: { projectId } }),
  installBrowser: () => request<BrowserInstallation>({ method: 'browser.install', params: {} }),
  readArtifact: (artifactId: string) =>
    request<ArtifactPreview>({ method: 'artifact.read', params: { artifactId } }),
  selectDirectory: (): Promise<string | null> => window.qagent.selectDirectory(),
  credentialStatuses: (): Promise<CredentialStatus[]> => window.qagent.credentialStatuses(),
  setCredential: (
    provider: string,
    value: string,
    options: { deferRestart?: boolean } = {}
  ): Promise<CredentialStatus> => window.qagent.setCredential(provider, value, options),
  getPreferences: (): Promise<DesktopPreferences> => window.qagent.getPreferences(),
  setPreferences: (preferences: DesktopPreferences): Promise<DesktopPreferences> =>
    window.qagent.setPreferences(preferences),
  openExternal: (url: string): Promise<void> => window.qagent.openExternal(url),
};
