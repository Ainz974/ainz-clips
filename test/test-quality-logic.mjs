// Unit test: prove buildQualities exposes 4K/8K when the source offers it (no cap).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { buildQualities } = require("../src/resolver.js");

// mock a source that offers 144p → 8K, like a 4K/8K YouTube video
const mock = {
  formats: [
    { vcodec: "av01", height: 4320, format_note: "8K" },
    { vcodec: "vp09", height: 2160, format_note: "4K" },
    { vcodec: "avc1", height: 1440 },
    { vcodec: "avc1", height: 1080 },
    { vcodec: "avc1", height: 720 },
    { vcodec: "none", acodec: "mp4a", abr: 128 }, // audio-only
  ],
};
const qs = buildQualities(mock);
console.log("Dropdown would show:", qs.map((q) => q.label).join(", "));
const has4k = qs.find((q) => q.label === "2160p");
const has8k = qs.find((q) => q.label === "4320p");
console.log("\n2160p (4K):", has4k ? `YES → yt-dlp format "${has4k.fmt}"` : "missing");
console.log("4320p (8K):", has8k ? `YES → yt-dlp format "${has8k.fmt}"` : "missing");
console.log(has4k && has8k ? "\n✅ No quality cap — 4K and 8K both selectable when the source has them." : "\n✗ capped");
