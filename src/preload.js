// preload.js — safe bridge between renderer and main.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  resolve: (url, importBrowser) => ipcRenderer.invoke("resolve", url, importBrowser),
  resolveManual: (url, referer, importBrowser) => ipcRenderer.invoke("resolve-manual", { url, referer, importBrowser }),
  download: (job) => ipcRenderer.invoke("download", job),
  cancel: (id) => ipcRenderer.invoke("cancel", id),
  getConfig: () => ipcRenderer.invoke("get-config"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  openFolder: (p) => ipcRenderer.invoke("open-folder", p),
  revealFile: (f) => ipcRenderer.invoke("reveal-file", f),

  openAccounts: (url) => ipcRenderer.invoke("open-accounts", url),
  accountsStatus: () => ipcRenderer.invoke("accounts-status"),

  pickFile: () => ipcRenderer.invoke("pick-file"),
  convert: (job) => ipcRenderer.invoke("convert", job),

  onResolveLog: (cb) => ipcRenderer.on("resolve-log", (_e, d) => cb(d)),
  onDownloadEvent: (cb) => ipcRenderer.on("download-event", (_e, d) => cb(d)),
  onAccountsChanged: (cb) => ipcRenderer.on("accounts-changed", () => cb()),

  installUpdate: () => ipcRenderer.invoke("install-update"),
  onUpdateEvent: (cb) => ipcRenderer.on("update-event", (_e, d) => cb(d)),
});
