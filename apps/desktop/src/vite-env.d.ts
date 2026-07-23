/// <reference types="vite/client" />

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

declare module 'electron-squirrel-startup' {
  const started: boolean;
  export default started;
}
