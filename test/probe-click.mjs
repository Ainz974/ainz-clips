// Click each witanime server (loadIframe) and capture the resulting embed iframe URL.
import { chromium } from "playwright";

const url = process.argv[2];
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(2500);

// the server <a> elements that swap the player iframe
const servers = await page.$$eval('a[onclick*="loadIframe"]', (els) =>
  els.map((el) => ({ id: el.getAttribute("data-server-id"), name: (el.textContent || "").trim() }))
);
console.log("Servers found:", JSON.stringify(servers));

const results = [];
for (const s of servers) {
  const link = await page.$(`a[data-server-id="${s.id}"]`);
  if (!link) continue;
  await link.click().catch(() => {});
  await page.waitForTimeout(2500);
  // find the player iframe (skip ads/twitter)
  const src = await page.evaluate(() => {
    const fr = [...document.querySelectorAll("iframe")]
      .map((f) => f.src || f.getAttribute("data-src") || "")
      .filter((u) => u && !/a-ads|twitter|disqus|facebook/i.test(u));
    return fr[0] || "";
  });
  results.push({ server: s.name, embed: src });
  console.log(`  [${s.name}] -> ${src.slice(0, 110)}`);
}

await browser.close();
console.log("\n=== CAPTURED EMBEDS ===");
console.log(JSON.stringify(results, null, 2));
