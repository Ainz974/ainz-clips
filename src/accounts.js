// accounts.js — in-app login system.
// A persistent Electron session holds the user's logins for ANY site. We use a
// real BrowserView (not a <webview>) so sites treat it like a normal browser and
// the login actually persists. Cookies export as (a) a Netscape file for yt-dlp
// and (b) a Playwright cookie array for the sniffer — both act as the logged-in user.

const { app, BrowserWindow, BrowserView, session, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const PARTITION = "persist:accounts";
const TOOLBAR_H = 96;
// Use the REAL bundled Chromium version so the UA matches the client-hints
// headers Electron actually sends (a mismatch is what login-hostile sites flag).
// We only strip the identifying "Electron/x" and app-name tokens.
const CHROME_VER = process.versions.chrome || "128.0.0.0";
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VER} Safari/537.36`;

let accountsWin = null;
let view = null;

function accSession() {
  return session.fromPartition(PARTITION);
}

// Rewrite UA + client-hint headers so the embedded Chromium presents as plain
// desktop Chrome (removes the "Electron" brand that login-hostile sites detect).
let headersPatched = false;
function patchHeaders() {
  if (headersPatched) return;
  headersPatched = true;
  const major = CHROME_VER.split(".")[0];
  const brands = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="99"`;
  accSession().webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    for (const k of Object.keys(h)) {
      if (/^user-agent$/i.test(k)) h[k] = UA;
      else if (/^sec-ch-ua$/i.test(k)) h[k] = brands;
      else if (/^sec-ch-ua-full-version-list$/i.test(k)) h[k] = brands;
      else if (/^sec-ch-ua-full-version$/i.test(k)) h[k] = `"${CHROME_VER}"`;
    }
    cb({ requestHeaders: h });
  });
}

function layout() {
  if (!accountsWin || accountsWin.isDestroyed() || !view) return;
  const [w, h] = accountsWin.getContentSize();
  view.setBounds({ x: 0, y: TOOLBAR_H, width: w, height: Math.max(0, h - TOOLBAR_H) });
}

function navigate(url) {
  if (!view) return;
  let u = (url || "").trim();
  if (!u) return;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  view.webContents.loadURL(u).catch(() => {});
}

function navAction(action) {
  if (!view) return;
  const wc = view.webContents;
  if (action === "back" && wc.canGoBack()) wc.goBack();
  else if (action === "forward" && wc.canGoForward()) wc.goForward();
  else if (action === "reload") wc.reload();
}

// Open the in-app browser. startUrl lands the user on the site to sign into.
function openAccounts(parent, startUrl) {
  if (accountsWin && !accountsWin.isDestroyed()) {
    accountsWin.focus();
    if (startUrl) navigate(startUrl);
    return accountsWin;
  }
  accountsWin = new BrowserWindow({
    width: 1060,
    height: 760,
    parent: parent || undefined,
    backgroundColor: "#0b0b0d",
    title: "Accounts — sign in to any site",
    webPreferences: {
      preload: path.join(__dirname, "accounts-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  accountsWin.removeMenu();
  accountsWin.loadFile(path.join(__dirname, "accounts.html"));

  patchHeaders();
  view = new BrowserView({
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, "accounts-view-preload.js"),
      contextIsolation: false, // let the stealth preload patch the page's navigator
    },
  });
  accountsWin.setBrowserView(view);
  view.webContents.setUserAgent(UA);
  layout();
  accountsWin.on("resize", layout);

  // keep OAuth/login popups inside the same persistent session
  view.webContents.setWindowOpenHandler(({ url }) => {
    navigate(url);
    return { action: "deny" };
  });

  const send = (ch, ...a) => accountsWin && !accountsWin.isDestroyed() && accountsWin.webContents.send(ch, ...a);
  const onNav = () =>
    send("acc-url", view.webContents.getURL(), view.webContents.canGoBack(), view.webContents.canGoForward());
  view.webContents.on("did-navigate", onNav);
  view.webContents.on("did-navigate-in-page", onNav);

  accountsWin.webContents.once("did-finish-load", () => {
    if (startUrl) navigate(startUrl);
  });
  accountsWin.on("closed", () => {
    view = null;
    accountsWin = null;
    // parent may already be tearing down on app quit — guard webContents too
    try {
      if (parent && !parent.isDestroyed() && parent.webContents && !parent.webContents.isDestroyed()) {
        parent.webContents.send("accounts-changed");
      }
    } catch (e) { /* window gone */ }
  });
  return accountsWin;
}

// toolbar → view IPC
ipcMain.handle("acc-navigate", (_e, url) => navigate(url));
ipcMain.handle("acc-action", (_e, action) => navAction(action));

// ---- cookie export ----------------------------------------------------------
async function loggedInDomains() {
  const cookies = await accSession().cookies.get({});
  const domains = new Set();
  for (const c of cookies) {
    if (/sess|auth|token|login|sid|ds_user|c_user|sso/i.test(c.name)) {
      domains.add(c.domain.replace(/^\./, ""));
    }
  }
  return [...domains];
}

function baseDomain(host) {
  const parts = host.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : host;
}

async function cookiesForUrl(targetUrl) {
  let host;
  try { host = new URL(targetUrl).hostname; } catch { return []; }
  const base = baseDomain(host);
  const all = await accSession().cookies.get({});
  return all.filter((c) => {
    const d = c.domain.replace(/^\./, "");
    return host === d || host.endsWith("." + d) || d === base || d.endsWith("." + base);
  });
}

async function exportNetscape(targetUrl) {
  const cookies = await cookiesForUrl(targetUrl);
  if (!cookies.length) return null;
  const lines = ["# Netscape HTTP Cookie File", "# generated by AINZ Clips", ""];
  for (const c of cookies) {
    const domain = c.domain.startsWith(".") ? c.domain : (c.hostOnly ? c.domain : "." + c.domain);
    const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE";
    const expiry = c.session ? 0 : Math.floor(c.expirationDate || 0);
    lines.push([domain, includeSub, c.path || "/", c.secure ? "TRUE" : "FALSE", expiry, c.name, c.value].join("\t"));
  }
  const dir = path.join(app.getPath("userData"), "cookies");
  fs.mkdirSync(dir, { recursive: true });
  const host = (() => { try { return new URL(targetUrl).hostname; } catch { return "site"; } })();
  const file = path.join(dir, `${host.replace(/[^a-z0-9.]/gi, "_")}.txt`);
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

async function exportPlaywright(targetUrl) {
  const cookies = await cookiesForUrl(targetUrl);
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    expires: c.session ? -1 : Math.floor(c.expirationDate || -1),
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite:
      c.sameSite === "no_restriction" ? "None" : c.sameSite === "strict" ? "Strict" : "Lax",
  }));
}

async function exportFor(targetUrl) {
  const [file, arr] = await Promise.all([exportNetscape(targetUrl), exportPlaywright(targetUrl)]);
  return { cookiesFile: file, cookiesArr: arr };
}

module.exports = { PARTITION, openAccounts, loggedInDomains, exportFor, accSession };
