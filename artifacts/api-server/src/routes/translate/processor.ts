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

interface ProcessOptions {
  jobId: string;
  videoUrl: string;
  startTime: number;
  model: string;
  voice: string;
  speed: number;
}

// Audio file paths stored by jobId
const audioFiles = new Map<string, string>();

export function getAudioPath(jobId: string): string | null {
  return audioFiles.get(jobId) ?? null;
}

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
 * Step 1: Get the direct audio stream URL from YouTube using yt-dlp
 * Then use ffmpeg to extract exactly 20 seconds starting from startTime
 */
async function downloadAudioSegment(
  videoUrl: string,
  startTime: number,
  outputPath: string
): Promise<void> {
  // Get direct audio stream URL — use ios client to bypass SABR streaming restrictions
  const { stdout: streamUrl } = await execFileAsync("yt-dlp", [
    "-f", "bestaudio[ext=m4a]/bestaudio/best",
    "--get-url",
    "--no-playlist",
    "--extractor-args", "youtube:player_client=ios",
    videoUrl,
  ]);

  const cleanUrl = streamUrl.trim();

  if (!cleanUrl || !cleanUrl.startsWith("http")) {
    throw new Error("لم يتمكن من الحصول على رابط الصوت من يوتيوب");
  }

  // Use ffmpeg to seek to startTime and extract 20 seconds directly from the stream
  await execFileAsync("ffmpeg", [
    "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "-ss", String(startTime),
    "-i", cleanUrl,
    "-t", "20",
    "-vn",
    "-ar", "16000",
    "-ac", "1",
    "-acodec", "libmp3lame",
    "-q:a", "3",
    "-y",
    outputPath,
  ]);
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
  // Use the cheapest whisper model
  const transcription = await openai.audio.transcriptions.create({
    model: "whisper-1",
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
 */
async function generateEdgeTTS(
  text: string,
  voice: string,
  speed: number,
  outputPath: string
): Promise<void> {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  const rawPath = outputPath.replace(".mp3", "_raw.mp3");
  await tts.toFile(rawPath, text);

  // Apply speed adjustment with ffmpeg
  const ffmpegSpeed = Math.min(2.0, Math.max(0.5, speed));
  if (Math.abs(ffmpegSpeed - 1.0) < 0.05) {
    // No speed change needed, just copy
    await execFileAsync("ffmpeg", ["-i", rawPath, "-acodec", "libmp3lame", "-q:a", "3", "-y", outputPath]);
  } else {
    await execFileAsync("ffmpeg", [
      "-i", rawPath,
      "-af", `atempo=${ffmpegSpeed}`,
      "-acodec", "libmp3lame",
      "-q:a", "3",
      "-y",
      outputPath,
    ]);
  }

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
 */
async function generateGoogleTTS(
  text: string,
  lang: string,
  speed: number,
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

  // Merge chunks if more than one
  let rawPath: string;
  if (tmpFiles.length === 1) {
    rawPath = tmpFiles[0];
  } else {
    rawPath = outputPath.replace(".mp3", "_raw.mp3");
    const listPath = outputPath.replace(".mp3", "_list.txt");
    await writeFile(listPath, tmpFiles.map(f => `file '${f}'`).join("\n"));
    await execFileAsync("ffmpeg", ["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-y", rawPath]);
    await unlink(listPath);
    for (const f of tmpFiles) { try { await unlink(f); } catch { /* ignore */ } }
  }

  // Apply speed adjustment
  const ffmpegSpeed = Math.min(2.0, Math.max(0.5, speed));
  if (Math.abs(ffmpegSpeed - 1.0) < 0.05) {
    await execFileAsync("ffmpeg", ["-i", rawPath, "-acodec", "libmp3lame", "-q:a", "3", "-y", outputPath]);
  } else {
    await execFileAsync("ffmpeg", [
      "-i", rawPath,
      "-af", `atempo=${ffmpegSpeed}`,
      "-acodec", "libmp3lame",
      "-q:a", "3",
      "-y",
      outputPath,
    ]);
  }

  if (rawPath !== outputPath) {
    try { await unlink(rawPath); } catch { /* ignore */ }
  }
}

/**
 * Main dispatcher: choose TTS provider based on model ID
 */
async function generateSpeech(
  text: string,
  modelId: string,
  voiceId: string,
  speed: number,
  outputPath: string
): Promise<void> {
  if (modelId === "microsoft-edge") {
    await generateEdgeTTS(text, voiceId, speed, outputPath);
  } else if (modelId === "google-translate") {
    // voiceId is the language code (e.g. "ar")
    await generateGoogleTTS(text, voiceId, speed, outputPath);
  } else {
    // Fallback to Edge TTS with a default Arabic voice
    await generateEdgeTTS(text, "ar-SA-HamedNeural", speed, outputPath);
  }
}

export async function processVideoSegment(options: ProcessOptions): Promise<void> {
  const { jobId, videoUrl, startTime, model, voice, speed } = options;

  const tmpDir = await mkdtemp(join(tmpdir(), "vt-"));
  const rawAudioPath = join(tmpDir, "raw.mp3");
  const cleanAudioPath = join(tmpDir, "clean.mp3");
  const outputPath = join(tmpDir, "output.mp3");

  try {
    // Step 1: Download audio segment
    updateJob(jobId, { status: "processing", progress: "جاري تنزيل مقطع الصوت..." });
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

    // Step 5: Generate Arabic speech
    updateJob(jobId, { progress: "جاري توليد الصوت العربي..." });
    await generateSpeech(translation, model, voice, speed, outputPath);

    // Store audio path and mark complete
    audioFiles.set(jobId, outputPath);
    updateJob(jobId, { status: "completed", progress: "✅ اكتمل المقطع" });

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
