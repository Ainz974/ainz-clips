// updater.js — automatic updates from GitHub Releases (via electron-updater).
// Active only in a packaged build; the GitHub repo comes from package.json "build.publish".
// When you publish a newer release to GitHub, the app downloads it in the background
// and offers a "Restart & update" button.

const { app } = require("electron");

let autoUpdater = null;

function initUpdater(win) {
  if (!app.isPackaged) return; // no self-update in dev
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    return;
  }
  const send = (e) => win && !win.isDestroyed() && win.webContents.send("update-event", e);

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => send({ type: "available", version: info.version }));
  autoUpdater.on("download-progress", (p) => send({ type: "progress", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => send({ type: "ready", version: info.version }));
  autoUpdater.on("error", (err) => send({ type: "error", message: String(err && err.message || err) }));

  autoUpdater.checkForUpdates().catch(() => {});
  // re-check every 3 hours while running
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 3 * 60 * 60 * 1000);
}

function installUpdate() {
  if (autoUpdater) autoUpdater.quitAndInstall();
}

module.exports = { initUpdater, installUpdate };
