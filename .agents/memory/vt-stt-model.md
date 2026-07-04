---
name: Video Translator STT model
description: Only gpt-4o-mini-transcribe works via Replit AI Integrations for speech-to-text
---

**Rule:** Use `gpt-4o-mini-transcribe` as the model for `openai.audio.transcriptions.create()`. `whisper-1` is not supported via Replit AI Integrations proxy.

**Why:** Replit AI Integrations only exposes a subset of OpenAI models. whisper-1 returns an error; gpt-4o-mini-transcribe is the supported STT model.

**How to apply:**
```typescript
const transcription = await openai.audio.transcriptions.create({
  model: "gpt-4o-mini-transcribe",
  file: audioStream,
  response_format: "json",
});
```
