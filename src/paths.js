// paths.js — resolve the bundled-binaries dir in BOTH dev and packaged builds.
// Dev: <project>/bin. Packaged: extraResources land in resources/bin
// (process.resourcesPath). Falls back safely when run under plain node (tests).
const path = require("node:path");
const fs = require("node:fs");

const DEV_BIN = path.join(path.resolve(__dirname, ".."), "bin");

function binDir() {
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, "bin");
    if (fs.existsSync(path.join(packaged, "yt-dlp.exe"))) return packaged;
  }
  return DEV_BIN;
}

module.exports = { binDir };
