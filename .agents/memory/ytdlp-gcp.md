---
name: yt-dlp on GCP IPs — segment download approach
description: Correct way to download only needed audio segment on GCP/Replit servers
---

**Rule:** Never use `--download-sections` on GCP IPs — ffmpeg's direct HTTP requests to YouTube CDN get 403. Never download full audio (too slow for long videos). Instead: use `yt-dlp --get-url` to get the CDN URL, then use `ffmpeg` with the Android user-agent to download only the needed segment.

**Why:** `--download-sections` passes the CDN URL to ffmpeg without yt-dlp's auth headers → 403. Full download is impractical for videos > 1 hour. The CDN URL from `--get-url` combined with the Android user-agent header is what YouTube CDN actually checks — and it works from GCP IPs.

**How to apply:**
```typescript
// Step 1: Get CDN URL once per video (cached 5h, CDN URLs expire ~6h)
const { stdout } = await execFileAsync("yt-dlp", [
  "--extractor-args", "youtube:player_client=android;formats=missing_pot",
  "-f", "18/bestaudio[ext=m4a]/bestaudio",
  "--get-url", "--no-playlist", videoUrl,
]);
const cdnUrl = stdout.trim().split("\n")[0];

// Step 2: ffmpeg downloads ONLY the needed segment with android user-agent
await execFileAsync("ffmpeg", [
  "-user_agent", "com.google.android.youtube/17.36.4 (Linux; U; Android 12; GB) gzip",
  "-ss", String(startTime),
  "-i", cdnUrl,
  "-t", String(SEGMENT_DURATION + 2),
  "-vn", "-ar", "16000", "-ac", "1",
  "-acodec", "libmp3lame", "-q:a", "3", "-y", outputPath,
]);
```

**Performance:** First segment ~12s (includes yt-dlp URL fetch ~2s + ffmpeg download ~2s + transcription + translation + TTS). Subsequent segments ~10s (CDN URL cached, only ffmpeg segment + pipeline).
