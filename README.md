# AINZ Clips

Desktop video downloader. Paste a link and download from YouTube, TikTok, bilibili, anime/film sites, and 1,800+ others. Public videos need no setup; private / login-only sites (Instagram, etc.) use a built-in sign-in.

## Features

- **Any site** — yt-dlp core (1,800+ extractors) plus a headless-browser fallback that sniffs embeds/streams for unsupported sites.
- **Up to 4K/8K** on YouTube (forces DASH clients).
- **In-app accounts** — sign in to any site once inside the app; the login is saved on this device and used automatically for both extraction and the browser sniffer.
- **Fast downloads** — aria2c multi-connection + parallel HLS fragments.
- **File converter** — convert any local media to MP4/MKV/WebM/MOV/GIF/MP3/M4A/FLAC/… with lossless stream-copy when the codec already fits (instant + no quality loss).
- **Auto-update** from GitHub Releases.

## Develop

```bash
npm install
npm start
```

Bundled tools live in `bin/` (`yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`, `aria2c.exe`) and are not tracked in git.

## Build / release

```bash
npm run dist      # build installer locally
npm run release   # build + publish to GitHub Releases (auto-update feed)
```
