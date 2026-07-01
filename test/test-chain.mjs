// Test harness for the download fallback chain.
// Layer 1: yt-dlp direct.  Layer 2: browser network-sniff for .m3u8/.mpd, then hand to yt-dlp.
// Usage: node test/test-chain.mjs "<url>"

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const YTDLP = path.join(ROOT, "bin", "yt-dlp.exe");
const FFMPEG = path.join(ROOT, "bin", "ffmpeg.exe");
const OUT = path.join(ROOT, "downloads");

const url = process.argv[2];
if (!url) {
  console.error('Usage: node test/test-chain.mjs "<url>"');
  process.exit(1);
}

const ytArgs = (target) => [
  "--ffmpeg-location", FFMPEG,
  "-o", path.join(OUT, "%(title).80s.%(ext)s"),
  "--no-playlist",
  "--newline",
  target,
];

// Layer 1: try yt-dlp straight on the page URL.
async function layer1() {
  console.log("\n[Layer 1] yt-dlp direct on:", url);
  try {
    const { stdout } = await execFileP(YTDLP, ["-g", "--no-playlist", url], { timeout: 60000 });
    console.log("  ✓ yt-dlp recognizes it. Stream URL(s):");
    console.log("   ", stdout.trim().split("\n").join("\n    "));
    return true;
  } catch (e) {
    console.log("  ✗ yt-dlp could not resolve directly:", (e.stderr || e.message).trim().split("\n").pop());
    return false;
  }
}

// Layer 2: drive a real browser. Collect BOTH embed-iframe URLs (often yt-dlp-supported
// hosts) AND raw media manifests sniffed from network traffic.
async function layer2() {
  console.log("\n[Layer 2] launching headless browser to sniff embeds + media URLs...");
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.log("  ! playwright not installed yet — skipping. (npm i playwright && npx playwright install chromium)");
    return null;
  }
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const page = await ctx.newPage();

  const media = new Set();
  const wantMedia = /\.(m3u8|mpd)(\?|$)|\/manifest|videoplayback|\.mp4(\?|$)/i;
  const watch = (u) => { if (wantMedia.test(u)) media.add(u); };
  page.on("request", (r) => watch(r.url()));
  page.on("response", (r) => watch(r.url()));

  // known embed hosts that yt-dlp usually supports
  const embedHosts = /(mp4upload|ok\.ru|odnoklassniki|dood|streamtape|streamwish|vidmoly|sendvid|uqload|voe|filemoon|vidhide|mixdrop|yourupload|vk\.com)/i;

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2000);
    // try clicking a play/server button to force the iframe to load
    for (const sel of ["button[aria-label*=play i]", ".play", "#player", "video", ".server", "li[data-ep-url]"]) {
      const el = await page.$(sel);
      if (el) { await el.click({ timeout: 2000 }).catch(() => {}); break; }
    }
    await page.waitForTimeout(4000);
  } catch (e) {
    console.log("  ! navigation issue:", e.message);
  }

  // collect iframe srcs across all frames
  const iframes = new Set();
  for (const f of page.frames()) {
    const u = f.url();
    if (u && u !== "about:blank" && u !== url) iframes.add(u);
  }
  await browser.close();

  const embeds = [...iframes].filter((u) => embedHosts.test(u));
  const otherFrames = [...iframes].filter((u) => !embedHosts.test(u));
  const mediaList = [...media];

  if (embeds.length) {
    console.log(`  ✓ found ${embeds.length} known-host embed(s) (yt-dlp can likely take these):`);
    embeds.forEach((u) => console.log("    →", u.slice(0, 120)));
  }
  if (otherFrames.length) {
    console.log(`  · ${otherFrames.length} other iframe(s):`);
    otherFrames.forEach((u) => console.log("    ·", u.slice(0, 100)));
  }
  if (mediaList.length) {
    console.log(`  ✓ sniffed ${mediaList.length} raw media URL(s):`);
    mediaList.forEach((u) => console.log("    -", u.slice(0, 120)));
  }
  if (!embeds.length && !mediaList.length && !otherFrames.length) {
    console.log("  ✗ nothing useful captured.");
    return null;
  }
  // priority: known embed host > raw m3u8/mpd > other frame > any media
  return embeds[0]
    || mediaList.find((u) => /\.(m3u8|mpd)/i.test(u))
    || otherFrames[0]
    || mediaList[0]
    || null;
}

(async () => {
  const ok = await layer1();
  if (ok) {
    console.log("\n→ Verdict: Layer 1 sufficient. Real download would run now (skipped in test).");
    return;
  }
  const captured = await layer2();
  if (!captured) {
    console.log("\n→ Verdict: needs Layer 3 (manual stream paste). Site is stubborn.");
    return;
  }
  console.log("\n[Layer 2b] handing captured URL back to yt-dlp:", captured.slice(0, 90));
  try {
    const { stdout } = await execFileP(YTDLP, ["--js-runtimes", "node", "-g", "--no-playlist", captured], { timeout: 60000 });
    console.log("  ✓✓ yt-dlp resolved the captured URL. Download is possible. Stream:");
    console.log("   ", stdout.trim().split("\n")[0].slice(0, 120));
    console.log("\n→ Verdict: Layer 2 SUCCESS — site downloadable via embed/stream handoff.");
  } catch (e) {
    console.log("  ✗ yt-dlp could not take the captured URL:", (e.stderr || e.message).trim().split("\n").pop());
    console.log("\n→ Verdict: captured a candidate but needs Layer 3 / custom handling.");
  }
})();
