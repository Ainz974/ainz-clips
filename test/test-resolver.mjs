// Smoke-test the real resolver module the app uses.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const resolver = require("../src/resolver.js");

const urls = [
  "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  "https://witanime.you/episode/one-piece-%d8%a7%d9%84%d8%ad%d9%84%d9%82%d8%a9-1168/",
];

for (const u of urls) {
  console.log("\n############ RESOLVE:", u);
  try {
    const res = await resolver.resolve(u, (l) => console.log("   ·", l));
    console.log("   KIND:", res.kind, "| SOURCES:", res.sources.length);
    res.sources.forEach((s) =>
      console.log(`     - [${s.server}] ${String(s.title).slice(0, 50)} | q:${s.qualities.map((q) => q.label).join(",")}`)
    );
  } catch (e) {
    console.log("   FAILED:", e.message);
  }
}
process.exit(0);
