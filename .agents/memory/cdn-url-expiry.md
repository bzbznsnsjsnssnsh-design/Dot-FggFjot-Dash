---
name: YouTube CDN URL expiry
description: YouTube googlevideo.com CDN URLs contain an expire= Unix-timestamp param. Fixed-duration caching (5h) causes HTTP 500 "Server returned 5XX" failures on segments fetched after the URL expires.
---

## Rule
Always derive cache TTL from the URL's own `expire` query param, not a fixed constant.
On HTTP 5XX from ffmpeg, treat it as an expired CDN URL: evict cache entry and retry once with a fresh yt-dlp fetch.

**Why:** YouTube can issue CDN URLs with varying lifetimes (sometimes < 5h). A fixed eviction window will silently serve stale URLs and cause all subsequent segments to fail with "Server returned 5XX Server Error reply".

**How to apply:**
- `cdnUrlTtlMs(url)` parses `new URL(cdnUrl).searchParams.get("expire")` and returns `(expireMs - Date.now() - 3min_buffer)`. Falls back to 4h if param missing.
- `isCdnExpiredError(err)` tests `/HTTP error 5\d\d|5XX Server Error/i` on error message.
- `downloadAudioSegment` catches the error, calls `directUrlCache.delete(videoUrl)` + `directUrlInFlight.delete(videoUrl)`, then calls `fetchFreshDirectUrl(videoUrl)` and retries ffmpeg once.
