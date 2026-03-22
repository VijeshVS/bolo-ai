import { app, BrowserWindow, Menu, Tray, nativeImage } from "electron";
import path from "node:path";
import dotenv from "dotenv";
import { registerHoldHotkey, unregisterHoldHotkey } from "./holdHotkey";
import { registerIpcHandlers } from "./ipc";
import { logger } from "../utils/logger";

dotenv.config();

let mainWindow: BrowserWindow | null = null;
let servicesInitialized = false;
let tray: Tray | null = null;
let isQuitting = false;

function getRendererHtmlPath(): string {
  return path.join(app.getAppPath(), "app", "renderer", "index.html");
}

function getTrayIconPath(): string {
  return path.join(app.getAppPath(), "assets", "icon.png");
}

function maximizeWindow(window: BrowserWindow): void {
  if (window.isMinimized()) {
    window.restore();
  }

  if (!window.isMaximized()) {
    window.maximize();
  }
}

function showMainWindow(): void {
  if (!mainWindow) {
    openMainWindow();
  }

  if (!mainWindow) {
    return;
  }

  maximizeWindow(mainWindow);
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindow(): void {
  if (!mainWindow) {
    return;
  }

  mainWindow.hide();
}

function toggleMainWindow(): void {
  if (!mainWindow || !mainWindow.isVisible()) {
    showMainWindow();
    return;
  }

  if (mainWindow.isFocused()) {
    hideMainWindow();
    return;
  }

  showMainWindow();
}

function createTray(): void {
  if (tray || process.platform !== "darwin") {
    return;
  }

  const trayIcon = nativeImage.createFromPath(getTrayIconPath());
  const resizedIcon = trayIcon.resize({ width: 22, height: 22 });
  tray = new Tray(resizedIcon);
  
  // Always set title as fallback to ensure menu bar item is visible
  tray.setTitle("◉");
  tray.setToolTip("Bolo AI");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show/Hide Bolo AI",
      click: () => {
        toggleMainWindow();
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function createMainWindow(): BrowserWindow {
  const iconPath = path.join(app.getAppPath(), "assets", "icon.png");
  const window = new BrowserWindow({
    show: false,
    width: 520,
    height: 680,
    minWidth: 420,
    minHeight: 560,
    autoHideMenuBar: true,
    icon: iconPath,
    title: "Bolo AI",
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

      if (!mainWindow) {
        return;
      }

      const sendStartRecording = (): void => {
        mainWindow?.webContents.send("hotkey:start-recording");
      };

      if (mainWindow.webContents.isLoadingMainFrame()) {
        mainWindow.webContents.once("did-finish-load", sendStartRecording);
        return;
      }

      sendStartRecording();
    },
    onPressEnd: () => {
      if (!mainWindow) {
        return;
      }

      const sendStopRecording = (): void => {
        mainWindow?.webContents.send("hotkey:stop-recording");
      };

      if (mainWindow.webContents.isLoadingMainFrame()) {
        mainWindow.webContents.once("did-finish-load", sendStopRecording);
        return;
      }

      sendStopRecording();
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
    hideMainWindow();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  setupServices(mainWindow);
  logger.info("Main window ready");
}

app.whenReady().then(async () => {
  const iconPath = path.join(app.getAppPath(), "assets", "icon.png");
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(iconPath);
    app.dock.hide();
  }
  
  createTray();
  openMainWindow();

  app.on("activate", () => {
    if (!mainWindow) {
      openMainWindow();
    }

    showMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  isQuitting = true;
  unregisterHoldHotkey();
});
