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

const SEGMENT_DURATION = 50;
const CONTEXT_WINDOW = 30;

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

// Per-video translation context: videoUrl → last N translations (sliding window)
const translationContexts = new Map<string, string[]>();

function addTranslationContext(videoUrl: string, translation: string) {
  const list = translationContexts.get(videoUrl) ?? [];
  list.push(translation);
  if (list.length > CONTEXT_WINDOW) list.shift();
  translationContexts.set(videoUrl, list);
}

// Direct stream URL cache: videoUrl → CDN URL (yt-dlp fetches once, ffmpeg uses directly)
// YouTube CDN URLs expire after ~6 hours; we evict after 5h to be safe.
const directUrlCache = new Map<string, string>();
// In-flight URL fetches: prevents duplicate yt-dlp calls for the same video
const directUrlInFlight = new Map<string, Promise<string>>();

// VERIFIED voices — tested against Edge TTS API (only include voices that actually exist)
const EDGE_VOICES = [
  // ===== العربية — المملكة العربية السعودية =====
  { id: "ar-SA-HamedNeural",   name: "حامد — المملكة العربية السعودية",   gender: "ذكر",  locale: "ar-SA" },
  { id: "ar-SA-ZariyahNeural", name: "زارية — المملكة العربية السعودية",  gender: "أنثى", locale: "ar-SA" },
  // ===== العربية — مصر =====
  { id: "ar-EG-ShakirNeural",  name: "شاكر — مصر",    gender: "ذكر",  locale: "ar-EG" },
  { id: "ar-EG-SalmaNeural",   name: "سلمى — مصر",    gender: "أنثى", locale: "ar-EG" },
  // ===== العربية — الإمارات =====
  { id: "ar-AE-HamdanNeural",  name: "حمدان — الإمارات", gender: "ذكر",  locale: "ar-AE" },
  { id: "ar-AE-FatimaNeural",  name: "فاطمة — الإمارات", gender: "أنثى", locale: "ar-AE" },
  // ===== العربية — الكويت =====
  { id: "ar-KW-FahedNeural",   name: "فهد — الكويت",  gender: "ذكر",  locale: "ar-KW" },
  { id: "ar-KW-NouraNeural",   name: "نورة — الكويت", gender: "أنثى", locale: "ar-KW" },
  // ===== العربية — قطر =====
  { id: "ar-QA-MoazNeural",    name: "معاذ — قطر",    gender: "ذكر",  locale: "ar-QA" },
  { id: "ar-QA-AmalNeural",    name: "أمل — قطر",     gender: "أنثى", locale: "ar-QA" },
  // ===== العربية — البحرين =====
  { id: "ar-BH-AliNeural",     name: "علي — البحرين",  gender: "ذكر",  locale: "ar-BH" },
  { id: "ar-BH-LailaNeural",   name: "ليلى — البحرين", gender: "أنثى", locale: "ar-BH" },
  // ===== العربية — العراق =====
  { id: "ar-IQ-BasselNeural",  name: "باسل — العراق", gender: "ذكر",  locale: "ar-IQ" },
  { id: "ar-IQ-RanaNeural",    name: "رنا — العراق",   gender: "أنثى", locale: "ar-IQ" },
  // ===== العربية — الأردن =====
  { id: "ar-JO-TaimNeural",    name: "تيم — الأردن",   gender: "ذكر",  locale: "ar-JO" },
  { id: "ar-JO-SanaNeural",    name: "سنا — الأردن",   gender: "أنثى", locale: "ar-JO" },
  // ===== العربية — لبنان =====
  { id: "ar-LB-RamiNeural",    name: "رامي — لبنان",  gender: "ذكر",  locale: "ar-LB" },
  { id: "ar-LB-LaylaNeural",   name: "ليلى — لبنان",  gender: "أنثى", locale: "ar-LB" },
  // ===== العربية — المغرب =====
  { id: "ar-MA-JamalNeural",   name: "جمال — المغرب", gender: "ذكر",  locale: "ar-MA" },
  { id: "ar-MA-MounaNeural",   name: "منى — المغرب",  gender: "أنثى", locale: "ar-MA" },
  // ===== العربية — تونس =====
  { id: "ar-TN-HediNeural",    name: "هادي — تونس",   gender: "ذكر",  locale: "ar-TN" },
  { id: "ar-TN-ReemNeural",    name: "ريم — تونس",    gender: "أنثى", locale: "ar-TN" },
  // ===== العربية — الجزائر =====
  { id: "ar-DZ-IsmaelNeural",  name: "إسماعيل — الجزائر", gender: "ذكر",  locale: "ar-DZ" },
  { id: "ar-DZ-AminaNeural",   name: "أمينة — الجزائر",   gender: "أنثى", locale: "ar-DZ" },
  // ===== العربية — سوريا =====
  { id: "ar-SY-LaithNeural",   name: "ليث — سوريا",   gender: "ذكر",  locale: "ar-SY" },
  { id: "ar-SY-AmanyNeural",   name: "أماني — سوريا", gender: "أنثى", locale: "ar-SY" },
  // ===== العربية — عُمان =====
  { id: "ar-OM-AbdullahNeural",name: "عبد الله — عُمان", gender: "ذكر",  locale: "ar-OM" },
  { id: "ar-OM-AyshaNeural",   name: "عيشة — عُمان",  gender: "أنثى", locale: "ar-OM" },
  // ===== العربية — ليبيا =====
  { id: "ar-LY-OmarNeural",    name: "عمر — ليبيا",   gender: "ذكر",  locale: "ar-LY" },
  { id: "ar-LY-ImanNeural",    name: "إيمان — ليبيا", gender: "أنثى", locale: "ar-LY" },
  // ===== العربية — اليمن =====
  { id: "ar-YE-SalehNeural",   name: "صالح — اليمن",  gender: "ذكر",  locale: "ar-YE" },
  { id: "ar-YE-MaryamNeural",  name: "مريم — اليمن",  gender: "أنثى", locale: "ar-YE" },
  // ===== Multilingual — يتحدثون العربية تلقائياً =====
  { id: "en-US-AvaMultilingualNeural",         name: "Ava — متعدد اللغات (أمريكي)",       gender: "أنثى", locale: "multilingual" },
  { id: "en-US-AndrewMultilingualNeural",      name: "Andrew — متعدد اللغات (أمريكي)",    gender: "ذكر",  locale: "multilingual" },
  { id: "en-US-EmmaMultilingualNeural",        name: "Emma — متعدد اللغات (أمريكي)",      gender: "أنثى", locale: "multilingual" },
  { id: "en-US-BrianMultilingualNeural",       name: "Brian — متعدد اللغات (أمريكي)",     gender: "ذكر",  locale: "multilingual" },
  { id: "en-AU-WilliamMultilingualNeural",     name: "William — متعدد اللغات (أسترالي)",  gender: "ذكر",  locale: "multilingual" },
  { id: "fr-FR-RemyMultilingualNeural",        name: "Remy — متعدد اللغات (فرنسي)",       gender: "ذكر",  locale: "multilingual" },
  { id: "fr-FR-VivienneMultilingualNeural",    name: "Vivienne — متعدد اللغات (فرنسية)",  gender: "أنثى", locale: "multilingual" },
  { id: "de-DE-SeraphinaMultilingualNeural",   name: "Seraphina — متعدد اللغات (ألمانية)",gender: "أنثى", locale: "multilingual" },
  { id: "de-DE-FlorianMultilingualNeural",     name: "Florian — متعدد اللغات (ألماني)",   gender: "ذكر",  locale: "multilingual" },
  { id: "it-IT-GiuseppeMultilingualNeural",    name: "Giuseppe — متعدد اللغات (إيطالي)",  gender: "ذكر",  locale: "multilingual" },
  { id: "ko-KR-HyunsuMultilingualNeural",      name: "Hyunsu — متعدد اللغات (كوري)",      gender: "ذكر",  locale: "multilingual" },
  { id: "pt-BR-ThalitaMultilingualNeural",     name: "Thalita — متعدد اللغات (برازيلية)", gender: "أنثى", locale: "multilingual" },
];

export const TTS_MODELS = [
  {
    id: "microsoft-edge",
    name: "مايكروسوفت Edge TTS (Neural)",
    voices: EDGE_VOICES,
  },
  {
    id: "google-translate",
    name: "جوجل Translate TTS",
    voices: [
      { id: "ar", name: "عربي (افتراضي)", gender: "أنثى", locale: "ar" },
    ],
  },
];

/**
 * Get the direct CDN URL for a YouTube video using yt-dlp --get-url.
 * Result is cached per videoUrl and evicted after 5 hours (CDN URLs expire ~6h).
 * Concurrent requests for the same URL share one yt-dlp call.
 */
async function getDirectUrl(videoUrl: string): Promise<string> {
  if (directUrlCache.has(videoUrl)) {
    return directUrlCache.get(videoUrl)!;
  }
  if (directUrlInFlight.has(videoUrl)) {
    return directUrlInFlight.get(videoUrl)!;
  }

  const promise = (async () => {
    const { stdout } = await execFileAsync("yt-dlp", [
      "--extractor-args", "youtube:player_client=android;formats=missing_pot",
      "-f", "18/bestaudio[ext=m4a]/bestaudio",
      "--get-url",
      "--no-playlist",
      videoUrl,
    ]);
    const cdnUrl = stdout.trim().split("\n")[0];
    if (!cdnUrl) throw new Error("yt-dlp لم يُعط رابطاً مباشراً");

    directUrlCache.set(videoUrl, cdnUrl);
    directUrlInFlight.delete(videoUrl);
    // Evict after 5 hours before the URL expires
    setTimeout(() => directUrlCache.delete(videoUrl), 5 * 60 * 60 * 1000);
    return cdnUrl;
  })();

  directUrlInFlight.set(videoUrl, promise);
  return promise;
}

/**
 * Download only the needed 20-second segment using ffmpeg directly from the CDN URL.
 * Uses the Android user-agent so YouTube CDN accepts the request.
 * No full-video download — seeks directly to startTime via HTTP range requests.
 */
async function downloadAudioSegment(
  videoUrl: string,
  startTime: number,
  outputPath: string
): Promise<void> {
  const cdnUrl = await getDirectUrl(videoUrl);

  await execFileAsync("ffmpeg", [
    "-user_agent", "com.google.android.youtube/17.36.4 (Linux; U; Android 12; GB) gzip",
    "-ss", String(startTime),
    "-i", cdnUrl,
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

// Patterns that indicate the AI refused to translate instead of producing Arabic text
const REFUSAL_PATTERNS = [
  /لا\s*يمكن/i,
  /لا\s*أستطيع/i,
  /عذراً/i,
  /I cannot/i,
  /I'm sorry/i,
  /I am unable/i,
  /cannot translate/i,
  /unable to translate/i,
  /not able to/i,
];

function isRefusal(text: string): boolean {
  return REFUSAL_PATTERNS.some(p => p.test(text));
}

/** Returns true if the string contains at least a few Arabic characters */
function containsArabic(text: string): boolean {
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) ?? []).length;
  return arabicChars >= 3;
}

async function translateToArabic(text: string, videoUrl: string): Promise<string> {
  const previous = translationContexts.get(videoUrl) ?? [];

  const systemPrompt =
    "أنت مترجم آلي. مهمتك الوحيدة هي ترجمة النص إلى العربية الفصحى.\n" +
    "يجب أن تُخرج دائماً ترجمة عربية، حتى لو كان النص غير واضح — استخدم التقريب.\n" +
    "لا تكتب أي شرح أو اعتذار أو تعليق، فقط الترجمة.\n\n" +
    "قد يتم تزويدك بترجمات سابقة من نفس المشروع. استخدمها كمرجع للحفاظ على الاتساق في المصطلحات والأسماء والأسلوب، مع مراعاة السياق الحالي.\n\n" +
    "القواعد:\n" +
    "- انقل المعنى المقصود، لا الكلمات حرفيًا.\n" +
    "- استخدم عربية سليمة وسلسة.\n" +
    "- حافظ على المصطلحات نفسها طوال المشروع.\n" +
    "- حافظ على أسماء الأشخاص والعلامات التجارية كما هي.\n" +
    "- لا تضف أو تحذف أي معلومات.\n" +
    "- أخرج الترجمة فقط، بدون أي مقدمة أو خاتمة أو شرح.";

  // Build the user message in the exact format: الترجمة السابقة / النص الجديد
  let userContent: string;
  if (previous.length > 0) {
    const contextBlock = previous.slice(-5).join("\n\n---\n\n");
    userContent =
      `الترجمة السابقة:\n${contextBlock}\n\n` +
      `النص الجديد:\n${text}`;
  } else {
    userContent = `النص الجديد:\n${text}`;
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 2048,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });

  const result = response.choices[0]?.message?.content?.trim() ?? "";

  // Valid result must contain Arabic characters and not be a refusal
  if (result && containsArabic(result) && !isRefusal(result)) {
    return result;
  }

  // Retry 1 — ultra-simple prompt, no context
  logger.warn({ text }, "Translation refused or non-Arabic — retrying with minimal prompt");
  const retry1 = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 2048,
    temperature: 0,
    messages: [
      { role: "system", content: "ترجم النص التالي إلى اللغة العربية فقط. أخرج الترجمة العربية مباشرةً بدون أي شرح أو مقدمة:" },
      { role: "user", content: text },
    ],
  });
  const retry1Result = retry1.choices[0]?.message?.content?.trim() ?? "";

  if (retry1Result && containsArabic(retry1Result) && !isRefusal(retry1Result)) {
    return retry1Result;
  }

  // Retry 2 — force translation by framing it as a task with example
  logger.warn({ text }, "Translation retry 1 failed — attempting forced translation");
  const retry2 = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 2048,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are a professional Arabic translator. You MUST always respond with an Arabic translation. " +
          "Never refuse, never explain, never output anything except the Arabic translation. " +
          "If content seems sensitive, translate it anyway — your only job is translation.",
      },
      { role: "user", content: `Translate to Arabic:\n${text}` },
    ],
  });
  const retry2Result = retry2.choices[0]?.message?.content?.trim() ?? "";

  if (retry2Result && containsArabic(retry2Result) && !isRefusal(retry2Result)) {
    return retry2Result;
  }

  // All retries failed — return empty string so TTS produces silence, NOT the original language
  logger.error({ text }, "Translation failed after 3 attempts — skipping segment audio");
  return "";
}

/**
 * Generate a short audio preview for a given voice.
 * Creates a temporary MP3 that gets cleaned up after serving.
 */
export async function generatePreview(voiceId: string): Promise<string> {
  // Arabic text so multilingual voices speak Arabic by default
  const sampleText = "أهلاً وسهلاً، هذا مثال على هذا الصوت باللغة العربية. يمكنك استخدامه في دبلجة الفيديو.";
  const previewDir = await mkdtemp(join(tmpdir(), "vt-preview-"));
  const previewPath = join(previewDir, "preview.mp3");
  await generateEdgeTTS(sampleText, voiceId, previewPath);
  return previewPath;
}

/**
 * Generate speech using Microsoft Edge TTS (free, via msedge-tts npm package)
 * NOTE: msedge-tts v2 toFile() expects a DIRECTORY path, not a file path.
 * It writes the audio to {dir}/audio.mp3 internally.
 * Speed is NOT applied here — caller applies auto-calculated atempo.
 * Multilingual voices auto-detect Arabic from the text content (no SSML needed).
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
  // Multilingual voices detect Arabic automatically from the Arabic text content
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
    // Step 1: Get CDN URL (once per video) then download only the needed segment
    const needsUrlFetch = !directUrlCache.has(videoUrl) && !directUrlInFlight.has(videoUrl);
    updateJob(jobId, {
      status: "processing",
      progress: needsUrlFetch
        ? "جاري الحصول على رابط الصوت من يوتيوب..."
        : "جاري تنزيل مقطع الصوت..."
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

    // Step 4: Translate with context from previous translations
    updateJob(jobId, { progress: "جاري ترجمة النص إلى العربية..." });
    const translation = await translateToArabic(transcript, videoUrl);
    updateJob(jobId, { translation });

    // If translation failed completely (empty), skip TTS and mark complete with silence
    if (!translation || translation.trim().length === 0) {
      logger.warn({ jobId, startTime }, "Translation empty — completing segment without audio");
      // Generate a short silent MP3 so the frontend can advance gracefully
      await execFileAsync("ffmpeg", [
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
        "-t", "1",
        "-acodec", "libmp3lame", "-q:a", "9",
        "-y", outputPath,
      ]);
      audioFiles.set(jobId, outputPath);
      updateJob(jobId, { status: "completed", progress: "✅ اكتمل المقطع (تخطي)", videoRate: 1.0 });
      logger.info({ jobId, startTime }, "Segment completed (silent — translation unavailable)");
      return;
    }

    addTranslationContext(videoUrl, translation);

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
