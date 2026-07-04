import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, unlink, writeFile, readFile, rename } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { openai } from "@workspace/integrations-openai-ai-server";
import { createReadStream, existsSync } from "fs";
import { logger } from "../../lib/logger.js";
import { updateJob } from "./jobs.js";

const execFileAsync = promisify(execFile);

const SEGMENT_DURATION = 20;

interface ProcessOptions {
  jobId: string;
  videoUrl: string;
  startTime: number;
  model: string;
  voice: string;
}

// Output audio paths stored by jobId
const audioFiles = new Map<string, string>();

export function getAudioPath(jobId: string): string | null {
  return audioFiles.get(jobId) ?? null;
}

// Full audio cache: videoUrl → local mp3 path (downloaded once, reused for all segments)
const fullAudioCache = new Map<string, string>();
// In-flight downloads: videoUrl → Promise (prevents duplicate downloads)
const fullAudioInFlight = new Map<string, Promise<string>>();

export const TTS_MODELS = [
  {
    id: "microsoft-edge",
    name: "مايكروسوفت Edge TTS",
    voices: [
      { id: "ar-SA-HamedNeural", name: "حامد - ذكر سعودي", gender: "ذكر" },
      { id: "ar-SA-ZariyahNeural", name: "زارية - أنثى سعودية", gender: "أنثى" },
      { id: "ar-EG-ShakirNeural", name: "شاكر - ذكر مصري", gender: "ذكر" },
      { id: "ar-EG-SalmaNeural", name: "سلمى - أنثى مصرية", gender: "أنثى" },
      { id: "ar-AE-HamdanNeural", name: "حمدان - ذكر إماراتي", gender: "ذكر" },
      { id: "ar-AE-FatimaNeural", name: "فاطمة - أنثى إماراتية", gender: "أنثى" },
      { id: "fr-FR-RemyMultilingualNeural", name: "Remy Multilingual (FR)", gender: "ذكر" },
    ],
  },
  {
    id: "google-translate",
    name: "جوجل Translate TTS",
    voices: [
      { id: "ar", name: "عربي (افتراضي)", gender: "أنثى" },
    ],
  },
];

/**
 * Download the full audio of a YouTube video, caching it so multiple segments
 * from the same video share one download. Uses android client + formats=missing_pot
 * which is the only reliable approach on server IPs without a GVS PO Token.
 */
async function getOrDownloadFullAudio(videoUrl: string): Promise<string> {
  if (fullAudioCache.has(videoUrl)) {
    return fullAudioCache.get(videoUrl)!;
  }
  if (fullAudioInFlight.has(videoUrl)) {
    return fullAudioInFlight.get(videoUrl)!;
  }

  const promise = (async () => {
    const dir = await mkdtemp(join(tmpdir(), "vt-full-"));
    const outTemplate = join(dir, "audio.%(ext)s");
    const outPath = join(dir, "audio.mp3");

    await execFileAsync("yt-dlp", [
      "--extractor-args", "youtube:player_client=android;formats=missing_pot",
      "-f", "18/bestaudio[ext=m4a]/bestaudio",
      "-x", "--audio-format", "mp3", "--audio-quality", "5",
      "--no-playlist",
      "-o", outTemplate,
      videoUrl,
    ]);

    if (!existsSync(outPath)) {
      throw new Error("yt-dlp لم يُنشئ ملف الصوت الكامل");
    }

    fullAudioCache.set(videoUrl, outPath);
    fullAudioInFlight.delete(videoUrl);
    return outPath;
  })();

  fullAudioInFlight.set(videoUrl, promise);
  return promise;
}

/**
 * Step 1: Cut a 20-second segment from the cached full audio using ffmpeg.
 * Only downloads the full audio once per video URL.
 */
async function downloadAudioSegment(
  videoUrl: string,
  startTime: number,
  outputPath: string
): Promise<void> {
  const fullAudioPath = await getOrDownloadFullAudio(videoUrl);

  // Cut the 20-second segment from the local full audio file
  await execFileAsync("ffmpeg", [
    "-ss", String(startTime),
    "-i", fullAudioPath,
    "-t", String(SEGMENT_DURATION + 2),
    "-vn",
    "-ar", "16000",
    "-ac", "1",
    "-acodec", "libmp3lame",
    "-q:a", "3",
    "-y",
    outputPath,
  ]);

  if (!existsSync(outputPath)) {
    throw new Error("ffmpeg لم يُنشئ ملف المقطع");
  }
}

async function cleanAudioWithFfmpeg(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-i", inputPath,
    "-af", [
      "highpass=f=80",
      "lowpass=f=8000",
      "afftdn=nf=-25",
      "loudnorm=I=-16:TP=-1.5:LRA=11",
    ].join(","),
    "-ar", "16000",
    "-ac", "1",
    "-y",
    outputPath,
  ]);
}

async function transcribeAudio(audioPath: string): Promise<string> {
  const audioStream = createReadStream(audioPath);
  // gpt-4o-mini-transcribe is the supported STT model via Replit AI Integrations
  const transcription = await openai.audio.transcriptions.create({
    model: "gpt-4o-mini-transcribe",
    file: audioStream,
    response_format: "json",
  });
  return transcription.text;
}

async function translateToArabic(text: string): Promise<string> {
  // Use gpt-4o-mini (cheapest capable model) instead of gpt-5.2
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 2048,
    messages: [
      {
        role: "system",
        content:
          "أنت مترجم محترف. ترجم النص التالي إلى اللغة العربية الفصحى بدقة عالية. أعط الترجمة فقط بدون أي تعليقات أو شرح.",
      },
      { role: "user", content: text },
    ],
  });
  return response.choices[0]?.message?.content ?? text;
}

/**
 * Generate speech using Microsoft Edge TTS (free, via msedge-tts npm package)
 * NOTE: msedge-tts v2 toFile() expects a DIRECTORY path, not a file path.
 * It writes the audio to {dir}/audio.mp3 internally.
 * Speed is NOT applied here — caller applies auto-calculated atempo.
 */
async function generateEdgeTTS(
  text: string,
  voice: string,
  outputPath: string
): Promise<void> {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  // msedge-tts toFile() takes a directory; it writes audio.mp3 inside it
  const ttsDir = await mkdtemp(join(tmpdir(), "vt-tts-"));
  await tts.toFile(ttsDir, text);
  const rawPath = join(ttsDir, "audio.mp3");

  if (!existsSync(rawPath)) {
    throw new Error(`msedge-tts لم يُنشئ ملف الصوت في ${rawPath}`);
  }

  await execFileAsync("ffmpeg", ["-i", rawPath, "-acodec", "libmp3lame", "-q:a", "3", "-y", outputPath]);
  try { await unlink(rawPath); } catch { /* ignore */ }
}

/**
 * Split text into chunks of max maxLen characters at word boundaries
 */
function splitTextIntoChunks(text: string, maxLen = 190): string[] {
  const words = text.split(" ");
  const chunks: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxLen) {
      if (current) chunks.push(current.trim());
      // If single word exceeds limit, force-split it
      if (word.length > maxLen) {
        for (let i = 0; i < word.length; i += maxLen) {
          chunks.push(word.slice(i, i + maxLen));
        }
        current = "";
      } else {
        current = word;
      }
    } else {
      current = candidate;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 0);
}

/**
 * Generate speech using Google Translate TTS (free, unofficial API)
 * Speed is NOT applied here — caller applies auto-calculated atempo.
 */
async function generateGoogleTTS(
  text: string,
  lang: string,
  outputPath: string
): Promise<void> {
  const chunks = splitTextIntoChunks(text, 190);
  const tmpFiles: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const encoded = encodeURIComponent(chunks[i]);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${lang}&client=tw-ob&ttsspeed=1`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://translate.google.com/",
        "Accept": "audio/mpeg,audio/*;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      throw new Error(`Google TTS failed for chunk ${i}: HTTP ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    const tmpFile = outputPath.replace(".mp3", `_chunk${i}.mp3`);
    await writeFile(tmpFile, Buffer.from(buffer));
    tmpFiles.push(tmpFile);
  }

  // Merge chunks into outputPath
  if (tmpFiles.length === 1) {
    await execFileAsync("ffmpeg", ["-i", tmpFiles[0], "-acodec", "libmp3lame", "-q:a", "3", "-y", outputPath]);
    await unlink(tmpFiles[0]);
  } else {
    const listPath = outputPath.replace(".mp3", "_list.txt");
    await writeFile(listPath, tmpFiles.map(f => `file '${f}'`).join("\n"));
    await execFileAsync("ffmpeg", ["-f", "concat", "-safe", "0", "-i", listPath, "-acodec", "libmp3lame", "-q:a", "3", "-y", outputPath]);
    await unlink(listPath);
    for (const f of tmpFiles) { try { await unlink(f); } catch { /* ignore */ } }
  }
}

/**
 * Measure audio duration in seconds using ffprobe.
 */
async function getAudioDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    filePath,
  ]);
  return parseFloat(stdout.trim()) || SEGMENT_DURATION;
}

/**
 * Main dispatcher: choose TTS provider based on model ID.
 * Speed is NOT applied — caller measures duration and applies atempo.
 */
async function generateSpeech(
  text: string,
  modelId: string,
  voiceId: string,
  outputPath: string
): Promise<void> {
  if (modelId === "microsoft-edge") {
    await generateEdgeTTS(text, voiceId, outputPath);
  } else if (modelId === "google-translate") {
    await generateGoogleTTS(text, voiceId, outputPath);
  } else {
    await generateEdgeTTS(text, "ar-SA-HamedNeural", outputPath);
  }
}

export async function processVideoSegment(options: ProcessOptions): Promise<void> {
  const { jobId, videoUrl, startTime, model, voice } = options;

  const tmpDir = await mkdtemp(join(tmpdir(), "vt-"));
  const rawAudioPath = join(tmpDir, "raw.mp3");
  const cleanAudioPath = join(tmpDir, "clean.mp3");
  const outputPath = join(tmpDir, "output.mp3");

  try {
    // Step 1: Download full audio (cached) then cut the segment
    const isFirstDownload = !fullAudioCache.has(videoUrl) && !fullAudioInFlight.has(videoUrl);
    updateJob(jobId, {
      status: "processing",
      progress: isFirstDownload
        ? "جاري تنزيل الصوت من يوتيوب... (مرة واحدة فقط)"
        : "جاري استخراج مقطع الصوت..."
    });
    await downloadAudioSegment(videoUrl, startTime, rawAudioPath);

    // Step 2: Clean audio
    updateJob(jobId, { progress: "جاري تنقية الصوت..." });
    await cleanAudioWithFfmpeg(rawAudioPath, cleanAudioPath);

    // Step 3: Transcribe
    updateJob(jobId, { progress: "جاري تحويل الصوت إلى نص..." });
    const transcript = await transcribeAudio(cleanAudioPath);
    updateJob(jobId, { transcript });

    if (!transcript || transcript.trim().length === 0) {
      throw new Error("لم يتم التعرف على أي نص في المقطع");
    }

    // Step 4: Translate
    updateJob(jobId, { progress: "جاري ترجمة النص إلى العربية..." });
    const translation = await translateToArabic(transcript);
    updateJob(jobId, { translation });

    // Step 5: Generate Arabic speech at natural speed
    updateJob(jobId, { progress: "جاري توليد الصوت العربي..." });
    const ttsRawPath = join(tmpDir, "tts_raw.mp3");
    await generateSpeech(translation, model, voice, ttsRawPath);

    // Step 6: Auto-calculate speed — cap atempo at 1.7, slow video if needed
    const ttsDuration = await getAudioDuration(ttsRawPath);
    const neededSpeed = ttsDuration / SEGMENT_DURATION;
    const atempo = Math.min(1.7, Math.max(1.0, neededSpeed));
    const videoRate = neededSpeed <= 1.7 ? 1.0 : parseFloat((1.7 / neededSpeed).toFixed(3));

    if (atempo > 1.05) {
      await execFileAsync("ffmpeg", [
        "-i", ttsRawPath,
        "-af", `atempo=${atempo.toFixed(3)}`,
        "-acodec", "libmp3lame", "-q:a", "3",
        "-y", outputPath,
      ]);
      await unlink(ttsRawPath);
    } else {
      await rename(ttsRawPath, outputPath);
    }

    // Store audio path and mark complete
    audioFiles.set(jobId, outputPath);
    updateJob(jobId, { status: "completed", progress: "✅ اكتمل المقطع", videoRate });

    logger.info({ jobId, startTime }, "Segment processed successfully");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ jobId, err }, "Segment processing failed");
    updateJob(jobId, {
      status: "failed",
      progress: `❌ فشل: ${message}`,
      error: message,
    });

    // Cleanup on failure
    for (const f of [rawAudioPath, cleanAudioPath]) {
      try { await unlink(f); } catch { /* ignore */ }
    }
  }
}
