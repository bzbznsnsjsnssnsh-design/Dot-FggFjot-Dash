import { Router, type IRouter } from "express";
import { createReadStream, existsSync, unlinkSync } from "fs";
import {
  ProcessVideoBody,
  GetJobStatusParams,
  GetAudioParams,
} from "@workspace/api-zod";
import { createJob, getJob } from "./jobs.js";
import { processVideoSegment, getAudioPath, TTS_MODELS, generatePreview } from "./processor.js";

const router: IRouter = Router();

router.get("/translate/models", (_req, res) => {
  res.json({ models: TTS_MODELS });
});

router.post("/translate/preview", async (req, res) => {
  const voiceId = typeof req.body?.voiceId === "string" ? req.body.voiceId : "";
  if (!voiceId) {
    res.status(400).json({ error: "validation_error", message: "voiceId required" });
    return;
  }

  try {
    const previewPath = await generatePreview(voiceId);
    if (!existsSync(previewPath)) {
      res.status(500).json({ error: "preview_failed", message: "فشل توليد المعاينة" });
      return;
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-cache");
    const stream = createReadStream(previewPath);
    stream.on("close", () => {
      try { unlinkSync(previewPath); } catch { /* ignore */ }
    });
    stream.pipe(res);
  } catch (err: any) {
    res.status(500).json({ error: "preview_failed", message: err.message });
  }
});

router.post("/translate/process", async (req, res) => {
  const parsed = ProcessVideoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }

  const { videoUrl, startTime, model, voice } = parsed.data;

  const job = createJob(startTime);

  processVideoSegment({
    jobId: job.jobId,
    videoUrl,
    startTime,
    model,
    voice,
  }).catch(() => {});

  res.json({
    jobId: job.jobId,
    status: job.status,
    message: "بدأت المعالجة",
  });
});

router.get("/translate/status/:jobId", (req, res) => {
  const parsed = GetJobStatusParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }

  const job = getJob(parsed.data.jobId);
  if (!job) {
    res.status(404).json({ error: "not_found", message: "المهمة غير موجودة" });
    return;
  }

  res.json({
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    audioUrl: job.status === "completed" ? `/api/translate/audio/${job.jobId}` : null,
    transcript: job.transcript,
    translation: job.translation,
    error: job.error,
    startTime: job.startTime,
    videoRate: job.videoRate ?? 1.0,
  });
});

router.get("/translate/audio/:jobId", (req, res) => {
  const parsed = GetAudioParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }

  const audioPath = getAudioPath(parsed.data.jobId);
  if (!audioPath || !existsSync(audioPath)) {
    res.status(404).json({ error: "not_found", message: "الصوت غير متوفر" });
    return;
  }

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-cache");
  createReadStream(audioPath).pipe(res);
});

export default router;
