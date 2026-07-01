// converter.js — convert a local media file to another format via ffmpeg.
// Smart strategy: probe the source codecs and STREAM-COPY (`-c copy`) whenever the
// codec already fits the target container — that is lossless (identical quality)
// AND instant (no re-encode). Only re-encode the streams that genuinely must change.
// Emits the same event shape as downloader.js so convert jobs share the queue UI.

const { spawn, execFile } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const FFMPEG = path.join(ROOT, "bin", "ffmpeg.exe");
const FFPROBE = path.join(ROOT, "bin", "ffprobe.exe");

// For each target: which source codecs can be COPIED into it (lossless+instant),
// and the encoder to fall back to when a stream must be converted.
const FORMATS = {
  // ---- video containers ----
  mp4:  { type: "video", vok: ["h264", "hevc", "mpeg4", "av1"], aok: ["aac", "mp3", "ac3"], venc: ["libx264", "-preset", "veryfast", "-crf", "18"], aenc: ["aac", "-b:a", "192k"], extra: ["-movflags", "+faststart"] },
  mkv:  { type: "video", any: true }, // Matroska holds virtually anything → always copy
  mov:  { type: "video", vok: ["h264", "hevc", "prores", "mpeg4"], aok: ["aac", "mp3", "pcm_s16le"], venc: ["libx264", "-preset", "veryfast", "-crf", "18"], aenc: ["aac", "-b:a", "192k"], extra: ["-movflags", "+faststart"] },
  m4v:  { type: "video", vok: ["h264", "hevc"], aok: ["aac"], venc: ["libx264", "-preset", "veryfast", "-crf", "18"], aenc: ["aac", "-b:a", "192k"], extra: ["-movflags", "+faststart"] },
  webm: { type: "video", vok: ["vp8", "vp9", "av1"], aok: ["opus", "vorbis"], venc: ["libvpx-vp9", "-b:v", "0", "-crf", "30", "-row-mt", "1"], aenc: ["libopus", "-b:a", "160k"] },
  ts:   { type: "video", vok: ["h264", "hevc", "mpeg2video"], aok: ["aac", "mp3", "ac3"], venc: ["libx264", "-preset", "veryfast", "-crf", "18"], aenc: ["aac", "-b:a", "192k"] },
  flv:  { type: "video", vok: ["h264"], aok: ["aac", "mp3"], venc: ["libx264", "-preset", "veryfast", "-crf", "18"], aenc: ["aac", "-b:a", "192k"] },
  avi:  { type: "video", vok: ["mpeg4", "mjpeg", "h264"], aok: ["mp3", "ac3", "pcm_s16le"], venc: ["libx264", "-preset", "veryfast", "-crf", "18"], aenc: ["libmp3lame", "-q:a", "2"] },
  wmv:  { type: "video", vok: ["wmv1", "wmv2", "wmv3"], aok: ["wmav2"], venc: ["wmv2"], aenc: ["wmav2", "-b:a", "192k"] },
  gif:  { type: "video", special: ["-vf", "fps=12,scale=480:-1:flags=lanczos", "-loop", "0"], noAudio: true },
  // ---- audio containers ----
  mp3:  { type: "audio", aok: ["mp3"], aenc: ["libmp3lame", "-q:a", "2"] },
  m4a:  { type: "audio", aok: ["aac", "alac"], aenc: ["aac", "-b:a", "192k"] },
  aac:  { type: "audio", aok: ["aac"], aenc: ["aac", "-b:a", "192k"] },
  wav:  { type: "audio", aok: ["pcm_s16le", "pcm_s24le"], aenc: ["pcm_s16le"] },
  flac: { type: "audio", aok: ["flac"], aenc: ["flac"] },
  ogg:  { type: "audio", aok: ["vorbis"], aenc: ["libvorbis", "-q:a", "5"] },
  opus: { type: "audio", aok: ["opus"], aenc: ["libopus", "-b:a", "160k"] },
  wma:  { type: "audio", aok: ["wmav2"], aenc: ["wmav2", "-b:a", "192k"] },
  aiff: { type: "audio", aok: ["pcm_s16be"], aenc: ["pcm_s16be"] },
  ac3:  { type: "audio", aok: ["ac3"], aenc: ["ac3", "-b:a", "192k"] },
};

const jobs = new Map();
const hms = (h, m, s) => (+h) * 3600 + (+m) * 60 + parseFloat(s);
const DUR = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/;
const TIME = /time=(\d+):(\d+):(\d+\.\d+)/;
const SPEED = /speed=\s*([\d.]+x)/;

// probe first video + audio codec of the source
function probe(input) {
  return new Promise((resolve) => {
    execFile(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", input],
      { maxBuffer: 1 << 20, windowsHide: true }, (err, stdout) => {
        let v = null, a = null;
        try {
          for (const s of (JSON.parse(stdout).streams || [])) {
            if (s.codec_type === "video" && !v) v = s.codec_name;
            if (s.codec_type === "audio" && !a) a = s.codec_name;
          }
        } catch {}
        resolve({ v, a });
      });
  });
}

// Build ffmpeg output args, copying whatever streams already fit the target.
// Returns { args, copied } where copied=true means fully lossless+instant.
async function buildArgs(format, input) {
  const spec = FORMATS[format];
  if (spec.special) return { args: spec.special, copied: false };
  const { v, a } = await probe(input);
  if (spec.type === "audio") {
    const copyA = a && spec.aok.includes(a);
    return { args: ["-vn", "-c:a", ...(copyA ? ["copy"] : spec.aenc)], copied: copyA };
  }
  if (spec.any) return { args: ["-c", "copy"], copied: true };
  const args = [];
  const copyV = v && spec.vok.includes(v);
  args.push("-c:v", ...(copyV ? ["copy"] : spec.venc));
  let copyA = true;
  if (a) {
    copyA = spec.aok.includes(a);
    args.push("-c:a", ...(copyA ? ["copy"] : spec.aenc));
  }
  if (spec.extra) args.push(...spec.extra);
  return { args, copied: copyV && copyA };
}

function outputPath(input, format) {
  const dir = path.dirname(input);
  const base = path.basename(input, path.extname(input));
  let out = path.join(dir, `${base}.${format}`);
  let n = 1;
  while (fs.existsSync(out)) out = path.join(dir, `${base} (${n++}).${format}`);
  return out;
}

// opts: { id, input, format, onEvent }
async function start(opts) {
  const { id, input, format, onEvent } = opts;
  const emit = (e) => onEvent({ id, ...e });
  const spec = FORMATS[format];
  if (!spec) { emit({ type: "error", message: "unknown format" }); return; }
  if (!fs.existsSync(input)) { emit({ type: "error", message: "file not found" }); return; }

  const out = outputPath(input, format);
  const { args: fmtArgs, copied } = await buildArgs(format, input);
  // -threads 0 = use all cores; copy path ignores it and is near-instant anyway
  const args = ["-y", "-i", input, "-threads", "0", ...fmtArgs, out];
  const child = spawn(FFMPEG, args, { windowsHide: true });
  jobs.set(id, child);
  emit({ type: "start", target: out, copied });

  let total = 0, buf = "";
  const handle = (text) => {
    let m;
    if (!total && (m = DUR.exec(text))) total = hms(m[1], m[2], m[3]);
    if ((m = TIME.exec(text))) {
      const cur = hms(m[1], m[2], m[3]);
      const pct = total ? Math.min(99.5, (cur / total) * 100) : 0;
      const sp = SPEED.exec(text);
      const label = copied ? "remuxing (lossless)" : "converting";
      emit({ type: "progress", phase: "converting", percent: pct, meta: sp ? `${label} · ${sp[1]}` : label });
    }
  };
  child.stderr.on("data", (c) => {
    buf += c.toString();
    const parts = buf.split(/[\r\n]+/);
    buf = parts.pop();
    for (const p of parts) handle(p);
  });
  child.on("close", (code) => {
    jobs.delete(id);
    if (code === 0) emit({ type: "done", file: out });
    else if (code === null) emit({ type: "canceled" });
    else emit({ type: "error", code });
  });
  child.on("error", (err) => { jobs.delete(id); emit({ type: "error", message: err.message }); });
}

function cancel(id) {
  const c = jobs.get(id);
  if (c) { c.kill("SIGKILL"); jobs.delete(id); return true; }
  return false;
}

module.exports = { start, cancel, FORMATS };
