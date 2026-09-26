import express, { Router, type IRouter } from "express";
import { extname } from "path";
import { randomUUID } from "crypto";
import { and, eq, gt, inArray } from "drizzle-orm";
import {
  CreateOpenAiDubbingJobBody,
  GetOpenAiDubbingJobParams,
  CancelOpenAiDubbingJobParams,
  PreviewOpenAiDubbingVoiceBody,
  UploadOpenAiDubbingMediaQueryParams,
  GetOpenAiDubbingMediaParams,
} from "@workspace/api-zod";
import { db, openAiDubbingJobs, openAiDubbingMedia } from "@workspace/db";
import { textToSpeech } from "@workspace/integrations-openai-ai-server/audio";
import { logger } from "../../lib/logger.js";
import {
  deleteStoredObject,
  getObjectMetadata,
  objectReadStream,
  storeBuffer,
} from "../../lib/openai-dubbing-storage.js";
import {
  makeJobId,
  OPENAI_DUBBING_OPTIONS,
  startOpenAiDubbingWorker,
  getAudioObjectKey,
} from "./processor.js";

const router: IRouter = Router();
const MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function jobResponse(job: typeof openAiDubbingJobs.$inferSelect) {
  return {
    jobId: job.jobId,
    segmentId: job.segmentId,
    status: job.status,
    progress: job.progress,
    startTime: job.startTime,
    endTime: job.endTime,
    originalText: job.originalText,
    arabicText: job.arabicText,
    preparedText: job.preparedText,
    speechTimings: job.speechTimings,
    synchronizationData: job.synchronizationData,
    audioUrl: job.status === "completed"
      ? `/api/openai-dubbing/jobs/${job.jobId}/audio`
      : null,
    audioDuration: job.audioDuration,
    videoRate: job.videoRate,
    audioSpeed: job.audioSpeed,
    error: job.error,
  };
}

router.get("/openai-dubbing/options", (_req, res) => {
  res.json(OPENAI_DUBBING_OPTIONS);
});

router.post("/openai-dubbing/upload", express.raw({
  type: "*/*",
  limit: MAX_UPLOAD_BYTES,
}), async (req, res) => {
  const parsed = UploadOpenAiDubbingMediaQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }

  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? []);
  const contentType = typeof req.headers["content-type"] === "string"
    ? req.headers["content-type"].split(";")[0]
    : "application/octet-stream";
  if (!body.length) {
    res.status(400).json({ error: "empty_file", message: "ملف الفيديو فارغ" });
    return;
  }
  if (body.length > MAX_UPLOAD_BYTES) {
    res.status(413).json({ error: "file_too_large", message: "حجم الفيديو أكبر من الحد المسموح" });
    return;
  }
  if (!contentType.startsWith("video/") && contentType !== "application/octet-stream") {
    res.status(400).json({ error: "invalid_media_type", message: "يجب رفع ملف فيديو" });
    return;
  }

  const mediaId = randomUUID();
  const safeExtension = extname(parsed.data.filename).toLowerCase().replace(/[^a-z0-9.]/gi, "") || ".mp4";
  const objectKey = `openai-dubbing/media/${mediaId}${safeExtension}`;
  const expiresAt = new Date(Date.now() + MEDIA_TTL_MS);

  try {
    await storeBuffer(objectKey, body, contentType);
    await db.insert(openAiDubbingMedia).values({
      mediaId,
      objectKey,
      filename: parsed.data.filename,
      contentType,
      size: body.length,
      expiresAt,
    });
    res.status(201).json({
      mediaId,
      sourceUrl: `/api/openai-dubbing/media/${mediaId}`,
      contentType,
      size: body.length,
    });
  } catch (error) {
    await deleteStoredObject(objectKey).catch(() => {});
    logger.error({ error, mediaId }, "OpenAI dubbing upload failed");
    res.status(500).json({ error: "upload_failed", message: "تعذر حفظ الفيديو في التخزين الدائم" });
  }
});

router.get("/openai-dubbing/media/:mediaId", async (req, res) => {
  const parsed = GetOpenAiDubbingMediaParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }
  const [media] = await db.select().from(openAiDubbingMedia)
    .where(eq(openAiDubbingMedia.mediaId, parsed.data.mediaId))
    .limit(1);
  if (!media || media.expiresAt < new Date()) {
    res.status(404).json({ error: "not_found", message: "الفيديو غير متوفر" });
    return;
  }

  const rangeHeader = req.headers.range;
  const totalSize = media.size;
  let range: { start: number; end: number } | undefined;
  if (typeof rangeHeader === "string") {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader);
    if (match) {
      const requestedStart = match[1] ? Number(match[1]) : 0;
      const requestedEnd = match[2] ? Number(match[2]) : totalSize - 1;
      const start = Math.max(0, requestedStart);
      const end = Math.min(totalSize - 1, requestedEnd);
      if (start <= end && start < totalSize) range = { start, end };
    }
  }

  try {
    const metadata = await getObjectMetadata(media.objectKey);
    const contentType = metadata.contentType || media.contentType;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (range) {
      res.status(206);
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${totalSize}`);
      res.setHeader("Content-Length", String(range.end - range.start + 1));
    } else {
      res.setHeader("Content-Length", String(totalSize));
    }
    objectReadStream(media.objectKey, range).on("error", error => {
      logger.warn({ error, mediaId: media.mediaId }, "OpenAI dubbing media stream failed");
      if (!res.headersSent) res.status(404).json({ error: "not_found", message: "تعذر قراءة الفيديو" });
    }).pipe(res);
  } catch (error) {
    logger.warn({ error, mediaId: media.mediaId }, "OpenAI dubbing media lookup failed");
    res.status(404).json({ error: "not_found", message: "تعذر قراءة الفيديو" });
  }
});

router.post("/openai-dubbing/jobs", async (req, res) => {
  const parsed = CreateOpenAiDubbingJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }
  const input = parsed.data;
  if (!OPENAI_DUBBING_OPTIONS.textModels.some(model => model.id === input.translationModel) ||
      !OPENAI_DUBBING_OPTIONS.textModels.some(model => model.id === input.preparationModel) ||
      !OPENAI_DUBBING_OPTIONS.textModels.some(model => model.id === input.analysisModel)) {
    res.status(400).json({ error: "unsupported_model", message: "نموذج OpenAI النصي المحدد غير متاح" });
    return;
  }
  const matchingJobs = await db.select().from(openAiDubbingJobs)
    .where(and(
      eq(openAiDubbingJobs.sourceUrl, input.sourceUrl),
      eq(openAiDubbingJobs.startTime, input.startTime),
      eq(openAiDubbingJobs.sttModel, input.sttModel),
      eq(openAiDubbingJobs.translationModel, input.translationModel),
      eq(openAiDubbingJobs.preparationModel, input.preparationModel),
      eq(openAiDubbingJobs.analysisModel, input.analysisModel),
      eq(openAiDubbingJobs.voice, input.voice),
      eq(openAiDubbingJobs.requestedVideoRate, input.videoRate),
      eq(openAiDubbingJobs.requestedAudioSpeed, input.audioSpeed),
      eq(openAiDubbingJobs.manualOffset, input.manualOffset),
      eq(openAiDubbingJobs.maxSegmentSeconds, input.maxSegmentSeconds),
      inArray(openAiDubbingJobs.status, ["pending", "processing", "completed"]),
      gt(openAiDubbingJobs.expiresAt, new Date()),
    ))
    .limit(1);
  const reusable = matchingJobs[0];
  if (reusable) {
    res.status(202).json({
      jobId: reusable.jobId,
      segmentId: reusable.segmentId,
      status: "pending",
      startTime: reusable.startTime,
    });
    return;
  }
  const { jobId, segmentId } = makeJobId();
  try {
    await db.insert(openAiDubbingJobs).values({
      jobId,
      segmentId,
      sourceUrl: input.sourceUrl,
      startTime: input.startTime,
      status: "pending",
      progress: "في قائمة الانتظار",
      sttModel: input.sttModel,
      translationModel: input.translationModel,
      preparationModel: input.preparationModel,
      analysisModel: input.analysisModel,
      voice: input.voice,
      requestedVideoRate: input.videoRate,
      videoRate: input.videoRate,
      requestedAudioSpeed: input.audioSpeed,
      audioSpeed: input.audioSpeed,
      manualOffset: input.manualOffset,
      maxSegmentSeconds: input.maxSegmentSeconds,
      expiresAt: new Date(Date.now() + MEDIA_TTL_MS),
    });
    res.status(202).json({
      jobId,
      segmentId,
      status: "pending",
      startTime: input.startTime,
    });
  } catch (error) {
    logger.error({ error, jobId }, "OpenAI dubbing job creation failed");
    res.status(500).json({ error: "job_creation_failed", message: "تعذر إنشاء مهمة الدبلجة" });
  }
});

router.get("/openai-dubbing/jobs/:jobId", async (req, res) => {
  const parsed = GetOpenAiDubbingJobParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }
  const [job] = await db.select().from(openAiDubbingJobs)
    .where(eq(openAiDubbingJobs.jobId, parsed.data.jobId))
    .limit(1);
  if (!job) {
    res.status(404).json({ error: "not_found", message: "مهمة الدبلجة غير موجودة" });
    return;
  }
  res.json(jobResponse(job));
});

router.post("/openai-dubbing/jobs/:jobId/cancel", async (req, res) => {
  const parsed = CancelOpenAiDubbingJobParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }
  const [job] = await db.update(openAiDubbingJobs)
    .set({
      status: "cancelled",
      progress: "أُلغي المقطع",
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(openAiDubbingJobs.jobId, parsed.data.jobId),
      eq(openAiDubbingJobs.status, "pending"),
    ))
    .returning({ jobId: openAiDubbingJobs.jobId });
  if (!job) {
    const [existing] = await db.select({ jobId: openAiDubbingJobs.jobId, status: openAiDubbingJobs.status })
      .from(openAiDubbingJobs).where(eq(openAiDubbingJobs.jobId, parsed.data.jobId)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "not_found", message: "مهمة الدبلجة غير موجودة" });
      return;
    }
    if (existing.status !== "processing") {
      res.json({ jobId: existing.jobId, status: existing.status });
      return;
    }
    await db.update(openAiDubbingJobs).set({
      status: "cancelled",
      progress: "أُلغي المقطع",
      leaseExpiresAt: null,
      updatedAt: new Date(),
    }).where(eq(openAiDubbingJobs.jobId, existing.jobId));
    res.json({ jobId: existing.jobId, status: "cancelled" });
    return;
  }
  res.json({ jobId: job.jobId, status: "cancelled" });
});

router.get("/openai-dubbing/jobs/:jobId/audio", async (req, res) => {
  const parsed = GetOpenAiDubbingJobParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }
  const objectKey = await getAudioObjectKey(parsed.data.jobId);
  if (!objectKey) {
    res.status(404).json({ error: "not_found", message: "صوت الدبلجة غير جاهز" });
    return;
  }
  try {
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    objectReadStream(objectKey).on("error", error => {
      logger.warn({ error, jobId: parsed.data.jobId }, "OpenAI dubbing audio stream failed");
      if (!res.headersSent) res.status(404).json({ error: "not_found", message: "الصوت غير متوفر" });
    }).pipe(res);
  } catch (error) {
    res.status(404).json({ error: "not_found", message: "الصوت غير متوفر" });
  }
});

router.post("/openai-dubbing/preview", async (req, res) => {
  const parsed = PreviewOpenAiDubbingVoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }
  try {
    const audio = await textToSpeech(
      parsed.data.text?.trim() || "هذه معاينة لصوت الدبلجة العربي.",
      parsed.data.voice,
      "mp3",
    );
    if (!audio.length) {
      res.status(502).json({ error: "preview_failed", message: "لم يُنتج OpenAI ملف المعاينة" });
      return;
    }
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(audio);
  } catch (error) {
    logger.error({ error }, "OpenAI dubbing voice preview failed");
    res.status(502).json({ error: "preview_failed", message: "تعذر إنشاء معاينة الصوت من OpenAI" });
  }
});

startOpenAiDubbingWorker();

export default router;