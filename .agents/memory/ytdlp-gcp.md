---
name: yt-dlp on GCP IPs — full download required
description: --download-sections fails with 403 on Google Cloud IPs; must download full audio and ffmpeg-cut locally
---

**Rule:** Never use `--download-sections` with yt-dlp on Replit (GCP IPs). Instead, download the full audio to a local file, then use ffmpeg to seek-and-cut.

**Why:** `--download-sections` internally passes the YouTube CDN URL directly to ffmpeg for HTTP range requests. YouTube CDN returns 403 when ffmpeg (not yt-dlp) makes the request from a GCP IP — yt-dlp's android client auth is not forwarded. Full download via yt-dlp native downloader works because yt-dlp handles all authentication headers itself.

**How to apply:**
```typescript
// Cache full audio per video URL (downloads once, reused for all segments)
const fullAudioCache = new Map<string, string>();

// yt-dlp: full download
await execFileAsync("yt-dlp", [
  "--extractor-args", "youtube:player_client=android;formats=missing_pot",
  "-f", "18/bestaudio[ext=m4a]/bestaudio",
  "-x", "--audio-format", "mp3", "--audio-quality", "5",
  "--no-playlist", "-o", outTemplate, videoUrl,
]);

// ffmpeg: local seek-and-cut (no network)
await execFileAsync("ffmpeg", [
  "-ss", String(startTime), "-i", fullAudioPath,
  "-t", String(SEGMENT_DURATION + 2), "-vn", "-ar", "16000", "-ac", "1",
  "-acodec", "libmp3lame", "-q:a", "3", "-y", segmentPath,
]);
```

**Performance:** First segment ~24s (includes full download ~6s for 38MB); subsequent segments ~10s (cached audio, only ffmpeg + transcription + translation + TTS).
