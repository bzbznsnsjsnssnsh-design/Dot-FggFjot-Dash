import { createHash, randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import { db, openAiDubbingJobs, type OpenAiDubbingJob } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { speechToText, textToSpeech } from "@workspace/integrations-openai-ai-server/audio";
import { logger } from "../../lib/logger.js";
import { deleteStoredObject, storeBuffer } from "../../lib/openai-dubbing-storage.js";

const execFileAsync = promisify(execFile);
const MAX_ATTEMPTS = 2;
const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LEASE_MS = 60_000;
const WORKER_CONCURRENCY = 2;

export const OPENAI_DUBBING_OPTIONS = {
  sttModels: [
    { id: "gpt-4o-mini-transcribe", name: "GPT-4o mini Transcribe" },
  ],
  textModels: [
    { id: "gpt-5-mini", name: "GPT-5 mini" },
    { id: "gpt-5-nano", name: "GPT-5 nano" },
    { id: "gpt-4o-mini", name: "GPT-4o mini" },
  ],
  ttsModel: "gpt-audio",
  voices: [
    { id: "alloy", name: "ألاوي" },
    { id: "echo", name: "إيكو" },
    { id: "fable", name: "فايبل" },
    { id: "onyx", name: "أونيكس" },
    { id: "nova", name: "نوفا" },
    { id: "shimmer", name: "شيمر" },
  ],
};

type Utterance = {
  originalText: string;
  arabicText: string;
  spokenText: string;
};

type TimedUtterance = Utterance & {
  startOffset: number;
  endOffset: number;
};

type SpeechPlan = {
  recommendedEndOffset: number;
  utterances: TimedUtterance[];
  boundaryReason: string;
};

function makeUtteranceId(segmentId: string, originalText: string, arabicText: string): string {
  const digest = createHash("sha1")
    .update(`${originalText}\u0000${arabicText}`)
    .digest("hex")
    .slice(0, 12);
  return `${segmentId}-${digest}`;
}

type SyncDecision = {
  action: "keep" | "rewrite" | "slow_video";
  rewrittenText: string;
  recommendedVideoRate: number;
  recommendedAudioSpeed: number;
  reason: string;
};

function assertArabic(text: string, label: string): void {
  if ((text.match(/[\u0600-\u06FF]/g) ?? []).length < 3) {
    throw new Error(`${label} لم ينتج نصًا عربيًا صالحًا.`);
  }
}

function parseJsonObject<T>(content: string | null | undefined): T {
  if (!content) throw new Error("OpenAI أعاد استجابة فارغة.");
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("استجابة التحليل ليست JSON صالحًا.");
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

async function requestJson<T>(
  model: string,
  systemPrompt: string,
  userPayload: unknown,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await openai.chat.completions.create({
        model,
        max_completion_tokens: 4096,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
      });
      return parseJsonObject<T>(response.choices[0]?.message?.content);
    } catch (err) {
      lastError = err;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function requestTranslation(
  model: string,
  transcript: string,
  previousTranslations: string[],
): Promise<string> {
  const context = previousTranslations.length
    ? `\n\nسياق الترجمات السابقة لنفس المصدر:\n${previousTranslations.join("\n---\n")}`
    : "";
  const response = await openai.chat.completions.create({
    model,
    max_completion_tokens: 4096,
    messages: [
      {
        role: "system",
        content:
          "أنت مترجم حوار محترف للدبلجة العربية. ترجم المعنى والسياق إلى عربية حديثة طبيعية عند السماع، " +
          "وحافظ على المعنى والعاطفة وتسلسل الحوار وأسماء الشخصيات والمصطلحات. لا تضف معلومات ولا تلخص. " +
          "أخرج الترجمة العربية فقط دون شرح.",
      },
      {
        role: "user",
        content: `النص الأصلي:\n${transcript}${context}`,
      },
    ],
  });
  const translated = response.choices[0]?.message?.content?.trim() ?? "";
  assertArabic(translated, "الترجمة");
  return translated;
}

async function prepareSpeech(
  model: string,
  transcript: string,
  translation: string,
): Promise<Utterance[]> {
  const result = await requestJson<{ utterances?: Utterance[] }>(
    model,
    "جهّز ترجمة عربية للدبلجة. أزل الحشو غير المهم فقط، صحح الصياغة، واجعل الكلام طبيعيًا ومختصرًا دون تغيير المعنى أو العاطفة. " +
      "قسّم الجمل الطويلة إلى وحدات حوارية معقولة وادمج الشذرات القصيرة عند الحاجة. أعد JSON فقط بالشكل " +
      '{"utterances":[{"originalText":"...","arabicText":"...","spokenText":"..."}]}. ' +
      "لا تخترع توقيتات؛ هذه الخطوة لمعالجة النص فقط.",
    { transcript, translation },
  );
  const utterances = (result.utterances ?? [])
    .filter(item => typeof item.spokenText === "string" && item.spokenText.trim())
    .map(item => ({
      originalText: String(item.originalText ?? ""),
      arabicText: String(item.arabicText ?? item.spokenText).trim(),
      spokenText: String(item.spokenText).trim(),
    }));
  if (utterances.length === 0) throw new Error("لم يُنتج تجهيز النص أي جمل للنطق.");
  assertArabic(utterances.map(item => item.spokenText).join(" "), "تجهيز النطق");
  return utterances;
}

async function planSpeechTiming(
  model: string,
  data: {
    startTime: number;
    audioDuration: number;
    maxSegmentSeconds: number;
    silenceEndCandidates: number[];
    transcript: string;
    utterances: Utterance[];
  },
): Promise<SpeechPlan> {
  const result = await requestJson<{
    recommendedEndOffset?: number;
    utterances?: Array<{ startOffset?: number; endOffset?: number }>;
    boundaryReason?: string;
  }>(
    model,
    "خطط مقطع دبلجة متغير الطول ضمن نافذة صوتية محدودة. لا تعتمد تقسيمًا ثابتًا: اختر نهاية بين 15 ثانية والحد الأقصى " +
      "(أو نهاية الصوت إذا كانت أقصر) وفضّل نقاط الصمت المقدمة. وزّع الجمل زمنيًا كتقدير تقريبي بحسب طولها وترتيبها؛ " +
      "لا تدّعِ أن هذه أختام زمنية دقيقة من نموذج التفريغ. لا تقطع جملة إلا عند الضرورة. أعد JSON فقط بالشكل " +
      '{"recommendedEndOffset":35,"boundaryReason":"...","utterances":[{"startOffset":0,"endOffset":4}]}. ' +
      "يجب أن يعيد utterances عنصرًا مقابلًا لكل جملة وبالترتيب.",
    data,
  );

  const maxOffset = Math.max(0.5, Math.min(data.audioDuration, data.maxSegmentSeconds));
  const minOffset = Math.min(15, maxOffset);
  const rawEnd = Number(result.recommendedEndOffset);
  const recommendedEndOffset = Number.isFinite(rawEnd)
    ? Math.min(maxOffset, Math.max(minOffset, rawEnd))
    : maxOffset;
  const rawTimings = result.utterances ?? [];
  const weights = data.utterances.map(item => Math.max(1, item.spokenText.length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  const utterances = data.utterances.map((item, index) => {
    const raw = rawTimings[index];
    const estimatedStart = raw ? Number(raw.startOffset) : cursor;
    const estimatedEnd = raw ? Number(raw.endOffset) : cursor + maxOffset * weights[index] / totalWeight;
    const startOffset = Math.max(0, Math.min(maxOffset, Number.isFinite(estimatedStart) ? estimatedStart : cursor));
    const endOffset = Math.max(startOffset + 0.1, Math.min(
      maxOffset,
      Number.isFinite(estimatedEnd) ? estimatedEnd : cursor + maxOffset * weights[index] / totalWeight,
    ));
    cursor = endOffset;
    return { ...item, startOffset, endOffset };
  });
  return {
    recommendedEndOffset,
    utterances,
    boundaryReason: String(result.boundaryReason ?? "حدّ مقترح من تحليل OpenAI"),
  };
}

async function detectSilenceEndCandidates(audioPath: string): Promise<number[]> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-i", audioPath,
      "-af", "silencedetect=n=-32dB:d=0.35",
      "-f", "null",
      "-",
    ], { maxBuffer: 2 * 1024 * 1024 });
    return [...stderr.matchAll(/silence_end:\s*([0-9.]+)/g)]
      .map(match => Number(match[1]))
      .filter(Number.isFinite);
  } catch (err) {
    logger.warn({ err }, "OpenAI dubbing silence detection failed; continuing without pause candidates");
    return [];
  }
}

function resolveLocalSource(sourceUrl: string): string {
  if (!sourceUrl.startsWith("/")) return sourceUrl;
  const port = process.env.PORT || "8080";
  return `http://127.0.0.1:${port}${sourceUrl}`;
}

async function getYoutubeDirectUrl(videoUrl: string): Promise<string> {
  const { stdout } = await execFileAsync("yt-dlp", [
    "--extractor-args", "youtube:player_client=android;formats=missing_pot",
    "-f", "bestaudio[ext=m4a]/bestaudio",
    "--get-url",
    "--no-playlist",
    videoUrl,
  ], { maxBuffer: 2 * 1024 * 1024 });
  const directUrl = stdout.trim().split("\n")[0];
  if (!directUrl) throw new Error("تعذر الحصول على رابط الصوت من YouTube.");
  return directUrl;
}

function isYoutubeSource(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "youtu.be" || host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com");
  } catch {
    return false;
  }
}

async function extractSegmentAudio(sourceUrl: string, startTime: number, duration: number, outputPath: string) {
  const resolveInput = async () => isYoutubeSource(sourceUrl)
    ? await getYoutubeDirectUrl(sourceUrl)
    : resolveLocalSource(sourceUrl);
  const run = async (input: string) => execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-user_agent", "Mozilla/5.0",
    "-ss", String(startTime),
    "-i", input,
    "-t", String(duration),
    "-vn",
    "-ar", "16000",
    "-ac", "1",
    "-acodec", "libmp3lame",
    "-q:a", "3",
    "-y",
    outputPath,
  ], { maxBuffer: 4 * 1024 * 1024 });

  let input = await resolveInput();
  try {
    await run(input);
  } catch (err) {
    const errorText = String(err);
    if (!isYoutubeSource(sourceUrl) || !/(HTTP error 5\d\d|Server returned 5\d\d|403 Forbidden)/i.test(errorText)) {
      throw err;
    }
    input = await getYoutubeDirectUrl(sourceUrl);
    await run(input);
  }
}

async function getAudioDuration(audioPath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    audioPath,
  ], { maxBuffer: 1024 * 1024 });
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("تعذر قياس مدة الصوت الناتج.");
  return duration;
}

async function analyzeSynchronization(
  job: OpenAiDubbingJob,
  data: {
    segmentDuration: number;
    ttsDuration: number;
    preparedText: string;
    speechTimings: Array<{
      utteranceId: string;
      startTime: number;
      endTime: number;
      originalText: string;
      arabicText: string;
    }>;
  },
): Promise<SyncDecision> {
  const decision = await requestJson<Partial<SyncDecision>>(
    job.analysisModel,
    "حلّل توافق صوت الدبلجة مع نافذة الفيديو. قرر keep أو rewrite أو slow_video. " +
      "إذا كان النص العربي طويلًا نسبة للوقت فاختر rewrite واكتب نسخة مختصرة أمينة. " +
      "إذا كانت إعادة الصياغة غير كافية فاختر slow_video. أعد سرعة فيديو وصوت موجبة ضمن 0.5..2 للفيديو و0.75..1.5 للصوت، " +
      "مع سبب موجز. لا تقترح مزودًا آخر ولا تغيّر المعنى. أعد JSON فقط بالشكل " +
      '{"action":"keep","rewrittenText":"","recommendedVideoRate":1,"recommendedAudioSpeed":1,"reason":"..."}.',
    {
      segmentDuration: data.segmentDuration,
      ttsDuration: data.ttsDuration,
      requestedVideoRate: job.requestedVideoRate,
      requestedAudioSpeed: job.requestedAudioSpeed,
      manualOffset: job.manualOffset,
      preparedText: data.preparedText,
      speechTimings: data.speechTimings,
    },
  );
  const validActions = new Set(["keep", "rewrite", "slow_video"]);
  return {
    action: validActions.has(String(decision.action)) ? decision.action as SyncDecision["action"] : "slow_video",
    rewrittenText: String(decision.rewrittenText ?? "").trim(),
    recommendedVideoRate: Number(decision.recommendedVideoRate),
    recommendedAudioSpeed: Number(decision.recommendedAudioSpeed),
    reason: String(decision.reason ?? "تحليل المزامنة"),
  };
}

async function getPreviousTranslations(job: OpenAiDubbingJob): Promise<string[]> {
  const previous = await db
    .select({ arabicText: openAiDubbingJobs.arabicText })
    .from(openAiDubbingJobs)
    .where(and(
      eq(openAiDubbingJobs.sourceUrl, job.sourceUrl),
      eq(openAiDubbingJobs.status, "completed"),
    ))
    .orderBy(desc(openAiDubbingJobs.createdAt))
    .limit(5);
  return previous.map(item => item.arabicText ?? "").filter(Boolean).reverse();
}

async function stillActive(jobId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: openAiDubbingJobs.status })
    .from(openAiDubbingJobs)
    .where(eq(openAiDubbingJobs.jobId, jobId))
    .limit(1);
  return row?.status === "processing";
}

async function updateProgress(jobId: string, progress: string): Promise<void> {
  await db.update(openAiDubbingJobs)
    .set({
      progress,
      updatedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
    })
    .where(and(
      eq(openAiDubbingJobs.jobId, jobId),
      eq(openAiDubbingJobs.status, "processing"),
    ));
}

async function processOpenAiDubbingJob(job: OpenAiDubbingJob): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "openai-dub-"));
  const sourceAudioPath = join(tempDir, "source.mp3");
  const cleanAudioPath = join(tempDir, "clean.mp3");
  const speechPath = join(tempDir, "dub.mp3");
  let audioObjectKey: string | null = null;

  try {
    const duration = job.maxSegmentSeconds;
    await updateProgress(job.jobId, "جاري استخراج مقطع الصوت...");
    await extractSegmentAudio(job.sourceUrl, job.startTime, duration, sourceAudioPath);
    const { stdout: extractedDurationText } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      sourceAudioPath,
    ], { maxBuffer: 1024 * 1024 });
    const extractedDuration = Number(extractedDurationText.trim());
    if (!Number.isFinite(extractedDuration) || extractedDuration < 0.5) {
      throw new Error("لم يتبقّ صوت عند موضع البدء المحدد.");
    }

    await updateProgress(job.jobId, "جاري تنقية الصوت...");
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-i", sourceAudioPath,
      "-af", "highpass=f=80,lowpass=f=8000,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11",
      "-ar", "16000",
      "-ac", "1",
      "-y",
      cleanAudioPath,
    ], { maxBuffer: 2 * 1024 * 1024 });
    const silenceEndCandidates = await detectSilenceEndCandidates(cleanAudioPath);

    await updateProgress(job.jobId, "جاري تفريغ الكلام باستخدام OpenAI...");
    const transcript = (await speechToText(await readFile(cleanAudioPath), "mp3")).trim();
    if (!transcript) throw new Error("لم يتم التعرف على كلام في هذا المقطع.");
    await db.update(openAiDubbingJobs)
      .set({ originalText: transcript, updatedAt: new Date() })
      .where(eq(openAiDubbingJobs.jobId, job.jobId));

    await updateProgress(job.jobId, "جاري فهم السياق وترجمة الحوار...");
    const translation = await requestTranslation(
      job.translationModel,
      transcript,
      await getPreviousTranslations(job),
    );
    await db.update(openAiDubbingJobs)
      .set({ arabicText: translation, updatedAt: new Date() })
      .where(eq(openAiDubbingJobs.jobId, job.jobId));

    await updateProgress(job.jobId, "جاري تجهيز النص العربي للنطق...");
    const utterances = await prepareSpeech(job.preparationModel, transcript, translation);

    await updateProgress(job.jobId, "جاري تحليل حدود المقطع والتوقيت...");
    const speechPlan = await planSpeechTiming(job.analysisModel, {
      startTime: job.startTime,
      audioDuration: extractedDuration,
      maxSegmentSeconds: job.maxSegmentSeconds,
      silenceEndCandidates,
      transcript,
      utterances,
    });
    let timed = speechPlan.utterances;
    let selected = timed.filter(item => item.startOffset < speechPlan.recommendedEndOffset);
    if (selected.length === 0) {
      selected = [timed[0]];
      speechPlan.recommendedEndOffset = Math.min(extractedDuration, Math.max(1, selected[0].endOffset));
    }
    const lastSelected = selected[selected.length - 1];
    const endOffset = Math.max(
      Math.min(0.5, extractedDuration),
      Math.min(extractedDuration, job.maxSegmentSeconds, Math.max(
        speechPlan.recommendedEndOffset,
        lastSelected.endOffset,
      )),
    );
    selected = selected.filter(item => item.startOffset < endOffset);
    let preparedText = selected.map(item => item.spokenText).join(" ").trim();
    assertArabic(preparedText, "النص الجاهز للنطق");

    const speechTimings = selected.map(item => ({
      utteranceId: makeUtteranceId(job.segmentId, item.originalText, item.arabicText),
      startTime: job.startTime + Math.min(endOffset, item.startOffset),
      endTime: job.startTime + Math.min(endOffset, Math.max(item.startOffset + 0.1, item.endOffset)),
      originalText: item.originalText,
      arabicText: item.arabicText,
    }));
    const segmentDuration = endOffset;

    await updateProgress(job.jobId, "جاري توليد الدبلجة بصوت OpenAI...");
    let speechBuffer = await textToSpeech(preparedText, job.voice as "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer", "mp3");
    if (!speechBuffer.length) throw new Error("لم يُنتج OpenAI ملفًا صوتيًا.");
    await writeFile(speechPath, speechBuffer);
    let ttsDuration = await getAudioDuration(speechPath);

    await updateProgress(job.jobId, "جاري تحليل المزامنة ومدة النطق...");
    let syncDecision = await analyzeSynchronization(job, {
      segmentDuration,
      ttsDuration,
      preparedText,
      speechTimings,
    });

    const fitsRequestedRates = (durationSeconds: number) =>
      durationSeconds / job.requestedAudioSpeed <= segmentDuration / job.requestedVideoRate + 0.15;

    let finalVideoRate = job.requestedVideoRate;
    let finalAudioSpeed = job.requestedAudioSpeed;
    if (!fitsRequestedRates(ttsDuration) && syncDecision.action === "rewrite" &&
      syncDecision.rewrittenText && syncDecision.rewrittenText.length < preparedText.length) {
      assertArabic(syncDecision.rewrittenText, "إعادة صياغة المزامنة");
      preparedText = syncDecision.rewrittenText;
      speechBuffer = await textToSpeech(preparedText, job.voice as "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer", "mp3");
      if (!speechBuffer.length) throw new Error("فشل إعادة توليد الصوت العربي.");
      await writeFile(speechPath, speechBuffer);
      ttsDuration = await getAudioDuration(speechPath);
      if (!fitsRequestedRates(ttsDuration)) {
        syncDecision = await analyzeSynchronization(job, {
          segmentDuration,
          ttsDuration,
          preparedText,
          speechTimings,
        });
      }
    }

    if (!fitsRequestedRates(ttsDuration)) {
      const modelVideoRate = Number(syncDecision.recommendedVideoRate);
      const modelAudioSpeed = Number(syncDecision.recommendedAudioSpeed);
      const safeAudioSpeed = Number.isFinite(modelAudioSpeed)
        ? Math.min(1.5, Math.max(0.75, modelAudioSpeed))
        : job.requestedAudioSpeed;
      const modelRate = Number.isFinite(modelVideoRate)
        ? Math.min(job.requestedVideoRate, Math.max(0.5, modelVideoRate))
        : job.requestedVideoRate;
      const rateNeededToFit = segmentDuration * safeAudioSpeed / ttsDuration;
      finalAudioSpeed = safeAudioSpeed;
      finalVideoRate = Math.min(modelRate, rateNeededToFit);
      if (syncDecision.action !== "slow_video" && finalVideoRate < job.requestedVideoRate) {
        syncDecision = {
          ...syncDecision,
          action: "slow_video",
          reason: `${syncDecision.reason}; خُفّضت سرعة الفيديو تقنيًا لمنع تداخل الصوت مع المقطع التالي.`,
        };
      }
      if (finalVideoRate < 0.5 || !Number.isFinite(finalVideoRate)) {
        throw new Error("الصوت أطول من المقطع حتى بعد إعادة الصياغة وضبط السرعة؛ لم يُسمح بتداخله مع التالي.");
      }
    }

    if (!(await stillActive(job.jobId))) {
      return;
    }
    audioObjectKey = `openai-dubbing/audio/${job.jobId}.mp3`;
    await storeBuffer(audioObjectKey, speechBuffer, "audio/mpeg");
    const expiresAt = new Date(Date.now() + JOB_TTL_MS);
    await db.update(openAiDubbingJobs)
      .set({
        status: "completed",
        progress: "اكتمل المقطع",
        endTime: job.startTime + segmentDuration,
        preparedText,
        speechTimings,
        synchronizationData: {
          sourceTiming: "estimated-by-openai",
          detectedSilenceEnds: silenceEndCandidates,
          candidateDuration: extractedDuration,
          chosenDuration: segmentDuration,
          boundaryReason: speechPlan.boundaryReason,
          syncAction: syncDecision.action,
          syncReason: syncDecision.reason,
          timingFormula: "videoTime = segmentStart + (audioTime / audioDuration) * segmentDuration + manualOffset",
        },
        audioObjectKey,
        audioDuration: ttsDuration,
        videoRate: finalVideoRate,
        audioSpeed: finalAudioSpeed,
        error: null,
        leaseExpiresAt: null,
        expiresAt,
        updatedAt: new Date(),
      })
      .where(and(
        eq(openAiDubbingJobs.jobId, job.jobId),
        eq(openAiDubbingJobs.status, "processing"),
      ));
    logger.info({ jobId: job.jobId, segmentDuration, audioDuration: ttsDuration }, "OpenAI dubbing segment completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const [latest] = await db.select().from(openAiDubbingJobs)
      .where(eq(openAiDubbingJobs.jobId, job.jobId)).limit(1);
    if (latest?.status === "cancelled") {
      if (audioObjectKey) await deleteStoredObject(audioObjectKey).catch(() => {});
      return;
    }
    const canRetry = Boolean(latest && latest.attempts < MAX_ATTEMPTS);
    logger.error({ jobId: job.jobId, err, retrying: canRetry }, "OpenAI dubbing segment failed");
    await db.update(openAiDubbingJobs)
      .set({
        status: canRetry ? "pending" : "failed",
        progress: canRetry ? "تعذرت المحاولة؛ ستتم إعادة المحاولة تلقائيًا..." : "فشل المقطع",
        error: message,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(openAiDubbingJobs.jobId, job.jobId));
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function claimNextJob(): Promise<OpenAiDubbingJob | null> {
  return db.transaction(async tx => {
    const [pending] = await tx
      .select()
      .from(openAiDubbingJobs)
      .where(eq(openAiDubbingJobs.status, "pending"))
      .orderBy(asc(openAiDubbingJobs.createdAt))
      .for("update", { skipLocked: true })
      .limit(1);
    if (!pending) return null;
    const [claimed] = await tx.update(openAiDubbingJobs)
      .set({
        status: "processing",
        progress: "بدأت المعالجة...",
        attempts: pending.attempts + 1,
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        updatedAt: new Date(),
      })
      .where(and(
        eq(openAiDubbingJobs.jobId, pending.jobId),
        eq(openAiDubbingJobs.status, "pending"),
      ))
      .returning();
    return claimed ?? null;
  });
}

let workerStarted = false;
let activeWorkers = 0;
let pumping = false;

async function pumpQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (activeWorkers < WORKER_CONCURRENCY) {
      const job = await claimNextJob();
      if (!job) break;
      activeWorkers += 1;
      void processOpenAiDubbingJob(job).finally(() => {
        activeWorkers -= 1;
        void pumpQueue();
      });
    }
  } catch (err) {
    logger.error({ err }, "OpenAI dubbing queue poll failed");
  } finally {
    pumping = false;
  }
}

async function recoverExpiredJobs(): Promise<void> {
  await db.update(openAiDubbingJobs)
    .set({
      status: "pending",
      progress: "استئناف مهمة محفوظة بعد إعادة تشغيل الخادم...",
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(openAiDubbingJobs.status, "processing"),
      lt(openAiDubbingJobs.leaseExpiresAt, new Date()),
    ));
}

async function cleanExpiredData(): Promise<void> {
  const now = new Date();
  const expiredJobs = await db.select({
    jobId: openAiDubbingJobs.jobId,
    audioObjectKey: openAiDubbingJobs.audioObjectKey,
  }).from(openAiDubbingJobs).where(lt(openAiDubbingJobs.expiresAt, now));
  for (const job of expiredJobs) {
    if (job.audioObjectKey) await deleteStoredObject(job.audioObjectKey).catch(err => {
      logger.warn({ jobId: job.jobId, err }, "Could not delete expired OpenAI dubbing audio");
    });
    await db.delete(openAiDubbingJobs).where(eq(openAiDubbingJobs.jobId, job.jobId));
  }
}

export function startOpenAiDubbingWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  void recoverExpiredJobs()
    .then(pumpQueue)
    .catch(err => logger.error({ err }, "OpenAI dubbing worker recovery failed"));
  const queueTimer = setInterval(() => {
    void recoverExpiredJobs().then(pumpQueue).catch(err => {
      logger.error({ err }, "OpenAI dubbing queue tick failed");
    });
  }, 5000);
  queueTimer.unref();
  const cleanupTimer = setInterval(() => {
    void cleanExpiredData().catch(err => logger.error({ err }, "OpenAI dubbing cleanup failed"));
  }, 60 * 60 * 1000);
  cleanupTimer.unref();
  void cleanExpiredData().catch(err => logger.error({ err }, "OpenAI dubbing startup cleanup failed"));
}

export async function getAudioObjectKey(jobId: string): Promise<string | null> {
  const [job] = await db.select({
    status: openAiDubbingJobs.status,
    audioObjectKey: openAiDubbingJobs.audioObjectKey,
  }).from(openAiDubbingJobs).where(eq(openAiDubbingJobs.jobId, jobId)).limit(1);
  return job?.status === "completed" ? job.audioObjectKey : null;
}

export function makeJobId(): { jobId: string; segmentId: string } {
  return { jobId: randomUUID(), segmentId: randomUUID() };
}