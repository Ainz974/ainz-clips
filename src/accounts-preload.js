// accounts-preload.js — bridge for the in-app browser toolbar.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("acc", {
  navigate: (url) => ipcRenderer.invoke("acc-navigate", url),
  action: (a) => ipcRenderer.invoke("acc-action", a),
  done: () => ipcRenderer.invoke("accounts-done"),
  onUrl: (cb) => ipcRenderer.on("acc-url", (_e, url, canBack, canFwd) => cb(url, canBack, canFwd)),
});
