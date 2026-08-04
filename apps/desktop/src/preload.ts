import { contextBridge, ipcRenderer } from 'electron';
import type { CredentialStatus, DesktopPreferences, WorkerRequest } from './ipc.js';

const api = {
  request: (request: WorkerRequest): Promise<unknown> =>
    ipcRenderer.invoke('qagent:request', request),
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke('qagent:select-directory'),
  credentialStatuses: (): Promise<CredentialStatus[]> =>
    ipcRenderer.invoke('qagent:credentials-status'),
  setCredential: (
    provider: string,
    value: string,
    options: { deferRestart?: boolean } = {}
  ): Promise<CredentialStatus> =>
    ipcRenderer.invoke('qagent:credential-set', {
      provider,
      value,
      deferRestart: options.deferRestart ?? false,
    }),
  getPreferences: (): Promise<DesktopPreferences> => ipcRenderer.invoke('qagent:preferences-get'),
  setPreferences: (preferences: DesktopPreferences): Promise<DesktopPreferences> =>
    ipcRenderer.invoke('qagent:preferences-set', preferences),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('qagent:open-external', url),
  onEvent: (listener: (event: { type: string; data: unknown }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { type: string; data: unknown }) =>
      listener(payload);
    ipcRenderer.on('qagent:event', handler);
    return () => ipcRenderer.removeListener('qagent:event', handler);
  },
};

contextBridge.exposeInMainWorld('qagent', api);

export type QAgentDesktopApi = typeof api;
