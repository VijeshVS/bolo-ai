import { app, BrowserWindow, ipcMain, Menu, MenuItemConstructorOptions, Rectangle } from "electron";
import path from "node:path";
import dotenv from "dotenv";
import { registerHoldHotkey, unregisterHoldHotkey } from "./holdHotkey";
import { registerIpcHandlers } from "./ipc";
import {
  createOverlayWindow,
  getOverlayBounds,
  hideOverlayWindow,
  OVERLAY_HEIGHT,
  OVERLAY_WIDTH,
  showOverlayWindow
} from "./overlayWindow";
import {
  animateBounds,
  COLLAPSE_DURATION_MS,
  EXPAND_DURATION_MS,
  expandedAppBounds
} from "./morph";
import { logger } from "../utils/logger";

dotenv.config();

let mainWindow: BrowserWindow | null = null;
let servicesInitialized = false;
let isQuitting = false;
let transitioning = false;
let morphReadyResolve: (() => void) | null = null;

// The pill is the macOS surface. Other platforms keep the plain always-visible
// window behaviour they had before.
const usesOverlay = process.platform === "darwin";

const APP_MIN_WIDTH = 420;
const APP_MIN_HEIGHT = 560;

function getRendererHtmlPath(): string {
  return path.join(app.getAppPath(), "app", "renderer", "index.html");
}

function createApplicationMenu(): void {
  // Deliberately not `role: "appMenu"`: its Hide item would call app.hide() and
  // take the floating pill with it, leaving no way back into the app.
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Bolo AI",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Quit Bolo AI",
          accelerator: "CmdOrCtrl+Q",
          click: () => app.quit()
        }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow(): BrowserWindow {
  const iconPath = path.join(app.getAppPath(), "assets", "icon.png");
  const window = new BrowserWindow({
    show: false,
    width: 520,
    height: 680,
    // Small enough that the window can shrink all the way down to pill size
    // during the morph. The real minimum is restored once it has expanded.
    minWidth: 260,
    minHeight: 62,
    autoHideMenuBar: true,
    icon: iconPath,
    title: "Bolo AI",
    // The app surface is a rounded, shadowed card, so the window itself must be
    // transparent and must not impose the system corner radius — otherwise the
    // OS clip would fight the radius the pill morph animates.
    transparent: true,
    backgroundColor: "#00000000",
    // "hidden" rather than "hiddenInset": Electron draws no native traffic
    // lights on a transparent window, and the renderer supplies macOS-styled
    // ones instead (see .titlebar in index.html).
    titleBarStyle: "hidden",
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  window.loadFile(getRendererHtmlPath()).catch((error) => {
    logger.error("Failed to load renderer HTML", { error: String(error) });
  });

  return window;
}

/** Sends on the next tick if the renderer is still loading. */
function sendToMainWindow(channel: string, ...args: unknown[]): void {
  if (!mainWindow) {
    return;
  }

  const send = (): void => {
    mainWindow?.webContents.send(channel, ...args);
  };

  if (mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once("did-finish-load", send);
    return;
  }

  send();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function showMainWindow(): void {
  if (!mainWindow) {
    openMainWindow();
  }

  if (!mainWindow || transitioning) {
    return;
  }

  const window = mainWindow;

  if (window.isMinimized()) {
    window.restore();
  }

  // Already on screen: focus it rather than replaying the expand animation.
  if (window.isVisible()) {
    window.focus();
    return;
  }

  const pillBounds = usesOverlay ? getOverlayBounds() : null;

  if (!pillBounds) {
    window.show();
    window.focus();
    return;
  }

  void expandFromPill(window, pillBounds);
}

async function expandFromPill(window: BrowserWindow, pillBounds: Rectangle): Promise<void> {
  transitioning = true;

  const target = expandedAppBounds(pillBounds);

  window.setMinimumSize(OVERLAY_WIDTH, OVERLAY_HEIGHT);

  // The renderer has to be holding the pill appearance before the window
  // becomes visible, otherwise the app flashes at full size for one frame.
  morphReadyResolve = null;
  sendToMainWindow("ui:morph-expand", { pillHeight: OVERLAY_HEIGHT });

  await Promise.race([
    new Promise<void>((resolve) => {
      morphReadyResolve = resolve;
    }),
    wait(300)
  ]);
  morphReadyResolve = null;

  hideOverlayWindow();

  // Bring the Dock icon back as the app becomes the active one, before the
  // window appears so the two never disagree.
  app.dock?.show();

  window.setBounds(pillBounds);
  window.show();

  await animateBounds(window, pillBounds, target, EXPAND_DURATION_MS);

  sendToMainWindow("ui:morph-settled");
  window.setMinimumSize(APP_MIN_WIDTH, APP_MIN_HEIGHT);
  window.focus();
  transitioning = false;
  logger.info("Expanded from floating overlay", { bounds: target });
}

function collapseToOverlay(): void {
  if (!mainWindow || transitioning) {
    return;
  }

  if (!usesOverlay) {
    mainWindow.hide();
    return;
  }

  void collapseIntoPill(mainWindow);
}

async function collapseIntoPill(window: BrowserWindow): Promise<void> {
  const pillBounds = getOverlayBounds();

  if (!pillBounds) {
    window.hide();
    return;
  }

  transitioning = true;
  window.setMinimumSize(OVERLAY_WIDTH, OVERLAY_HEIGHT);
  sendToMainWindow("ui:morph-collapse", { pillHeight: OVERLAY_HEIGHT });

  // The surface rounds off as the frame shrinks, so the two motions read as one.
  await animateBounds(window, window.getBounds(), pillBounds, COLLAPSE_DURATION_MS);

  sendToMainWindow("ui:morph-settled");
  window.hide();
  app.dock?.hide();
  showOverlayWindow();
  transitioning = false;
  logger.info("Collapsed back into floating overlay", { bounds: pillBounds });
}

function setupServices(window: BrowserWindow): void {
  if (servicesInitialized) {
    return;
  }

  registerIpcHandlers(window);
  registerHoldHotkey({
    onPressStart: () => {
      if (!mainWindow) {
        openMainWindow();
      }

      sendToMainWindow("hotkey:start-recording");
    },
    onPressEnd: () => {
      sendToMainWindow("hotkey:stop-recording");
    }
  });

  ipcMain.on("ui:morph-ready", () => {
    morphReadyResolve?.();
    morphReadyResolve = null;
  });

  ipcMain.on("ui:window-action", (_event, action: unknown) => {
    const target = BrowserWindow.fromWebContents(_event.sender);

    if (!target || target !== mainWindow) {
      return;
    }

    if (action === "close" || action === "minimize") {
      // Closing and minimizing both collapse to the floating capsule, which is
      // the app's single persistent surface.
      collapseToOverlay();
      return;
    }

    if (action === "zoom") {
      target.setFullScreen(!target.isFullScreen());
    }
  });

  servicesInitialized = true;
}

function openMainWindow(): void {
  mainWindow = createMainWindow();

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    collapseToOverlay();
  });

  mainWindow.on("minimize", () => {
    mainWindow?.restore();
    collapseToOverlay();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  setupServices(mainWindow);
  logger.info("Main window ready");
}

app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(path.join(app.getAppPath(), "assets", "icon.png"));

    // The dock belongs to the expanded app. While the app is collapsed to the
    // floating pill it is not the active app, so the dock stays out of the way.
    if (usesOverlay) {
      app.dock.hide();
    }
  }

  createApplicationMenu();
  openMainWindow();

  if (usesOverlay) {
    const overlay = await createOverlayWindow({
      onOpenRequested: () => {
        showMainWindow();
      },
      onQuitRequested: () => {
        app.quit();
      },
      getLevelSource: () => mainWindow
    });

    await new Promise<void>((resolve) => {
      if (overlay.webContents.isLoadingMainFrame()) {
        overlay.webContents.once("did-finish-load", () => resolve());
        return;
      }

      resolve();
    });

    showOverlayWindow();
    logger.info("Floating overlay ready", { bounds: overlay.getBounds() });
  } else {
    showMainWindow();
  }

  app.on("activate", () => {
    if (!mainWindow) {
      openMainWindow();
    }

    showMainWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  unregisterHoldHotkey();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  isQuitting = true;
});
