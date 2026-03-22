import { contextBridge, ipcRenderer } from "electron";
import type { PipelineResult } from "../services/pipelineService";
import type { SnippetMap } from "../services/snippetService";
import type { HistoryAnalytics } from "../services/historyService";
import type { AppSettings } from "../services/settingsService";

export interface PermissionStatus {
  microphone: string;
  accessibility: boolean;
}

const boloApi = {
  checkPermissions: (options?: { requestMicrophone?: boolean; promptAccessibility?: boolean }): Promise<PermissionStatus> =>
    ipcRenderer.invoke("permissions:check", options),

  processAudio: (audioData: ArrayBuffer, mimeType: string): Promise<PipelineResult> =>
    ipcRenderer.invoke("pipeline:process-audio", {
      audioData: new Uint8Array(audioData),
      mimeType
    }),

  onHotkeyStartRecording: (handler: () => void): (() => void) => {
    const listener = () => handler();
    ipcRenderer.on("hotkey:start-recording", listener);
    return () => ipcRenderer.off("hotkey:start-recording", listener);
  },

  onHotkeyStopRecording: (handler: () => void): (() => void) => {
    const listener = () => handler();
    ipcRenderer.on("hotkey:stop-recording", listener);
    return () => ipcRenderer.off("hotkey:stop-recording", listener);
  },

  getSnippets: (): Promise<SnippetMap> => ipcRenderer.invoke("snippets:get"),

  setSnippet: (key: string, value: string): Promise<SnippetMap> =>
    ipcRenderer.invoke("snippets:set", { key, value }),

  removeSnippet: (key: string): Promise<SnippetMap> =>
    ipcRenderer.invoke("snippets:remove", { key }),

  getHistoryAnalytics: (): Promise<HistoryAnalytics> =>
    ipcRenderer.invoke("history:get-analytics"),

  clearHistory: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke("history:clear"),

  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke("settings:get"),

  updateSettings: (settings: AppSettings): Promise<AppSettings> =>
    ipcRenderer.invoke("settings:update", settings)
};

contextBridge.exposeInMainWorld("boloApi", boloApi);

declare global {
  interface Window {
    boloApi: typeof boloApi;
  }
}
