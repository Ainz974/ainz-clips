// downloader.js — spawn yt-dlp for one job and stream progress back to the UI.

const { spawn, execFile } = require("node:child_process");
const path = require("node:path");

const fs = require("node:fs");
const { binDir } = require("./paths");
const BIN = binDir();
const YTDLP = path.join(BIN, "yt-dlp.exe");
const FFMPEG = path.join(BIN, "ffmpeg.exe");
const FFPROBE = path.join(BIN, "ffprobe.exe");
const ARIA2 = path.join(BIN, "aria2c.exe");
const HAS_ARIA2 = fs.existsSync(ARIA2);

// Editors (Premiere, CapCut, DaVinci…) reject VP9/AV1 even inside an .mp4.
// After a video download, if the codec isn't H.264, re-encode to H.264/AAC so
// the file imports everywhere. H.264 sources (≤1080p) are left untouched (fast).
const hms = (h, m, s) => (+h) * 3600 + (+m) * 60 + parseFloat(s);
function ensureH264(file, emit) {
  return new Promise((resolve) => {
    if (!fs.existsSync(file)) return resolve(file);
    execFile(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,duration", "-of", "default=nw=1", file],
      { windowsHide: true }, (err, out) => {
        const codec = (/codec_name=(\S+)/.exec(out || "") || [])[1] || "";
        const dur = parseFloat((/duration=([\d.]+)/.exec(out || "") || [])[1]) || 0;
        if (!codec || /^(h264|avc)/i.test(codec)) return resolve(file); // already compatible
        emit({ type: "phase", phase: "converting" });
        const tmp = file.replace(/\.mp4$/i, ".h264.mp4");
        const cc = spawn(FFMPEG, [
          "-y", "-i", file, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
          "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmp,
        ], { windowsHide: true });
        let buf = "";
        cc.stderr.on("data", (c) => {
          buf += c.toString();
          const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(buf);
          if (m && dur) {
            const pct = Math.min(99, (hms(m[1], m[2], m[3]) / dur) * 100);
            emit({ type: "progress", phase: "converting", percent: pct, meta: "converting to H.264" });
          }
          buf = buf.slice(-2000);
        });
        cc.on("close", (code) => {
          if (code === 0 && fs.existsSync(tmp)) {
            try { fs.unlinkSync(file); fs.renameSync(tmp, file); } catch {}
          } else { try { fs.unlinkSync(tmp); } catch {} }
          resolve(file);
        });
        cc.on("error", () => resolve(file));
      });
  });
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// native yt-dlp downloader:  [download]  53.2% of  120.45MiB at  2.10MiB/s ETA 00:42
const PROG = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)\s+ETA\s+([\d:]+)/;
// aria2c readout:  [#a8d5e1 8.0MiB/50MiB(16%) CN:16 DL:5.2MiB ETA:8s]
const ARIA_PROG = /\[#\w+\s+[\d.]+\w*B\/([\d.]+\w*B)\((\d+)%\)(?:\s+CN:\d+)?\s+DL:([\d.]+\w*B)(?:\s+ETA:(\S+?))?\]/;
const DEST = /\[(?:download|Merger)\][^"]*Destination:\s*(.+)\s*$/;
const MERGE = /\[Merger\]\s+Merging formats into\s+"(.+)"/;
const FINAL = /\[(?:ExtractAudio|VideoConvertor|Merger)\]/;

const jobs = new Map(); // id -> child process

// strip characters Windows forbids in filenames
function sanitize(name) {
  return (name || "video")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "video";
}
// same base name + " (n)" so re-downloads never overwrite or get skipped
function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}.${ext}`);
  let n = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${base} (${n++}).${ext}`);
  return p;
}

// opts: { id, target, referer, fmt, audio, outDir, cookiesFile, title, onEvent }
function start(opts) {
  const { id, target, referer, fmt, audio, outDir, cookiesFile, cookiesBrowser, title, onEvent } = opts;
  const ext = audio ? "mp3" : "mp4";
  const outPath = uniquePath(outDir, sanitize(title), ext);
  const args = [
    "--js-runtimes", "node",
    // expose YouTube's DASH 1440p/2160p/4320p formats (default clients cap at 1080p)
    "--extractor-args", "youtube:player_client=tv,web_safari,android_vr",
    "--ffmpeg-location", FFMPEG,
    "--no-playlist",
    "--newline",
    "--no-warnings",
    "--user-agent", UA,
    "-o", outPath,
    // embed the poster + metadata so the file carries a cover image
    "--embed-thumbnail", "--embed-metadata",
    // speed: download HLS/DASH fragments in parallel
    "--concurrent-fragments", "16",
  ];
  // speed: use aria2c (multi-connection) for direct http(s) downloads
  if (HAS_ARIA2) {
    args.push(
      "--downloader", "http,https:aria2c",
      "--downloader-args", "aria2c:-x16 -s16 -k1M -j16 --summary-interval=1 --console-log-level=warn"
    );
  }
  if (cookiesBrowser) args.push("--cookies-from-browser", cookiesBrowser);
  else if (cookiesFile) args.push("--cookies", cookiesFile);
  if (referer) args.push("--referer", referer);
  if (audio) {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    if (fmt) args.push("-f", fmt);
  } else if (fmt) {
    // at a given resolution prefer H.264/AAC — Windows can make thumbnails for
    // those (unlike VP9/webm), so the file shows the video frame not a player icon
    args.push("-f", fmt, "--merge-output-format", "mp4", "-S", "res,vcodec:h264,acodec:aac");
  }
  args.push(target);

  const child = spawn(YTDLP, args, { windowsHide: true });
  jobs.set(id, child);
  let lastFile = outPath; // we control the exact output name now
  let phase = "downloading";

  const emit = (e) => onEvent({ id, ...e });
  emit({ type: "start", target });

  const handleLine = (line) => {
    const text = line.trim();
    if (!text) return;
    let m;
    if ((m = MERGE.exec(text))) {
      phase = "merging";
      lastFile = m[1];
      emit({ type: "phase", phase: "merging" });
    } else if ((m = DEST.exec(text))) {
      lastFile = m[1].trim();
    } else if ((m = PROG.exec(text))) {
      emit({
        type: "progress",
        phase,
        percent: parseFloat(m[1]),
        size: m[2],
        speed: m[3],
        eta: m[4],
      });
    } else if ((m = ARIA_PROG.exec(text))) {
      emit({
        type: "progress",
        phase,
        percent: parseFloat(m[2]),
        size: m[1],
        speed: m[3] + "/s",
        eta: m[4] || "—",
      });
    } else if (FINAL.test(text)) {
      emit({ type: "phase", phase: "processing" });
    } else if (/^ERROR/i.test(text)) {
      emit({ type: "log", line: text });
    }
  };

  let outBuf = "";
  const pump = (chunk) => {
    outBuf += chunk.toString();
    // split on \r and \n both — aria2c overwrites its progress line with \r
    const lines = outBuf.split(/[\r\n]+/);
    outBuf = lines.pop();
    for (const l of lines) handleLine(l);
  };
  child.stdout.on("data", pump);
  child.stderr.on("data", (c) => {
    const s = c.toString();
    if (/^ERROR/im.test(s)) emit({ type: "log", line: s.trim() });
  });

  child.on("close", async (code) => {
    if (outBuf) handleLine(outBuf);
    jobs.delete(id);
    if (code === 0) {
      // guarantee an editor-friendly H.264 file (re-encodes VP9/AV1, e.g. YouTube 4K)
      if (!audio) await ensureH264(lastFile, emit);
      emit({ type: "done", file: lastFile });
    } else if (code === null) emit({ type: "canceled" });
    else emit({ type: "error", code });
  });
  child.on("error", (err) => {
    jobs.delete(id);
    emit({ type: "error", message: err.message });
  });

  return id;
}

function cancel(id) {
  const child = jobs.get(id);
  if (child) {
    child.kill("SIGKILL");
    jobs.delete(id);
    return true;
  }
  return false;
}

function cancelAll() {
  for (const id of [...jobs.keys()]) cancel(id);
}

module.exports = { start, cancel, cancelAll, FFMPEG };
