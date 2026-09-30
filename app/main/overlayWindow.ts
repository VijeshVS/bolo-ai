import { app, BrowserWindow, ipcMain, Menu, Rectangle, screen } from "electron";
import { uIOhook } from "uiohook-napi";
import path from "node:path";
import { isGlobalHookActive } from "./holdHotkey";
import { OverlayPositionService } from "../services/overlayPositionService";
import { logger } from "../utils/logger";

// The window is slightly larger than the capsule so the capsule's rounded
// corners never sit on the window edge, where macOS composites the transparent
// corner region as an opaque black fill.
export const OVERLAY_WIDTH = 124;
export const OVERLAY_HEIGHT = 48;

const PILL_EDGE_GAP = 12;
const PILL_BOTTOM_GAP = 28;

const positionService = new OverlayPositionService();

// Pointer travel (in px) below which a press counts as a click, not a drag.
const CLICK_TRAVEL_THRESHOLD = 5;

// Upper bound on how far one pointer event may move the capsule.
const MAX_EVENT_DELTA = 300;

let overlayWindow: BrowserWindow | null = null;
let overlayCallbacks: OverlayWindowCallbacks | null = null;
let dragRemainder = { x: 0, y: 0 };
// Which input path owns the drag in progress. Exactly one of them finishes the
// gesture, so a mouseup seen by both the hook and the renderer cannot open the
// app twice.
type DragMode = "none" | "global" | "renderer";

let dragMode: DragMode = "none";
let globalDrag: { originX: number; originY: number; lastX: number; lastY: number } | null = null;
let gestureFinished = false;

export interface OverlayWindowCallbacks {
  onOpenRequested: () => void;
  onQuitRequested: () => void;
  /**
   * The window that owns the microphone and reports levels. Levels are pushed
   * from there, not from the overlay itself.
   */
  getLevelSource: () => BrowserWindow | null;
}

function getOverlayHtmlPath(): string {
  return path.join(app.getAppPath(), "app", "renderer", "overlay.html");
}

function defaultBounds(): Rectangle {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;

  return {
    x: Math.round(area.x + (area.width - OVERLAY_WIDTH) / 2),
    y: Math.round(area.y + area.height - OVERLAY_HEIGHT - PILL_BOTTOM_GAP),
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT
  };
}

/** Keeps the whole overlay inside the work area of whichever display it is over. */
function clampToWorkArea(bounds: Rectangle): Rectangle {
  const area = screen.getDisplayMatching(bounds).workArea;
  const minX = area.x + PILL_EDGE_GAP;
  const minY = area.y + PILL_EDGE_GAP;
  const maxX = area.x + area.width - OVERLAY_WIDTH - PILL_EDGE_GAP;
  const maxY = area.y + area.height - OVERLAY_HEIGHT - PILL_EDGE_GAP;

  return {
    ...bounds,
    x: Math.min(Math.max(bounds.x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(bounds.y, minY), Math.max(minY, maxY))
  };
}

async function resolveInitialBounds(): Promise<Rectangle> {
  await positionService.init();
  const saved = positionService.getPosition();

  if (saved) {
    return clampToWorkArea({ x: saved.x, y: saved.y, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT });
  }

  return defaultBounds();
}

function buildContextMenu(): Menu {
  const callbacks = overlayCallbacks;

  if (!callbacks) {
    return Menu.buildFromTemplate([]);
  }

  return Menu.buildFromTemplate([
    {
      label: "Open Bolo AI",
      click: () => callbacks.onOpenRequested()
    },
    { type: "separator" },
    {
      label: "Quit Bolo AI",
      accelerator: "CmdOrCtrl+Q",
      click: () => callbacks.onQuitRequested()
    }
  ]);
}

export async function createOverlayWindow(callbacks: OverlayWindowCallbacks): Promise<BrowserWindow> {
  if (overlayWindow) {
    return overlayWindow;
  }

  const bounds = await resolveInitialBounds();

  const window = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    acceptFirstMouse: true,
    // The pill floats over whatever the user is doing, so it must never pull
    // focus away from the frontmost app. It still receives mouse events.
    focusable: false,
    title: "Bolo AI",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  // Frameless windows have no native resize affordance, and the overlay is a
  // fixed-size surface, so both are disabled.
  window.setResizable(false);
  window.setBackgroundColor("#00000000");
  window.setHasShadow(false);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setAlwaysOnTop(true, "floating");

  window.loadFile(getOverlayHtmlPath()).catch((error) => {
    logger.error("Failed to load overlay HTML", { error: String(error) });
  });

  overlayWindow = window;
  overlayCallbacks = callbacks;
  registerDragHandlers();

  return window;
}

function persistOverlayPosition(): void {
  const window = overlayWindow;

  if (!window) {
    return;
  }

  const [x, y] = window.getPosition();

  void positionService.updatePosition(x, y).catch((error) => {
    logger.error("Failed to persist overlay position", { error: String(error) });
  });
}

/** Moves the capsule by a pointer delta, keeping it fully on screen. */
function applyDragDelta(dx: number, dy: number): void {
  const window = overlayWindow;

  if (!window) {
    return;
  }

  const [currentX, currentY] = window.getPosition();

  const target = clampToWorkArea({
    x: currentX + dx + dragRemainder.x,
    y: currentY + dy + dragRemainder.y,
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT
  });

  // Whatever the screen edge refused to give is dropped, so dragging back away
  // from the edge resumes immediately instead of unwinding a backlog.
  dragRemainder = { x: 0, y: 0 };

  window.setPosition(target.x, target.y);
}

function startGlobalDrag(): boolean {
  if (!isGlobalHookActive()) {
    return false;
  }

  // Detach first. Registering the same handler twice makes every pointer event
  // apply its delta twice, which sends the capsule racing ahead into the screen
  // edge and back out again.
  stopGlobalDrag();

  globalDrag = { originX: NaN, originY: NaN, lastX: NaN, lastY: NaN };

  uIOhook.on("mousemove", handleGlobalMove);
  uIOhook.on("mouseup", handleGlobalUp);

  return true;
}

function stopGlobalDrag(): void {
  globalDrag = null;
  uIOhook.off("mousemove", handleGlobalMove);
  uIOhook.off("mouseup", handleGlobalUp);
}

function handleGlobalMove(event: { x: number; y: number }): void {
  if (!globalDrag) {
    return;
  }

  // The first event only establishes the reference point, so any constant
  // offset between uiohook's screen coordinates and Electron's is irrelevant;
  // only the movement between events is used.
  if (Number.isNaN(globalDrag.originX)) {
    globalDrag.originX = event.x;
    globalDrag.originY = event.y;
    globalDrag.lastX = event.x;
    globalDrag.lastY = event.y;
    return;
  }

  const rawDx = event.x - globalDrag.lastX;
  const rawDy = event.y - globalDrag.lastY;

  globalDrag.lastX = event.x;
  globalDrag.lastY = event.y;

  // A real pointer never covers this much ground in one event. Clamping is a
  // guard so that if the hook and Electron ever disagree about screen units,
  // the capsule degrades to lagging slightly instead of teleporting.
  const dx = Math.max(-MAX_EVENT_DELTA, Math.min(MAX_EVENT_DELTA, rawDx));
  const dy = Math.max(-MAX_EVENT_DELTA, Math.min(MAX_EVENT_DELTA, rawDy));

  applyDragDelta(dx, dy);
}

/** Distance the pointer has covered during the current gesture. */
function gestureTravel(): number {
  if (dragMode !== "global" || !globalDrag) {
    return 0;
  }

  if (Number.isNaN(globalDrag.originX)) {
    return 0;
  }

  return Math.hypot(globalDrag.lastX - globalDrag.originX, globalDrag.lastY - globalDrag.originY);
}

/**
 * Ends the gesture exactly once. Both the global hook's mouseup and the
 * renderer's own mouseup call this, whichever arrives first, so a missed hook
 * event can never leave the capsule unresponsive.
 */
function finishDrag(travelled: number): void {
  if (gestureFinished) {
    return;
  }

  gestureFinished = true;
  stopGlobalDrag();
  dragMode = "none";

  if (travelled < CLICK_TRAVEL_THRESHOLD) {
    overlayCallbacks?.onOpenRequested();
    return;
  }

  persistOverlayPosition();
}

function handleGlobalUp(): void {
  if (dragMode !== "global") {
    return;
  }

  finishDrag(gestureTravel());
}

function registerDragHandlers(): void {
  ipcMain.on("overlay:context-menu", (event, payload: { x?: number; y?: number }) => {
    const window = BrowserWindow.fromWebContents(event.sender);

    if (!window || window !== overlayWindow) {
      return;
    }

    buildContextMenu().popup({
      window,
      x: Math.round(Number(payload?.x) || 0),
      y: Math.round(Number(payload?.y) || 0)
    });
  });

  ipcMain.on("overlay:drag-begin", (event) => {
    if (BrowserWindow.fromWebContents(event.sender) !== overlayWindow) {
      return;
    }

    dragRemainder = { x: 0, y: 0 };
    gestureFinished = false;

    // Preferred path: follow the pointer with the global hook so the capsule
    // keeps tracking the cursor after it leaves the capsule's own tiny window.
    // Renderer deltas only work while the cursor stays over the capsule, which
    // is what made fast drags stutter, stall and bounce back and forth.
    dragMode = startGlobalDrag() ? "global" : "renderer";
  });

  ipcMain.on("overlay:drag-move", (event, payload: { dx?: number; dy?: number }) => {
    if (BrowserWindow.fromWebContents(event.sender) !== overlayWindow || dragMode !== "renderer") {
      return;
    }

    applyDragDelta(Number(payload?.dx) || 0, Number(payload?.dy) || 0);
  });

  ipcMain.on("overlay:drag-end", (event, payload: { travel?: number }) => {
    if (BrowserWindow.fromWebContents(event.sender) !== overlayWindow) {
      return;
    }

    // The hook's own mouseup may have already finished the gesture. When it has
    // not, this is the guaranteed fallback that keeps the capsule clickable
    // and draggable even if the hook is not delivering events.
    finishDrag(dragMode === "global" ? gestureTravel() : Number(payload?.travel) || 0);
  });

  ipcMain.on(
    "overlay:audio-level",
    (event, payload: { level?: unknown; active?: unknown }) => {
      // The recorder lives in the main window, so that is the legitimate
      // sender; the overlay must not be able to drive its own waveform.
      if (BrowserWindow.fromWebContents(event.sender) !== overlayCallbacks?.getLevelSource()) {
        return;
      }

      const raw = typeof payload?.level === "number" && Number.isFinite(payload.level)
        ? payload.level
        : 0;

      overlayWindow?.webContents.send("overlay:level", {
        level: Math.min(1, Math.max(0, raw)),
        active: Boolean(payload?.active)
      });
    }
  );
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow;
}

export function getOverlayBounds(): Rectangle | null {
  return overlayWindow ? overlayWindow.getBounds() : null;
}

export function showOverlayWindow(): void {
  const window = overlayWindow;

  if (!window) {
    return;
  }

  if (window.isMinimized()) {
    window.restore();
  }

  window.show();
  window.setAlwaysOnTop(true, "floating");
}

export function hideOverlayWindow(): void {
  overlayWindow?.hide();
}
