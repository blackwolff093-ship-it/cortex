// CORTEX — Electron main process.
// Bundled by esbuild to dist-electron/main.cjs (CJS), so __dirname is available.
import { app, BrowserWindow, dialog, shell } from "electron";
import path from "node:path";
import { initDb } from "./db";
import { initSkills } from "./skills";
import { initSemantic } from "./semantic";
import { shutdownAi } from "./ai";
import { startServer } from "./server";
import { initDispatcher, stopDispatcher } from "./dispatcher";

const PORT = Number(process.env.CORTEX_PORT || 7777);

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#050807",
    title: "CORTEX — Shared AI Memory",
    // Default title bar on purpose: the renderer is owned by another module and
    // we don't want to depend on its CSS for window dragging.
    titleBarStyle: "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
    },
  });

  // window.open / target=_blank → open in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const url = process.env.VITE_DEV
    ? "http://localhost:5173"
    : `http://localhost:${PORT}`;
  void mainWindow.loadURL(url);
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (app.isReady()) {
      createWindow();
    }
  });

  app.whenReady().then(async () => {
    const dbPath =
      process.env.CORTEX_DB || path.join(app.getPath("userData"), "cortex.db");
    const rootDir = app.isPackaged
      ? path.dirname(app.getPath("exe"))
      : process.cwd();
    const seedDir = app.isPackaged
      ? path.join(process.resourcesPath, "seed")
      : path.join(process.cwd(), "seed");
    const stdioPath = app.isPackaged
      ? path.join(process.resourcesPath, "mcp-stdio.cjs")
      : path.join(process.cwd(), "dist-electron", "mcp-stdio.cjs");
    const distDir = app.isPackaged
      ? path.join(app.getAppPath(), "dist")
      : path.join(process.cwd(), "dist");

    try {
      initDb(dbPath, seedDir);
      initSkills();
    } catch (err) {
      dialog.showErrorBox(
        "CORTEX — Database error",
        
          "Failed to open the database. Make sure the path is writable, then restart the app.\n\n" +
          String(err instanceof Error ? err.message : err)
      );
      app.quit();
      return;
    }

    try {
      await startServer({
        port: PORT,
        distDir,
        rootDir,
        stdioPath,
        packaged: app.isPackaged,
      });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      const busy =
        (err as NodeJS.ErrnoException | null)?.code === "EADDRINUSE" ||
        msg.includes("EADDRINUSE");
      dialog.showErrorBox(
        "CORTEX — Port " + PORT,
        busy
          ?
            
            `Port ${PORT} is already in use — another CORTEX instance (or another app) is using it.\n` +
            `Close it or change the port via the CORTEX_PORT environment variable, then relaunch.`
          : `Failed to start the embedded server.\n\n${msg}`
      );
      app.quit();
      return;
    }

    createWindow();

    // Keeps the semantic index warm in the background (own utilityProcess, so
    // it never blocks the UI). Safe if no embedding model is installed yet.
    initSemantic();

    // Hook file-based dispatcher
    initDispatcher(rootDir, rootDir, stdioPath);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("before-quit", () => {
    stopDispatcher();
    shutdownAi();
  });

  app.on("window-all-closed", () => {
    // On macOS keep the app (and the embedded server) alive so AI agents
    // can keep talking to CORTEX even with the window closed.
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
// test
