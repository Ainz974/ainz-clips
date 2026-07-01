import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const r = require("../src/resolver.js");
const url = process.argv[2] || "https://witanime.you/episode/one-piece-%d8%a7%d9%84%d8%ad%d9%84%d9%82%d8%a9-1168/";
const t = Date.now();
const res = await r.resolve(url);
console.log("sources:", res.sources.length, "| time:", ((Date.now() - t) / 1000).toFixed(1) + "s");
process.exit(0);
