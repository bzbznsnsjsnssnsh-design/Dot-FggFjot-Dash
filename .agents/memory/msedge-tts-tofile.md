---
name: msedge-tts toFile API behavior
description: msedge-tts v2 toFile() expects a directory path and writes audio.mp3 inside it
---

**Rule:** `tts.toFile(path, text)` in msedge-tts v2 treats `path` as a **directory**, not a file path. It creates `path/audio.mp3` as the output.

**Why:** The library was redesigned in v2 to support multiple output formats by writing named files into a directory. Passing a `.mp3` path causes it to try creating a directory named `something.mp3` and then write `audio.mp3` inside it — resulting in ENOENT crashes.

**How to apply:**
```typescript
const ttsDir = await mkdtemp(join(tmpdir(), "vt-tts-"));
await tts.toFile(ttsDir, text);
const rawPath = join(ttsDir, "audio.mp3");  // actual output file
```
