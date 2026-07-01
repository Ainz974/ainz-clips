import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const r = require("../src/resolver.js");
const url = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"; // Big Buck Bunny — has up to 4K
const res = await r.resolve(url, (l) => console.log("  ", l), "firefox");
if (!res.sources.length) { console.log("no sources"); process.exit(1); }
const q = res.sources[0].qualities.map((x) => x.label);
console.log("\nTitle:", res.sources[0].title);
console.log("Quality list:", q.join(", "));
console.log(q.some((x) => x.startsWith("2160")) ? "\n✅ 4K (2160p) IS available in the dropdown" : "\n✗ no 2160p found");
process.exit(0);
