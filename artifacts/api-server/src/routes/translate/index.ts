import { Router, type IRouter } from "express";
import { createReadStream, existsSync } from "fs";
import {
  ProcessVideoBody,
  GetJobStatusParams,
  GetAudioParams,
} from "@workspace/api-zod";
import { createJob, getJob } from "./jobs.js";
import { processVideoSegment, getAudioPath, TTS_MODELS } from "./processor.js";

const router: IRouter = Router();

router.get("/translate/models", (_req, res) => {
  res.json({ models: TTS_MODELS });
});

router.post("/translate/process", async (req, res) => {
  const parsed = ProcessVideoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }

  const { videoUrl, startTime, model, voice, speed } = parsed.data;

  const job = createJob(startTime);

  processVideoSegment({
    jobId: job.jobId,
    videoUrl,
    startTime,
    model,
    voice,
    speed,
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
