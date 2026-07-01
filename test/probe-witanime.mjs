// Probe: understand witanime episode DOM — where are the server buttons / embed links?
import { chromium } from "playwright";

const url = process.argv[2];
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(3000);

const info = await page.evaluate(() => {
  const out = { servers: [], dataAttrs: [], iframes: [], videos: [] };
  // anything that looks like a server/quality switch
  document.querySelectorAll("a, li, button, span").forEach((el) => {
    const t = (el.textContent || "").trim().slice(0, 40);
    const attrs = {};
    for (const a of el.attributes) {
      if (/data-|onclick|href/i.test(a.name) && a.value && a.value.length < 300) attrs[a.name] = a.value;
    }
    const hasData = Object.keys(attrs).some((k) => /data-/i.test(k));
    if (hasData || /server|سيرفر|مشاهدة|تحميل|watch|download|jodvd|mp4|dood|ok|stream/i.test(t)) {
      if (Object.keys(attrs).length) out.servers.push({ tag: el.tagName, text: t, attrs });
    }
  });
  document.querySelectorAll("iframe").forEach((f) => out.iframes.push(f.src || f.getAttribute("data-src") || ""));
  document.querySelectorAll("video, video source").forEach((v) => out.videos.push(v.src || v.currentSrc || ""));
  return out;
});

console.log("=== IFRAMES ===");
console.log(info.iframes);
console.log("\n=== VIDEO tags ===");
console.log(info.videos);
console.log("\n=== SERVER-ish elements (first 25) ===");
info.servers.slice(0, 25).forEach((s) => console.log(JSON.stringify(s)));
console.log(`\n(total server-ish: ${info.servers.length})`);
await browser.close();
