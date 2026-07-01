import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const conv = require("../src/converter.js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const input = process.argv[2];
const format = process.argv[3] || "mp3";
if (!fs.existsSync(input)) { console.log("input not found:", input); process.exit(1); }

let ticks = 0;
conv.start({
  id: "t1", input, format,
  onEvent: (e) => {
    if (e.type === "progress") { ticks++; if (ticks % 4 === 0) console.log(`  ${e.percent.toFixed(1)}% | ${e.meta}`); }
    else console.log("EVENT:", JSON.stringify(e));
    if (["done", "error", "canceled"].includes(e.type)) {
      if (e.type === "done") {
        const kb = fs.existsSync(e.file) ? Math.round(fs.statSync(e.file).size / 1024) : 0;
        console.log(`\nticks:${ticks} | output: ${path.basename(e.file)} (${kb} KB)`);
        console.log(kb > 0 ? "✅ CONVERT OK" : "✗ empty output");
      }
      process.exit(e.type === "done" ? 0 : 1);
    }
  },
});
