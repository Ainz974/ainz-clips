// app.js — renderer logic: detect → choose source/quality → queue downloads.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtDur = (s) => {
  if (!s) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(x).padStart(2, "0")}`;
};

let config = { outDir: "" };
const queue = new Map(); // id -> {el, ...}

// ---------- init ----------
(async function init() {
  config = await window.api.getConfig();
  $("outdirPath").textContent = config.outDir;
  refreshAccounts();
})();

async function refreshAccounts() {
  try {
    const { domains } = await window.api.accountsStatus();
    const n = domains.length;
    $("accountsLabel").textContent = n ? `Accounts (${n})` : "Accounts";
    $("accDot").className = "acc-dot " + (n ? "on" : "off");
    $("accountsBtn").title = n
      ? "Signed in: " + domains.join(", ") + " — click to add or manage"
      : "Not signed in anywhere. Click to sign in to sites that need an account (Instagram, private posts…). Saved on this device.";
    // once the user has signed into something, the explainer isn't needed
    if (n && !localStorage.getItem("accBannerDismissed")) hideAccountsBanner();
  } catch {}
}
window.api.onAccountsChanged(refreshAccounts);

// accounts explainer banner
function hideAccountsBanner() { $("accountsBanner").classList.add("hidden"); }
if (localStorage.getItem("accBannerDismissed")) hideAccountsBanner();
$("bannerDismiss").onclick = () => { localStorage.setItem("accBannerDismissed", "1"); hideAccountsBanner(); };
$("bannerOpen").onclick = () => window.api.openAccounts();

// auto-update banner
window.api.onUpdateEvent((e) => {
  const banner = $("updateBanner"), text = $("updateText"), action = $("updateInstall");
  banner.classList.remove("hidden");
  if (e.type === "available") { text.textContent = `Downloading update v${e.version}…`; action.classList.add("hidden"); }
  else if (e.type === "progress") { text.textContent = `Downloading update… ${e.percent}%`; action.classList.add("hidden"); }
  else if (e.type === "ready") { text.textContent = `Update v${e.version} ready.`; action.classList.remove("hidden"); }
  else if (e.type === "error") { banner.classList.add("hidden"); }
});
$("updateInstall").onclick = () => window.api.installUpdate();

// ---------- first-run welcome ----------
let pointerActive = false;
function positionCallout() {
  const btn = $("accountsBtn");
  const cal = $("accCallout");
  const arrow = cal.querySelector(".cal-arrow");
  const r = btn.getBoundingClientRect();
  const w = cal.offsetWidth;
  const centerX = r.left + r.width / 2;
  // center the callout under the button, clamped to the viewport
  let left = Math.max(10, Math.min(centerX - w / 2, window.innerWidth - w - 10));
  cal.style.top = r.bottom + 10 + "px";
  cal.style.left = left + "px";
  // point the arrow at the button's center, wherever the callout ended up
  if (arrow) {
    arrow.style.right = "auto";
    arrow.style.left = Math.max(10, Math.min(centerX - left - 6, w - 22)) + "px";
  }
}
function showAccountsPointer() {
  pointerActive = true;
  $("accountsBtn").classList.add("highlight");
  $("accCallout").classList.remove("hidden");
  positionCallout();
}
function clearAccountsPointer() {
  pointerActive = false;
  $("accountsBtn").classList.remove("highlight");
  $("accCallout").classList.add("hidden");
  clearTimeout(clearAccountsPointer._t);
}
// keep the callout glued to the button — on window resize AND whenever the button
// itself changes size (e.g. label updates from "Accounts" to "Accounts (1)").
window.addEventListener("resize", () => { if (pointerActive) positionCallout(); });
if (window.ResizeObserver) {
  new ResizeObserver(() => { if (pointerActive) positionCallout(); }).observe($("accountsBtn"));
}
function closeWelcome() {
  localStorage.setItem("welcomeSeen", "1");
  $("welcome").classList.add("hidden");
}
$("welcomeSkip").onclick = () => {
  closeWelcome();
  clearAccountsPointer();
};
$("welcomeOpen").onclick = () => {
  closeWelcome();
  clearAccountsPointer();
  window.api.openAccounts();
};
// clicking the real button also clears the pointer
$("accountsBtn").addEventListener("click", clearAccountsPointer);

if (!localStorage.getItem("welcomeSeen")) {
  hideAccountsBanner(); // redundant with the modal on first run
  $("welcome").classList.remove("hidden");
  // point at the Accounts button automatically, right away
  requestAnimationFrame(showAccountsPointer);
}

window.api.onResolveLog(({ line }) => appendLog(line));
window.api.onDownloadEvent(handleDownloadEvent);

// ---------- log ----------
function appendLog(line) {
  const log = $("log");
  log.textContent += line + "\n";
  log.scrollTop = log.scrollHeight;
}

// ---------- status ----------
// kind: "busy" | "ok" | "error" | null
function setStatus(text, kind) {
  const s = $("status");
  s.className = "status" + (kind === "error" ? " error" : kind === "ok" ? " ok" : "");
  if (!text) { s.classList.add("hidden"); s.innerHTML = ""; return; }
  s.innerHTML = `<span>${esc(text)}</span>`;
}

// skeleton placeholder cards while detecting
function showSkeleton(n = 2) {
  const wrap = $("sources");
  wrap.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const row = el("div", "source-card skel-row");
    row.style.setProperty("--i", i);
    row.innerHTML = `
      <div class="skel skel-thumb"></div>
      <div style="flex:1">
        <div class="skel skel-line" style="width:55%;margin-bottom:9px"></div>
        <div class="skel skel-line" style="width:32%"></div>
      </div>
      <div class="skel skel-line" style="width:96px;height:38px;border-radius:9px"></div>`;
    wrap.appendChild(row);
  }
}

// ---------- detect ----------
let lastUrl = "";        // remembered so "import from browser" can re-run detection
let importBrowser = "";  // when set, cookies come from the user's real browser
async function runDetect(url) {
  if (!url) return;
  lastUrl = url;
  $("log").textContent = "";
  showSkeleton();
  setStatus("Detecting — trying yt-dlp, then the browser fallback. Up to ~20s on tricky sites.", "busy");
  $("detectBtn").disabled = true;
  try {
    const res = await window.api.resolve(url, importBrowser || undefined);
    handleResolveResult(res);
  } catch (e) {
    $("sources").innerHTML = "";
    setStatus("Error: " + e.message, "error");
  } finally {
    $("detectBtn").disabled = false;
  }
}

async function runManual() {
  const url = $("manualUrl").value.trim();
  const ref = $("manualRef").value.trim();
  if (!url) return;
  showSkeleton(1);
  setStatus("Resolving pasted URL…", "busy");
  try {
    const res = await window.api.resolveManual(url, ref);
    handleResolveResult(res);
  } catch (e) {
    $("sources").innerHTML = "";
    setStatus("Error: " + e.message, "error");
  }
}

function siteOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } }

function handleResolveResult(res) {
  if (!res.ok) { $("sources").innerHTML = ""; setStatus("Could not resolve: " + res.error, "error"); return; }
  if (res.kind === "auth") { showAuthPrompt(res.site, res.loginUrl, true); return; }
  if (!res.sources || !res.sources.length) {
    // might be login-walled (esp. if a partial session confused detection) — offer sign-in + import
    showAuthPrompt(siteOf(lastUrl), null, false);
    return;
  }
  const kindMsg = {
    direct: "Supported directly by yt-dlp.",
    embed: `Found ${res.sources.length} working server(s) via the browser fallback.`,
    manual: "Resolved your pasted URL.",
  }[res.kind] || "";
  setStatus(`${res.sources.length} source(s) ready. ${kindMsg}`, "ok");
  renderSources(res.sources);
}

// ---------- auth prompt ----------
// isAuth=true → site clearly needs login (show Sign in). Either way we offer
// "import from your browser" (the reliable path for TikTok etc. that block
// embedded logins or rate-limit repeated attempts).
function showAuthPrompt(site, loginUrl, isAuth) {
  setStatus(
    isAuth
      ? `${site} needs you to sign in before it will share this video.`
      : `No source found for ${site}. If it needs an account, sign in or import your browser session below.`,
    "error"
  );
  const wrap = $("sources");
  wrap.innerHTML = "";
  const card = el("div", "source-card auth-card");
  card.innerHTML = `
    <div class="auth-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <rect x="4" y="10.5" width="16" height="10" rx="2.2" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
      </svg>
    </div>
    <div class="source-meta">
      <div class="source-title">${isAuth ? "Sign in to " + esc(site) : "Needs an account?"}</div>
      <div class="source-sub"><span>Sign in here, or if you're <b>already signed in on your browser</b> import that session (best for TikTok):</span></div>
      <div class="auth-import">
        <span>Import login from</span>
        <select id="importSel">
          <option value="">choose browser…</option>
          <option value="firefox">Firefox (recommended)</option>
          <option value="chrome">Chrome (close it first)</option>
          <option value="edge">Edge (close it first)</option>
          <option value="brave">Brave (close it first)</option>
          <option value="opera">Opera (close it first)</option>
        </select>
      </div>
    </div>
    <div class="source-actions"></div>`;
  const btn = el("button", "primary", "Sign in");
  btn.onclick = () => window.api.openAccounts(loginUrl || "https://" + site);
  card.querySelector(".source-actions").appendChild(btn);
  card.querySelector("#importSel").onchange = (e) => {
    const b = e.target.value;
    if (!b) return;
    importBrowser = b;
    setStatus(`Importing your ${b} session and retrying…`, "busy");
    runDetect(lastUrl);
  };
  wrap.appendChild(card);
}

// ---------- sources ----------
function renderSources(sources) {
  const wrap = $("sources");
  wrap.innerHTML = "";
  sources.forEach((src, i) => {
    const card = el("div", "source-card");
    card.style.setProperty("--i", i);

    const thumb = el("img", "thumb");
    thumb.referrerPolicy = "no-referrer"; // TikTok/IG CDNs block hotlinked thumbnails with a referer
    thumb.onerror = () => { thumb.style.visibility = "hidden"; };
    if (src.thumbnail) thumb.src = src.thumbnail;
    card.appendChild(thumb);

    const meta = el("div", "source-meta");
    meta.appendChild(el("div", "source-title", esc(src.title)));
    const sub = el("div", "source-sub");
    sub.appendChild(el("span", "badge", esc(src.server)));
    if (src.duration) sub.appendChild(el("span", "mono", fmtDur(src.duration)));
    sub.appendChild(el("span", null, esc(src.extractor)));
    meta.appendChild(sub);
    card.appendChild(meta);

    const actions = el("div", "source-actions");
    const sel = el("select");
    src.qualities.forEach((q) => {
      const o = el("option");
      o.value = q.id;
      o.textContent = q.label;
      sel.appendChild(o);
    });
    actions.appendChild(sel);

    const btn = el("button", "primary", "Download");
    btn.onclick = () => {
      const q = src.qualities.find((x) => x.id === sel.value) || src.qualities[0];
      startDownload(src, q);
    };
    actions.appendChild(btn);
    card.appendChild(actions);

    wrap.appendChild(card);
  });
}

// ---------- downloads ----------
async function startDownload(src, q) {
  const { id, title } = await window.api.download({
    target: src.target,
    referer: src.referer,
    fmt: q.fmt,
    audio: !!q.audio,
    title: src.title,
    importBrowser: importBrowser || undefined,
  });
  addQueueItem(id, title || src.title, q.label);
}

function addQueueItem(id, title, quality) {
  $("queueEmpty").classList.add("hidden");
  const item = el("div", "qitem active");
  item.innerHTML = `
    <div class="qtop">
      <span class="qtitle"><span class="dot"></span>${esc(title)}</span>
      <span class="qstate" data-state>Starting…</span>
    </div>
    <div class="bar"><div class="bar-fill" data-bar></div></div>
    <div class="qbottom">
      <div class="qmeta mono"><span data-meta>${esc(quality)}</span></div>
      <div class="qactions"></div>
    </div>`;
  const actions = item.querySelector(".qactions");
  const cancelBtn = el("button", "mini danger", "Cancel");
  cancelBtn.onclick = () => window.api.cancel(id);
  actions.appendChild(cancelBtn);

  $("queue").prepend(item);
  queue.set(id, {
    el: item,
    state: item.querySelector("[data-state]"),
    bar: item.querySelector("[data-bar]"),
    meta: item.querySelector("[data-meta]"),
    actions,
    cancelBtn,
    quality,
    file: null,
  });
}

function handleDownloadEvent(e) {
  const q = queue.get(e.id);
  if (!q) return;
  switch (e.type) {
    case "start":
      q.state.textContent = "Connecting…";
      break;
    case "progress":
      q.bar.style.width = e.percent + "%";
      q.state.className = "qstate";
      q.state.textContent = e.percent.toFixed(1) + "%";
      q.meta.textContent = e.meta
        ? `${q.quality} · ${e.meta}`
        : `${q.quality} · ${e.size} · ${e.speed} · ETA ${e.eta}`;
      break;
    case "phase":
      q.state.className = "qstate " + e.phase;
      q.state.textContent = e.phase === "merging" ? "Merging…" : "Processing…";
      break;
    case "done":
      q.bar.style.width = "100%";
      q.state.className = "qstate done";
      q.state.textContent = "Done";
      q.el.classList.remove("active"); q.el.classList.add("done");
      q.file = e.file;
      finishItem(q, true);
      break;
    case "canceled":
      q.el.classList.remove("active"); q.el.classList.add("error");
      q.state.className = "qstate error";
      q.state.textContent = "Canceled";
      finishItem(q, false);
      break;
    case "error":
      q.el.classList.remove("active"); q.el.classList.add("error");
      q.state.className = "qstate error";
      q.state.textContent = "Error" + (e.code ? ` (${e.code})` : "");
      finishItem(q, false);
      break;
    case "log":
      appendLog("[" + e.id + "] " + e.line);
      break;
  }
}

function finishItem(q, ok) {
  q.cancelBtn.remove();
  if (ok) {
    const open = el("button", "mini", "Show file");
    open.onclick = () => window.api.revealFile(q.file);
    q.actions.appendChild(open);
    if (q.file) {
      const conv = el("button", "mini", "Convert");
      conv.onclick = () => convertDownloaded(q.file);
      q.actions.appendChild(conv);
    }
  } else {
    const retry = el("button", "mini", "Dismiss");
    retry.onclick = () => q.el.remove();
    q.actions.appendChild(retry);
  }
}

// ---------- wiring ----------
$("detectBtn").onclick = () => runDetect($("urlInput").value.trim());
$("urlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") runDetect($("urlInput").value.trim()); });
$("manualBtn").onclick = runManual;
$("advToggle").onclick = () => $("advanced").classList.toggle("hidden");
$("logToggle").onclick = () => {
  const open = $("log").classList.toggle("hidden");
  $("logChev").textContent = open ? "▾" : "▴";
};
$("changeDir").onclick = async () => {
  config.outDir = await window.api.pickFolder();
  $("outdirPath").textContent = config.outDir;
};
$("openDir").onclick = () => window.api.openFolder(config.outDir);
$("accountsBtn").onclick = () => window.api.openAccounts();

// ---------- convert ----------
let convFile = null;
let convFormat = "mp4";
function shortName(p) { return p.replace(/^.*[\\/]/, ""); }

const CONV_GROUPS = [
  { group: "Video", kind: "video", items: [
    { v: "mp4", label: "MP4", hint: "universal" },
    { v: "mkv", label: "MKV", hint: "lossless · instant" },
    { v: "mov", label: "MOV", hint: "Apple / QuickTime" },
    { v: "m4v", label: "M4V", hint: "Apple video" },
    { v: "webm", label: "WebM", hint: "web · re-encodes" },
    { v: "ts", label: "TS", hint: "transport stream" },
    { v: "flv", label: "FLV", hint: "flash" },
    { v: "avi", label: "AVI", hint: "legacy" },
    { v: "wmv", label: "WMV", hint: "Windows" },
    { v: "gif", label: "GIF", hint: "animation · no audio" },
  ] },
  { group: "Audio", kind: "audio", items: [
    { v: "mp3", label: "MP3", hint: "universal" },
    { v: "m4a", label: "M4A", hint: "AAC" },
    { v: "aac", label: "AAC", hint: "raw stream" },
    { v: "opus", label: "Opus", hint: "efficient" },
    { v: "ogg", label: "OGG", hint: "Vorbis" },
    { v: "wav", label: "WAV", hint: "lossless · large" },
    { v: "flac", label: "FLAC", hint: "lossless" },
    { v: "wma", label: "WMA", hint: "Windows" },
    { v: "aiff", label: "AIFF", hint: "Apple PCM" },
    { v: "ac3", label: "AC3", hint: "surround" },
  ] },
];

const ICONS = {
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>',
};

function kindOf(v) {
  for (const g of CONV_GROUPS) if (g.items.some((i) => i.v === v)) return g.kind;
  return "video";
}
function setConvFormat(v, label) {
  convFormat = v;
  const k = kindOf(v);
  $("convCurrent").textContent = label || v.toUpperCase();
  $("convDot").className = "dd-dot " + k;
  $("convDot").innerHTML = ICONS[k];
}
function buildConvMenu() {
  const menu = $("convMenu");
  menu.innerHTML = "";
  for (const g of CONV_GROUPS) {
    const head = el("div", "dd-group", `${ICONS[g.kind]}<span>${g.group}</span>`);
    head.classList.add(g.kind);
    menu.appendChild(head);
    for (const it of g.items) {
      const row = el("div", "dd-item");
      row.innerHTML = `<span class="dd-name">${it.label}</span><span class="dd-hint">${it.hint}</span>`;
      row.onclick = () => { setConvFormat(it.v, it.label); closeConvMenu(); };
      menu.appendChild(row);
    }
  }
}
function openConvMenu() { $("convMenu").classList.remove("hidden"); $("convDropdown").classList.add("open"); }
function closeConvMenu() { $("convMenu").classList.add("hidden"); $("convDropdown").classList.remove("open"); }
$("convFormatBtn").onclick = (e) => {
  e.stopPropagation();
  $("convMenu").classList.contains("hidden") ? openConvMenu() : closeConvMenu();
};
document.addEventListener("click", (e) => {
  if (!$("convDropdown").contains(e.target)) closeConvMenu();
});
buildConvMenu();
setConvFormat("mp4", "MP4");

$("pickFileBtn").onclick = async () => {
  const f = await window.api.pickFile();
  if (!f) return;
  convFile = f;
  $("pickFileLabel").textContent = shortName(f);
  $("convertBtn").disabled = false;
};
$("convertBtn").onclick = async () => {
  if (!convFile) return;
  const title = `${shortName(convFile)} → ${convFormat.toUpperCase()}`;
  const { id } = await window.api.convert({ input: convFile, format: convFormat, title });
  addQueueItem(id, title, "→ " + convFormat.toUpperCase());
};

// convert a just-downloaded file: prefill the picker and scroll to it
function convertDownloaded(file) {
  convFile = file;
  $("pickFileLabel").textContent = shortName(file);
  $("convertBtn").disabled = false;
  document.querySelector(".convert-panel").scrollIntoView({ behavior: "smooth", block: "center" });
}
$("clearDone").onclick = () => {
  for (const [id, q] of queue) {
    const s = q.state.textContent;
    if (s.includes("Done") || s.includes("Error") || s.includes("Canceled")) {
      q.el.remove();
      queue.delete(id);
    }
  }
  if (!queue.size) $("queueEmpty").classList.remove("hidden");
};
