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
const directUrlCache = new Map<string, string>();
// In-flight URL fetches: prevents duplicate yt-dlp calls for the same video
const directUrlInFlight = new Map<string, Promise<string>>();

/**
 * Parse the `expire` query-param from a YouTube CDN URL and return how many
 * milliseconds until it expires. Falls back to 4 hours if not found.
 * We subtract a 3-minute safety buffer to evict just before actual expiry.
 */
function cdnUrlTtlMs(cdnUrl: string): number {
  const SAFETY_BUFFER_MS = 3 * 60 * 1000; // 3 minutes
  const FALLBACK_MS = 4 * 60 * 60 * 1000; // 4 hours
  try {
    const expireStr = new URL(cdnUrl).searchParams.get("expire");
    if (expireStr) {
      const expireMs = parseInt(expireStr, 10) * 1000;
      const remaining = expireMs - Date.now() - SAFETY_BUFFER_MS;
      if (remaining > 60_000) return remaining; // at least 1 minute left
    }
  } catch { /* ignore malformed URLs */ }
  return FALLBACK_MS;
}

/** Returns true if the ffmpeg error is a CDN HTTP 5XX (expired URL) */
function isCdnExpiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message + (err as any).stderr : String(err);
  return /HTTP error 5\d\d|5XX Server Error|Server returned 5|Server error/i.test(msg);
}

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
 * Fetch a fresh CDN URL via yt-dlp, cache it with TTL derived from the URL's
 * own `expire` param, and deduplicate concurrent callers.
 */
async function fetchFreshDirectUrl(videoUrl: string): Promise<string> {
  // If there's already an in-flight fetch, share it
  if (directUrlInFlight.has(videoUrl)) {
    return directUrlInFlight.get(videoUrl)!;
  }

  const promise = (async () => {
    logger.info({ videoUrl }, "yt-dlp: fetching fresh CDN URL");
    const { stdout } = await execFileAsync("yt-dlp", [
      "--extractor-args", "youtube:player_client=android;formats=missing_pot",
      "-f", "18/bestaudio[ext=m4a]/bestaudio",
      "--get-url",
      "--no-playlist",
      videoUrl,
    ]);
    const cdnUrl = stdout.trim().split("\n")[0];
    if (!cdnUrl) throw new Error("yt-dlp لم يُعط رابطاً مباشراً");

    // Cache with TTL computed from the URL's own expire param
    const ttl = cdnUrlTtlMs(cdnUrl);
    directUrlCache.set(videoUrl, cdnUrl);
    directUrlInFlight.delete(videoUrl);
    logger.info({ videoUrl, ttlMin: Math.round(ttl / 60000) }, "CDN URL cached");
    setTimeout(() => {
      directUrlCache.delete(videoUrl);
      logger.info({ videoUrl }, "CDN URL evicted from cache (expired)");
    }, ttl);
    return cdnUrl;
  })();

  directUrlInFlight.set(videoUrl, promise);
  // Clean up in-flight on error too
  promise.catch(() => directUrlInFlight.delete(videoUrl));
  return promise;
}

/**
 * Get the direct CDN URL for a YouTube video.
 * Returns cached value if still valid, otherwise fetches a fresh one.
 */
async function getDirectUrl(videoUrl: string): Promise<string> {
  if (directUrlCache.has(videoUrl)) {
    return directUrlCache.get(videoUrl)!;
  }
  return fetchFreshDirectUrl(videoUrl);
}

/**
 * Run ffmpeg to download one audio segment from the CDN URL.
 * On HTTP 5XX (expired CDN URL): invalidates cache and retries ONCE with a
 * fresh URL fetched via yt-dlp.
 */
async function downloadAudioSegment(
  videoUrl: string,
  startTime: number,
  outputPath: string
): Promise<void> {
  const runFfmpeg = async (cdnUrl: string) =>
    execFileAsync("ffmpeg", [
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

  const cdnUrl = await getDirectUrl(videoUrl);

  try {
    await runFfmpeg(cdnUrl);
  } catch (err) {
    if (isCdnExpiredError(err)) {
      // CDN URL expired — evict cache and fetch a fresh one, then retry
      logger.warn({ videoUrl, startTime }, "CDN URL returned 5XX — evicting cache and retrying with fresh URL");
      directUrlCache.delete(videoUrl);
      directUrlInFlight.delete(videoUrl);
      const freshUrl = await fetchFreshDirectUrl(videoUrl);
      await runFfmpeg(freshUrl);
    } else {
      throw err;
    }
  }

  if (!existsSync(outputPath)) {
    throw new Error("ffmpeg لم يُنشئ ملف المقطع");
  }
}

function isYoutubeSource(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "youtu.be" || host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com");
  } catch {
    return false;
  }
}

function resolveProcessingSource(source: string): string {
  if (source.startsWith("/")) {
    const port = process.env.PORT || "8080";
    return `http://127.0.0.1:${port}${source}`;
  }
  return source;
}

/** Extract audio from a browser-uploaded file URL or a public MP4/HLS/DASH
 * source. ffmpeg handles all of these protocols and containers directly. */
async function downloadGenericAudioSegment(
  source: string,
  startTime: number,
  outputPath: string,
): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-user_agent", "Mozilla/5.0",
    "-ss", String(startTime),
    "-i", resolveProcessingSource(source),
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

/** Returns true if the string contains at least a few Arabic characters */
function containsArabic(text: string): boolean {
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) ?? []).length;
  return arabicChars >= 3;
}

/**
 * Extract the Arabic translation from a prefilled response.
 * The model is seeded with "الترجمة: " so we strip that prefix if present.
 */
function extractFromPrefill(raw: string): string {
  return raw.replace(/^الترجمة\s*:\s*/u, "").trim();
}

/**
 * Attempt a single translation call using the assistant-prefill trick.
 * By seeding the assistant message with "الترجمة: " the model is forced to
 * continue with Arabic text — it cannot refuse because it has already "started"
 * its response with an Arabic word.
 */
async function attemptTranslation(
  text: string,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 2048,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
      // Assistant prefill — seeds the response so the model MUST continue in Arabic
      { role: "assistant", content: "الترجمة: " },
    ],
  });
  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  return extractFromPrefill(raw);
}

async function translateToArabic(text: string, videoUrl: string): Promise<string> {
  const previous = translationContexts.get(videoUrl) ?? [];

  // ── Attempt 1: full context, assistant-prefill ──────────────────────────
  const systemMain =
    "أنت مترجم ومحرر حوارات محترف لفيديوهات YouTube. " +
    "النص الذي يصلك هو تفريغ صوتي تلقائي، وقد يحتوي على أخطاء في السماع أو التهجئة، كلمات غير دقيقة، تكرار، علامات ترقيم مفقودة، أو جمل ناقصة ومقطوعة. " +
    "حوّل النص إلى ترجمة عربية فصحى واضحة ومفهومة ومترابطة وطبيعية، مناسبة للدبلجة الصوتية. " +
    "ترجم المعنى والسياق، وليس الكلمات حرفياً. " +
    "افهم المعنى من السياق العام ومن الترجمات السابقة، ثم أصلح الأخطاء الواضحة في التفريغ قبل الترجمة. " +
    "عند وجود كلمة غير واضحة، اختر أقرب معنى منطقي تدعمه الجملة والسياق؛ لا تترجم الخطأ حرفياً ولا تخترع أحداثاً أو معلومات غير موجودة. " +
    "إذا كانت الجملة ناقصة، حافظ على نقصها وقدّمها بصياغة عربية طبيعية من دون إكمالها بتخمين غير مؤكد. " +
    "حافظ على تسلسل الأفكار، ومرجع الضمائر، والزمن، ونبرة المتحدث، والعلاقة بين الجمل. " +
    "حافظ على أسماء الأشخاص والأماكن والعلامات التجارية والمصطلحات المهمة، وانقل العبارات الاصطلاحية إلى ما يقابلها عربياً بدلاً من ترجمتها حرفياً. " +
    "ترجم الحوار كما قيل، بما في ذلك العبارات الخيالية أو الدرامية أو العنيفة أو الحساسة، بصياغة لغوية محايدة وأمينة. " +
    "أخرج الترجمة العربية فقط، من دون شرح أو اعتذار أو تحذير أو تلخيص أو تعليق، ولا تكرر النص الأصلي.";

  let userContent: string;
  if (previous.length > 0) {
    const ctx = previous.slice(-5).join("\n---\n");
    userContent = `سياق الترجمات السابقة:\n${ctx}\n\nالنص:\n${text}`;
  } else {
    userContent = `النص:\n${text}`;
  }

  try {
    const result = await attemptTranslation(text, systemMain, userContent);
    if (result && containsArabic(result)) {
      return result;
    }
  } catch (err) {
    logger.warn({ err }, "Translation attempt 1 threw — retrying");
  }

  // ── Attempt 2: no context, simpler prompt ───────────────────────────────
  logger.warn({ text: text.slice(0, 80) }, "Translation attempt 1 non-Arabic — retrying");
  const systemSimple =
    "أنت مترجم محترف لحوار YouTube إلى العربية. " +
    "المدخل تفريغ صوتي آلي قد يكون فيه أخطاء أو كلمات مسموعة بشكل غير صحيح أو جمل ناقصة. " +
    "ترجم المعنى والسياق، وليس الكلمات حرفياً. استنتج المعنى الأقرب من سياق الجملة، أصلح الأخطاء الواضحة، ثم اكتب ترجمة عربية فصحى طبيعية ومترابطة مناسبة للكلام المسموع. " +
    "لا تضف معلومات من عندك، ولا تكمل الجملة الناقصة بتخمين غير مؤكد، ولا تترجم أخطاء التفريغ حرفياً. " +
    "حافظ على المعنى والنبرة والأسماء والمصطلحات. " +
    "أخرج الترجمة العربية فقط، دون شرح أو تلخيص أو اعتذار أو رفض أو أي نص باللغة الأصلية.";
  try {
    const result2 = await attemptTranslation(text, systemSimple, text);
    if (result2 && containsArabic(result2)) {
      return result2;
    }
  } catch (err) {
    logger.warn({ err }, "Translation attempt 2 threw — retrying");
  }

  // ── Attempt 3: few-shot examples to anchor the pattern ──────────────────
  logger.warn({ text: text.slice(0, 80) }, "Translation attempt 2 non-Arabic — few-shot retry");
  try {
    const response3 = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 2048,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "أنت مترجم محترف لحوارات YouTube إلى العربية. " +
            "النص الأخير تفريغ صوتي آلي قد يتضمن أخطاء سماع أو كلمات غير دقيقة أو جملة ناقصة. " +
            "ترجم المعنى والسياق، وليس الكلمات حرفياً. افهم السياق، أصلح الخطأ الواضح، وقدّم ترجمة عربية فصحى طبيعية ومترابطة تحافظ على المعنى والنبرة. " +
            "لا تخترع معلومات ولا تكمل الجمل الناقصة بتخمين، ولا تكتب شرحاً أو تلخيصاً أو اعتذاراً أو تحذيراً. " +
            "أخرج الترجمة العربية فقط، وترجم العبارات الخيالية والدرامية والحساسة ترجمة لغوية محايدة وأمينة.",
        },
        { role: "user", content: "I will protect my friends!" },
        { role: "assistant", content: "سأحمي أصدقائي!" },
        { role: "user", content: "The battle is about to begin." },
        { role: "assistant", content: "المعركة على وشك أن تبدأ." },
        { role: "user", content: "I will destroy you!" },
        { role: "assistant", content: "سأدمرك!" },
        { role: "user", content: "His power level is incredible." },
        { role: "assistant", content: "مستوى قوته لا يُصدق." },
        { role: "user", content: "They cannot escape the flame." },
        { role: "assistant", content: "لا يمكنهم الهروب من اللهب." },
        { role: "user", content: text },
        { role: "assistant", content: "" },
      ],
    });
    const result3 = response3.choices[0]?.message?.content?.trim() ?? "";
    if (result3 && containsArabic(result3)) {
      return result3;
    }
  } catch (err) {
    logger.warn({ err }, "Translation attempt 3 threw");
  }

  // ── All failed — silence is better than the original language ───────────
  logger.error({ text: text.slice(0, 80) }, "All translation attempts failed — producing silence");
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
    // Step 1: Download only the needed segment. YouTube uses its CDN URL
    // cache; other supported media sources go directly through ffmpeg.
    const youtubeSource = isYoutubeSource(videoUrl);
    const needsUrlFetch = youtubeSource && !directUrlCache.has(videoUrl) && !directUrlInFlight.has(videoUrl);
    updateJob(jobId, {
      status: "processing",
      progress: needsUrlFetch
        ? "جاري الحصول على رابط الصوت من يوتيوب..."
        : "جاري تنزيل مقطع الصوت..."
    });
    if (youtubeSource) {
      await downloadAudioSegment(videoUrl, startTime, rawAudioPath);
    } else {
      await downloadGenericAudioSegment(videoUrl, startTime, rawAudioPath);
    }

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
