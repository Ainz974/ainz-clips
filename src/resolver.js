// resolver.js — turn any page URL into a list of downloadable "sources".
//
// Layer 1: hand the URL straight to yt-dlp (-J dumps full JSON of formats).
// Layer 2: if yt-dlp says "Unsupported", drive a headless browser to find embed
//          iframes (mp4upload / videa / dailymotion / streamwish ...) and raw
//          .m3u8/.mpd media, then re-test each candidate with yt-dlp.
// Layer 3 (manual) is just Layer 1 applied to a URL the user pastes directly.

const { execFile } = require("node:child_process");
const path = require("node:path");
const { binDir } = require("./paths");

const ROOT = path.resolve(__dirname, "..");
const YTDLP = path.join(binDir(), "yt-dlp.exe");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// hosts yt-dlp usually supports when found as an embed iframe
const EMBED_HOSTS =
  /(mp4upload|ok\.ru|odnoklassniki|dood|streamtape|streamwish|hglink|swhoi|vidmoly|sendvid|uqload|voe|filemoon|vidhide|mixdrop|yourupload|vk\.com|videa\.hu|videas\.fr|dailymotion|sibnet|mega\.nz|fembed|vudeo|vidoza)/i;

function hostOf(u) {
  try {
    return new URL(u).origin + "/";
  } catch {
    return undefined;
  }
}

// Run yt-dlp -J and parse the JSON describing one video and its formats.
function ytJson(url, { referer, signal, cookiesFile, cookiesBrowser } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "--js-runtimes", "node",
      // expose YouTube's DASH 1440p/2160p/4320p formats (default clients cap at 1080p)
      "--extractor-args", "youtube:player_client=tv,web_safari,android_vr",
      // retry transient extraction failures (TikTok's first attempt often fails)
      "--extractor-retries", "3",
      "--retries", "3",
      "-J",
      "--no-playlist",
      "--no-warnings",
      "--user-agent", UA,
    ];
    // import from the user's real browser (for sites the in-app login can't beat, e.g. TikTok)
    if (cookiesBrowser) args.push("--cookies-from-browser", cookiesBrowser);
    else if (cookiesFile) args.push("--cookies", cookiesFile);
    if (referer) args.push("--referer", referer);
    args.push(url);
    execFile(
      YTDLP,
      args,
      { maxBuffer: 128 * 1024 * 1024, timeout: 90000, signal, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split("\n").pop()));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error("yt-dlp returned non-JSON output"));
        }
      }
    );
  });
}

// Collapse yt-dlp's raw format list into clean quality choices for the UI.
function buildQualities(info) {
  const fmts = Array.isArray(info.formats) ? info.formats : [];
  const heights = new Set();
  let hasAudio = false;
  for (const f of fmts) {
    if (f.vcodec && f.vcodec !== "none" && f.height) heights.add(f.height);
    if (f.acodec && f.acodec !== "none") hasAudio = true;
  }
  const sorted = [...heights].sort((a, b) => b - a);
  // "Best" prefers H.264/AAC → downloads as a ready-to-use mp4 in ONE step (no
  // re-encode). Explicit 1440p/2160p options stay VP9/AV1 and get re-encoded.
  const qualities = [{
    label: "Best (ready mp4)",
    id: "best",
    fmt: "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1]/bv*[ext=mp4]+ba/bv*+ba/b",
  }];
  for (const h of sorted) {
    qualities.push({
      label: `${h}p`,
      id: `h${h}`,
      fmt: `bv*[height<=${h}]+ba/b[height<=${h}]`,
    });
  }
  if (hasAudio || !sorted.length) {
    qualities.push({ label: "Audio only (mp3)", id: "audio", fmt: "ba/b", audio: true });
  }
  return qualities;
}

function infoToSource(serverName, target, referer, info) {
  return {
    server: serverName,
    target,                 // URL we actually hand to yt-dlp for download
    referer: referer || null,
    title: info.title || info.id || target,
    duration: info.duration || null,
    thumbnail: info.thumbnail || null,
    extractor: info.extractor_key || info.extractor || "generic",
    qualities: buildQualities(info),
  };
}

// ---- Layer 2: browser sniff --------------------------------------------------

async function sniffPage(url, log = () => {}, cookiesArr = null) {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    throw new Error("Playwright not installed — browser fallback unavailable");
  }
  // Prefer Microsoft Edge (present on every Windows machine) so we don't have to
  // bundle Playwright's Chromium; fall back to a bundled/installed Chromium.
  const browser = await chromium
    .launch({ headless: true, channel: "msedge" })
    .catch(() => chromium.launch({ headless: true }));
  try {
    const ctx = await browser.newContext({ userAgent: UA });
    // act as the logged-in user so private / login-walled media is reachable
    if (cookiesArr && cookiesArr.length) {
      await ctx.addCookies(cookiesArr).catch(() => {});
    }
    const page = await ctx.newPage();

    const media = new Set();
    const wantMedia = /\.(m3u8|mpd)(\?|$)|\/manifest|videoplayback|\.mp4(\?|$)/i;
    const watch = (u) => {
      if (wantMedia.test(u) && !/a-ads|doubleclick|googlesync/i.test(u)) media.add(u);
    };
    page.on("request", (r) => watch(r.url()));
    page.on("response", (r) => watch(r.url()));

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1200);

    // Find candidate "server switch" controls and click each to force its iframe to load.
    const switches = await page
      .$$eval(
        'a[onclick], a[data-server-id], li[data-server-id], [data-index], .server, .serversList a',
        (els) =>
          els
            .map((el, i) => ({
              i,
              name: (el.textContent || "").trim().slice(0, 40),
              sid: el.getAttribute("data-server-id"),
              onclick: el.getAttribute("onclick") || "",
            }))
            .filter((e) => /loadIframe|server|player|watch|embed|mp4|stream|dood|ok|videa|daily/i.test(e.onclick + e.name))
      )
      .catch(() => []);

    const embeds = new Map(); // embedUrl -> serverName

    const grabFrames = (fallbackName) => {
      for (const f of page.frames()) {
        const u = f.url();
        if (u && u !== "about:blank" && u !== url && !/a-ads|twitter|disqus|facebook|google/i.test(u)) {
          if (!embeds.has(u)) embeds.set(u, fallbackName);
        }
      }
    };

    if (switches.length) {
      log(`found ${switches.length} server button(s)`);
      for (const s of switches) {
        const el = s.sid
          ? await page.$(`[data-server-id="${s.sid}"]`)
          : (await page.$$('a[onclick], [data-index]'))[s.i];
        if (!el) continue;
        await el.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(1500);
        grabFrames(s.name || "server");
      }
    } else {
      // simple sites: just take whatever iframes/players exist
      await page.waitForTimeout(2000);
      grabFrames("embed");
    }

    return {
      embeds: [...embeds.entries()].map(([embed, server]) => ({ embed, server })),
      media: [...media],
    };
  } finally {
    await browser.close();
  }
}

// ---- public API --------------------------------------------------------------

// errors that mean "you need to be signed in to this site"
const AUTH_ERR =
  /log ?in|sign ?in|private|empty media response|requested content is not available|members?-only|registered users|authenticat|use --cookies|age.?restrict|confirm your age|confirm you'?re not a bot|sign in to confirm|account is required|this video is unavailable/i;

// sites that gate content behind login — a sniffed "raw stream" is unreliable here
const AUTH_SITES = /(^|\.)(tiktok|instagram|facebook|fb\.watch|twitter|x)\.com$/i;

function siteName(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

// Resolve a page URL into { kind, sources[] }.
async function resolve(url, log = () => {}, opts = {}) {
  const cookiesFile = opts.cookiesFile || null;
  const cookiesArr = opts.cookiesArr || null;
  const cookiesBrowser = opts.cookiesBrowser || null;
  // browser import wins (used for sites the in-app login can't handle)
  const ck = cookiesBrowser ? { cookiesBrowser } : cookiesFile ? { cookiesFile } : {};
  const isAuthSite = AUTH_SITES.test(siteName(url));
  let authHint = false;

  // Layer 1 — retry for login-gated sites (TikTok often fails the first attempt,
  // then succeeds; retrying makes the clean result appear immediately instead of
  // the user waiting minutes and seeing an unreliable "raw stream" first).
  const attempts = isAuthSite ? 3 : 1;
  for (let i = 0; i < attempts; i++) {
    log(i === 0 ? "trying yt-dlp directly…" : `retrying extraction (${i + 1}/${attempts})…`);
    try {
      const info = await ytJson(url, ck);
      log("yt-dlp recognized the site (Layer 1)");
      return { kind: "direct", sources: [infoToSource(info.extractor_key || "direct", url, null, info)] };
    } catch (e) {
      log(`Layer 1 attempt ${i + 1} failed: ${e.message}`);
      if (AUTH_ERR.test(e.message) || isAuthSite) authHint = true;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Login-gated sites: their sniffed "raw streams" are unreliable / expiring
  // signed fragments. Never offer them — send the user to sign-in / import.
  if (isAuthSite) {
    return { kind: "auth", site: siteName(url), loginUrl: hostOf(url), sources: [] };
  }

  // Layer 2
  log("launching browser to sniff embeds (Layer 2)…");
  const { embeds, media } = await sniffPage(url, log, cookiesArr);

  // prefer known embed hosts first, then raw manifests
  const ordered = [
    ...embeds.filter((e) => EMBED_HOSTS.test(e.embed)),
    ...embeds.filter((e) => !EMBED_HOSTS.test(e.embed)),
  ];
  log(`captured ${ordered.length} embed(s), ${media.length} raw media URL(s)`);

  // Test every candidate concurrently — this is the big speed win vs the old
  // one-at-a-time loop (was ~N×, now ~1× the slowest probe).
  const ref = hostOf(url);
  const embedJobs = ordered.map((em) =>
    ytJson(em.embed, { referer: ref, ...ck })
      .then((info) => {
        log(`✓ ${em.server}: downloadable`);
        return infoToSource(em.server || info.extractor_key, em.embed, ref, info);
      })
      .catch((e) => {
        log(`✗ ${em.server}: ${e.message}`);
        return null;
      })
  );
  // dedupe raw streams (same path with different query params is the same stream)
  // and cap them — they're a bonus fallback, the embeds above are the real sources.
  const seenPaths = new Set();
  const uniqMedia = media.filter((m) => {
    const key = m.split("?")[0];
    if (seenPaths.has(key)) return false;
    seenPaths.add(key);
    return true;
  }).slice(0, 4);
  const mediaJobs = uniqMedia.map((m) =>
    ytJson(m, { referer: ref, ...ck })
      .then((info) => {
        log(`✓ raw stream: downloadable`);
        return infoToSource("raw stream", m, ref, info);
      })
      .catch(() => null)
  );

  const embedResults = (await Promise.all(embedJobs)).filter(Boolean);
  const rawResults = (await Promise.all(mediaJobs)).filter(Boolean);

  // Real embed-host sources (videa, dailymotion, …) are trustworthy.
  if (embedResults.length) {
    return { kind: "embed", sources: [...embedResults, ...rawResults], rawMedia: media };
  }
  // Raw streams sniffed off an auth-walled page are usually broken signed-URL
  // fragments (download as 0 bytes). Don't offer them — prompt sign-in instead.
  if (authHint) {
    return { kind: "auth", site: siteName(url), loginUrl: hostOf(url), sources: [] };
  }
  if (rawResults.length) {
    return { kind: "embed", sources: rawResults, rawMedia: media };
  }
  return { kind: "none", sources: [], rawMedia: media };
}

// Layer 3: user pasted a stream/embed URL directly.
async function resolveManual(url, referer, log = () => {}, opts = {}) {
  log("resolving pasted URL…");
  const info = await ytJson(url, { referer: referer || undefined, cookiesFile: opts.cookiesFile || undefined, cookiesBrowser: opts.cookiesBrowser || undefined });
  return {
    kind: "manual",
    sources: [infoToSource("manual", url, referer || null, info)],
  };
}

module.exports = { resolve, resolveManual, ytJson, buildQualities, YTDLP, ROOT };
