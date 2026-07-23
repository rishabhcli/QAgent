import type { CredentialStatus, DesktopPreferences, WorkerRequest } from '../ipc.js';
import type {
  ArtifactPreview,
  BootstrapSnapshot,
  DetectedProjectData,
  DoctorReport,
  RunDetailData,
} from './types.js';
import type { BrowserInstallation } from '@qagent/adapters';
import type { Project, Run } from '@qagent/contracts';

async function request<T>(request: WorkerRequest): Promise<T> {
  return (await window.qagent.request(request)) as T;
}

export const desktopApi = {
  bootstrap: () => request<BootstrapSnapshot>({ method: 'bootstrap', params: {} }),
  inspectProject: (path: string) =>
    request<DetectedProjectData>({ method: 'project.inspect', params: { path } }),
  addProject: (path: string, trusted: boolean) =>
    request<Project>({ method: 'project.add', params: { path, trusted } }),
  trustProject: (projectId: string, trusted: boolean) =>
    request<Project>({ method: 'project.trust', params: { projectId, trusted } }),
  configureProject: (params: {
    projectId: string;
    provider: 'openai' | 'anthropic' | 'google' | 'openai-compatible';
    model: string;
    baseUrl?: string;
    publish: 'github' | 'local';
    testExecutable?: string;
    testArgs: string[];
  }) => request<Project>({ method: 'project.configure', params }),
  startRun: (projectId: string) => request<Run>({ method: 'run.start', params: { projectId } }),
  cancelRun: (runId: string) => request<Run>({ method: 'run.cancel', params: { runId } }),
  runDetail: (runId: string) => request<RunDetailData>({ method: 'run.detail', params: { runId } }),
  doctor: (projectId?: string) =>
    request<DoctorReport>({ method: 'doctor', params: { projectId } }),
  installBrowser: () => request<BrowserInstallation>({ method: 'browser.install', params: {} }),
  readArtifact: (artifactId: string) =>
    request<ArtifactPreview>({ method: 'artifact.read', params: { artifactId } }),
  selectDirectory: (): Promise<string | null> => window.qagent.selectDirectory(),
  credentialStatuses: (): Promise<CredentialStatus[]> => window.qagent.credentialStatuses(),
  setCredential: (provider: string, value: string): Promise<CredentialStatus> =>
    window.qagent.setCredential(provider, value),
  getPreferences: (): Promise<DesktopPreferences> => window.qagent.getPreferences(),
  setPreferences: (preferences: DesktopPreferences): Promise<DesktopPreferences> =>
    window.qagent.setPreferences(preferences),
  openExternal: (url: string): Promise<void> => window.qagent.openExternal(url),
};
