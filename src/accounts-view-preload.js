// accounts-view-preload.js — runs inside the in-app browser page (main world) to
// make the embedded Chromium look like a plain desktop Chrome, so login-hostile
// sites (Instagram, TikTok, Google) don't bounce the sign-in.
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

  // plausible hardware (headless/VM often report 0 or odd values)
  Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
  try { Object.defineProperty(navigator, "deviceMemory", { get: () => 8 }); } catch (e) {}

  // permissions query shouldn't reveal automation
  const origQuery = navigator.permissions && navigator.permissions.query;
  if (origQuery) {
    navigator.permissions.query = (p) =>
      p && p.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : origQuery.call(navigator.permissions, p);
  }

  // spoof the WebGL vendor/renderer so it looks like real GPU hardware
  // (TikTok/Cloudflare flag SwiftShader / generic renderers as bots)
  const spoofGL = (proto) => {
    if (!proto) return;
    const orig = proto.getParameter;
    proto.getParameter = function (p) {
      if (p === 37445) return "Google Inc. (NVIDIA)"; // UNMASKED_VENDOR_WEBGL
      if (p === 37446) return "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)"; // UNMASKED_RENDERER_WEBGL
      return orig.apply(this, arguments);
    };
  };
  spoofGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  spoofGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
} catch (e) { /* best-effort */ }
