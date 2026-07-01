// accounts-view-preload.js — runs inside the in-app browser page (main world) to
// make the embedded Chromium look like a plain desktop Chrome, so login-hostile
// sites (Instagram, Google) don't bounce the sign-in.
try {
  // hide the automation flag
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  // real Chrome exposes window.chrome
  if (!window.chrome) window.chrome = { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} };
  // plausible language + plugin surface
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  Object.defineProperty(navigator, "plugins", {
    get: () => [{ name: "Chrome PDF Plugin" }, { name: "Chrome PDF Viewer" }, { name: "Native Client" }],
  });
  // permissions query shouldn't reveal automation
  const origQuery = navigator.permissions && navigator.permissions.query;
  if (origQuery) {
    navigator.permissions.query = (p) =>
      p && p.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : origQuery.call(navigator.permissions, p);
  }
} catch (e) { /* best-effort */ }
