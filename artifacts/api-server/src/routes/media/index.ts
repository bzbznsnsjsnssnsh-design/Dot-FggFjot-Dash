import express, { Router, type IRouter } from "express";
import { spawn } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { extname, join } from "path";
import { randomUUID } from "crypto";
import { logger } from "../../lib/logger.js";

const router: IRouter = Router();
const mediaFiles = new Map<string, { path: string; createdAt: number }>();
const MEDIA_TTL_MS = 60 * 60 * 1000;

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function extensionKind(value: string): "hls" | "dash" | "direct" | "unknown" {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    if (pathname.endsWith(".m3u8")) return "hls";
    if (pathname.endsWith(".mpd")) return "dash";
    if (/\.(mp4|m4v|webm|ogg|ogv|mov|mkv|avi|flv|ts|m2ts)(?:$|\?)/i.test(pathname)) {
      return "direct";
    }
  } catch {
    // The caller validates the URL separately.
  }
  return "unknown";
}

function kindFromContentType(contentType: string | null): "hls" | "dash" | "direct" | "unknown" {
  const value = (contentType ?? "").toLowerCase().split(";")[0].trim();
  if (value.includes("mpegurl") || value === "application/x-mpegurl") return "hls";
  if (value === "application/dash+xml") return "dash";
  if (value.startsWith("video/") || value === "application/mp4" || value === "application/octet-stream") {
    return "direct";
  }
  return "unknown";
}

async function probeRemote(url: string): Promise<{ kind: string; contentType: string | null; finalUrl: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    let response: Response;
    try {
      response = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    } catch {
      response = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        redirect: "follow",
        signal: controller.signal,
      });
    }
    const contentType = response.headers.get("content-type");
    const kind = kindFromContentType(contentType) !== "unknown"
      ? kindFromContentType(contentType)
      : extensionKind(response.url || url);
    return { kind, contentType, finalUrl: response.url || url };
  } finally {
    clearTimeout(timeout);
  }
}

function transcodeToMp4(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-i", inputPath,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ]);
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0 && existsSync(outputPath)) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

function streamRemoteTranscode(url: string, req: express.Request, res: express.Response) {
  res.status(200);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "no-store");
  const child = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-user_agent", "Mozilla/5.0",
    "-i", url,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1",
  ]);
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.stdout.pipe(res);
  const close = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  req.on("close", close);
  child.on("error", err => {
    logger.error({ err, url }, "Remote media transcode failed");
    if (!res.headersSent) res.status(502).json({ error: "media_transcode_failed", message: err.message });
  });
  child.on("close", code => {
    req.off("close", close);
    if (code !== 0 && !res.headersSent) {
      res.status(502).json({ error: "media_transcode_failed", message: stderr.trim() || "فشل تحويل مصدر الفيديو" });
    }
  });
}

router.get("/media/probe", async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url : "";
  if (!isHttpUrl(url)) {
    res.status(400).json({ error: "validation_error", message: "رابط HTTP أو HTTPS مطلوب" });
    return;
  }
  try {
    const result = await probeRemote(url);
    const needsTranscode = result.kind === "direct" && !/\b(mp4|webm|ogg|m4v)\b/i.test(result.contentType ?? "")
      && !/\.(mp4|webm|ogg|ogv|m4v)(?:$|\?)/i.test(result.finalUrl);
    res.json({ ...result, needsTranscode });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ url, err }, "Media probe failed");
    res.status(502).json({ error: "media_probe_failed", message });
  }
});

router.get("/media/transcode", (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url : "";
  if (!isHttpUrl(url)) {
    res.status(400).json({ error: "validation_error", message: "رابط HTTP أو HTTPS مطلوب" });
    return;
  }
  streamRemoteTranscode(url, req, res);
});

router.post("/media/upload", express.raw({ type: "*/*", limit: "2gb" }), async (req, res) => {
  const filename = typeof req.query.filename === "string" ? req.query.filename : "upload.bin";
  const extension = extname(filename).toLowerCase() || ".bin";
  const tempDir = await mkdtemp(join("/tmp", "vt-media-"));
  const inputPath = join(tempDir, `source${extension.replace(/[^a-z0-9.]/gi, "")}`);
  const outputPath = join(tempDir, "converted.mp4");
  try {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? []);
    if (!body.length) {
      res.status(400).json({ error: "empty_file", message: "ملف الفيديو فارغ" });
      await rm(tempDir, { recursive: true, force: true });
      return;
    }
    await writeFile(inputPath, body);
    await transcodeToMp4(inputPath, outputPath);
    const id = randomUUID();
    mediaFiles.set(id, { path: outputPath, createdAt: Date.now() });
    setTimeout(async () => {
      const file = mediaFiles.get(id);
      if (file?.path === outputPath) {
        mediaFiles.delete(id);
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }, MEDIA_TTL_MS);
    res.json({ id, url: `/api/media/file/${id}`, kind: "direct", contentType: "video/mp4" });
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, filename }, "Local media conversion failed");
    res.status(422).json({ error: "media_conversion_failed", message });
  }
});

router.get("/media/file/:id", async (req, res) => {
  const file = mediaFiles.get(req.params.id);
  if (!file || Date.now() - file.createdAt > MEDIA_TTL_MS || !existsSync(file.path)) {
    mediaFiles.delete(req.params.id);
    res.status(404).json({ error: "not_found", message: "ملف الفيديو غير متوفر" });
    return;
  }
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(file.path);
});

export default router;