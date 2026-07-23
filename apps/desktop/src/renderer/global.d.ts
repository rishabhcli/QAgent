import type { QAgentDesktopApi } from '../preload.js';

declare global {
  interface Window {
    qagent: QAgentDesktopApi;
  }
}

export {};
