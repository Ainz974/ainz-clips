// main.js — Electron main process: window, config, and IPC bridge to resolver/downloader.

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const resolver = require("./resolver");
const downloader = require("./downloader");
const converter = require("./converter");
const accounts = require("./accounts");
const updater = require("./updater");

const ROOT = path.resolve(__dirname, "..");
let win = null;
let jobCounter = 0;

// ---- config (userData/config.json) ------------------------------------------
function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}
function loadConfig() {
  // dev: <project>/downloads; packaged: the OS Downloads folder (project dir is read-only asar)
  const defaultOut = app.isPackaged
    ? path.join(app.getPath("downloads"), "AINZ Clips")
    : path.join(ROOT, "downloads");
  const defaults = { outDir: defaultOut };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(configPath(), "utf8")) };
  } catch {
    return defaults;
  }
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error("config save failed", e);
  }
}
let config = null;

// ---- window -----------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 560,
    icon: path.join(ROOT, "build", "icon.png"),
    backgroundColor: "#0d0f14",
    title: "AINZ Clips",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.once("did-finish-load", () => updater.initUpdater(win));
}

ipcMain.handle("install-update", () => updater.installUpdate());

app.whenReady().then(() => {
  config = loadConfig();
  if (!fs.existsSync(config.outDir)) {
    try { fs.mkdirSync(config.outDir, { recursive: true }); } catch {}
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  downloader.cancelAll();
  if (process.platform !== "darwin") app.quit();
});

// ---- IPC --------------------------------------------------------------------
const sendLog = (scope, line) => win && win.webContents.send("resolve-log", { scope, line });

ipcMain.handle("resolve", async (_e, url) => {
  try {
    const ck = await accounts.exportFor(url);
    return { ok: true, ...(await resolver.resolve(url, (l) => sendLog("resolve", l), ck)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("resolve-manual", async (_e, { url, referer }) => {
  try {
    const ck = await accounts.exportFor(url);
    return { ok: true, ...(await resolver.resolveManual(url, referer, (l) => sendLog("resolve", l), ck)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("download", async (_e, job) => {
  const id = `job${++jobCounter}`;
  const ck = await accounts.exportFor(job.target);
  downloader.start({
    id,
    target: job.target,
    referer: job.referer,
    fmt: job.fmt,
    audio: job.audio,
    title: job.title,
    outDir: config.outDir,
    cookiesFile: ck.cookiesFile,
    onEvent: (e) => win && win.webContents.send("download-event", e),
  });
  return { id, title: job.title };
});

// ---- accounts (in-app login) ----
ipcMain.handle("open-accounts", (_e, url) => { accounts.openAccounts(win, url || null); });
ipcMain.handle("accounts-done", () => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w !== win) w.close();
  }
  if (win) win.webContents.send("accounts-changed");
});
ipcMain.handle("accounts-status", async () => ({ domains: await accounts.loggedInDomains() }));

ipcMain.handle("cancel", (_e, id) => downloader.cancel(id) || converter.cancel(id));

// ---- convert ----
ipcMain.handle("pick-file", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: [
      { name: "Media", extensions: ["mp4", "mkv", "webm", "mov", "avi", "flv", "ts", "m4v", "mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "wma"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("convert", async (_e, job) => {
  const id = `conv${++jobCounter}`;
  converter.start({
    id,
    input: job.input,
    format: job.format,
    onEvent: (e) => win && win.webContents.send("download-event", e),
  });
  return { id, title: job.title };
});

ipcMain.handle("get-config", () => config);

ipcMain.handle("pick-folder", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
    defaultPath: config.outDir,
  });
  if (r.canceled || !r.filePaths[0]) return config.outDir;
  config.outDir = r.filePaths[0];
  saveConfig(config);
  return config.outDir;
});

ipcMain.handle("open-folder", (_e, p) => {
  shell.openPath(p || config.outDir);
});

ipcMain.handle("reveal-file", (_e, f) => {
  if (f && fs.existsSync(f)) shell.showItemInFolder(f);
  else shell.openPath(config.outDir);
});
