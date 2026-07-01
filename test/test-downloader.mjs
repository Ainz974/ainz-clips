// Smoke-test downloader.js — confirm progress/phase/done events fire on a real download.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const dl = require("../src/downloader.js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let progressTicks = 0;
const seen = new Set();

dl.start({
  id: "test1",
  target: "https://www.bilibili.tv/en/video/4788102914120198", // 19s clip
  referer: null,
  fmt: "bv*[height<=240]+ba/b[height<=240]",
  audio: false,
  outDir: path.join(ROOT, "downloads"),
  onEvent: (e) => {
    seen.add(e.type);
    if (e.type === "progress") {
      progressTicks++;
      if (progressTicks % 5 === 0) console.log(`  progress: ${e.percent}% | ${e.speed} | phase=${e.phase}`);
    } else {
      console.log("EVENT:", JSON.stringify(e));
    }
    if (e.type === "done" || e.type === "error" || e.type === "canceled") {
      console.log("\nEvent types seen:", [...seen].join(", "));
      console.log("Progress ticks:", progressTicks);
      console.log(e.type === "done" ? "✓ DOWNLOADER OK — file: " + e.file : "✗ ended: " + e.type);
      process.exit(e.type === "done" ? 0 : 1);
    }
  },
});
