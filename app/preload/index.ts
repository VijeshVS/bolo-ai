import { contextBridge, ipcRenderer } from "electron";
import type { PipelineResult } from "../services/pipelineService";
import type { SnippetMap } from "../services/snippetService";
import type { HistoryAnalytics } from "../services/historyService";
import type { AppSettings } from "../services/settingsService";
import type { LocalWhisperState } from "../services/localWhisperService";

export interface PermissionStatus {
  microphone: string;
  accessibility: boolean;
}

export interface InstallResult {
  ok: boolean;
  message: string;
  state: LocalWhisperState;
}

export interface MorphPayload {
  /** Height of the floating overlay, i.e. the app window's collapsed frame. */
  pillHeight: number;
}

export interface OverlayLevelPayload {
  level: number;
  active: boolean;
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
    ipcRenderer.invoke("settings:update", settings),

  getLocalWhisperStatus: (): Promise<LocalWhisperState> =>
    ipcRenderer.invoke("local-whisper:status"),

  startLocalWhisper: (): Promise<LocalWhisperState> =>
    ipcRenderer.invoke("local-whisper:start"),

  stopLocalWhisper: (): Promise<LocalWhisperState> =>
    ipcRenderer.invoke("local-whisper:stop"),

  installLocalWhisperDeps: (): Promise<InstallResult> =>
    ipcRenderer.invoke("local-whisper:install"),

  sendAudioLevel: (level: number, active: boolean): void => {
    ipcRenderer.send("overlay:audio-level", { level, active });
  },

  onMorphExpand: (handler: (payload: MorphPayload) => void): (() => void) => {
    const listener = (_event: unknown, payload: MorphPayload) => handler(payload);
    ipcRenderer.on("ui:morph-expand", listener);
    return () => ipcRenderer.off("ui:morph-expand", listener);
  },

  onMorphCollapse: (handler: (payload: MorphPayload) => void): (() => void) => {
    const listener = (_event: unknown, payload: MorphPayload) => handler(payload);
    ipcRenderer.on("ui:morph-collapse", listener);
    return () => ipcRenderer.off("ui:morph-collapse", listener);
  },

  onMorphSettled: (handler: () => void): (() => void) => {
    const listener = () => handler();
    ipcRenderer.on("ui:morph-settled", listener);
    return () => ipcRenderer.off("ui:morph-settled", listener);
  },

  sendMorphReady: (): void => {
    ipcRenderer.send("ui:morph-ready");
  },

  windowAction: (action: "close" | "minimize" | "zoom"): void => {
    ipcRenderer.send("ui:window-action", action);
  },

  overlayDragBegin: (): void => {
    ipcRenderer.send("overlay:drag-begin");
  },

  overlayDragMove: (dx: number, dy: number): void => {
    ipcRenderer.send("overlay:drag-move", { dx, dy });
  },

  overlayDragEnd: (travel: number): void => {
    ipcRenderer.send("overlay:drag-end", { travel });
  },

  overlayContextMenuRequested: (x: number, y: number): void => {
    ipcRenderer.send("overlay:context-menu", { x, y });
  },

  onOverlayLevel: (handler: (payload: OverlayLevelPayload) => void): (() => void) => {
    const listener = (_event: unknown, payload: OverlayLevelPayload) => handler(payload);
    ipcRenderer.on("overlay:level", listener);
    return () => ipcRenderer.off("overlay:level", listener);
  }
};

contextBridge.exposeInMainWorld("boloApi", boloApi);

declare global {
  interface Window {
    boloApi: typeof boloApi;
  }
}
