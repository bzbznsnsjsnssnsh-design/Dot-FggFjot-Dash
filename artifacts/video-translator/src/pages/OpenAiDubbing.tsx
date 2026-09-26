import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AudioLines,
  Check,
  ChevronDown,
  Clock3,
  FileVideo,
  Gauge,
  Link2,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  UploadCloud,
  Volume2,
  X,
} from "lucide-react";
import {
  useCancelOpenAiDubbingJob,
  useCreateOpenAiDubbingJob,
  useGetOpenAiDubbingJob,
  useGetOpenAiDubbingOptions,
  usePreviewOpenAiDubbingVoice,
  getGetOpenAiDubbingJobQueryKey,
} from "../../../../lib/api-client-react/src/generated/api";
import type {
  CreateOpenAiDubbingJobRequest,
  OpenAiDubbingJob,
  OpenAiDubbingOptions,
} from "../../../../lib/api-client-react/src/generated/api.schemas";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

type SourceMode = "url" | "file";
type JobStatus = OpenAiDubbingJob["status"];

const DEFAULT_TEXT = "مرحباً بكم في هذا المقطع. هذا نص قصير لمعاينة الصوت.";

function formatTime(value: number) {
  if (!Number.isFinite(value)) return "00:00";
  const minutes = Math.floor(Math.max(0, value) / 60);
  const seconds = Math.floor(Math.max(0, value) % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return fallback;
}

function isFinished(status?: JobStatus) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function statusLabel(status?: JobStatus) {
  if (status === "completed") return "جاهز للتشغيل";
  if (status === "failed") return "تعذر تجهيز المقطع";
  if (status === "cancelled") return "أُلغي المقطع";
  if (status === "processing") return "جاري المعالجة";
  if (status === "pending") return "في قائمة الانتظار";
  return "بانتظار البدء";
}

function statusTone(status?: JobStatus) {
  if (status === "completed") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
  if (status === "failed" || status === "cancelled") {
    return "border-rose-400/30 bg-rose-400/10 text-rose-200";
  }
  if (status === "processing" || status === "pending") {
    return "border-amber-300/25 bg-amber-300/10 text-amber-100";
  }
  return "border-white/10 bg-white/[0.04] text-white/60";
}

function optionNames(options?: OpenAiDubbingOptions) {
  return {
    stt: options?.sttModels ?? [],
    text: options?.textModels ?? [],
    voices: options?.voices ?? [],
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function segmentDuration(job: OpenAiDubbingJob): number {
  return Math.max(0.1, (job.endTime ?? job.startTime + 30) - job.startTime);
}

function mappedAudioTime(job: OpenAiDubbingJob, videoTime: number, manualOffset: number): number {
  const duration = segmentDuration(job);
  const audioDuration = Math.max(0.1, job.audioDuration ?? duration);
  const progress = clamp((videoTime - job.startTime - manualOffset) / duration, 0, 1);
  return clamp(progress * audioDuration, 0, Math.max(0, audioDuration - 0.03));
}

function expectedAudioRate(job: OpenAiDubbingJob, playbackRate: number): number {
  const duration = segmentDuration(job);
  const audioDuration = Math.max(0.1, job.audioDuration ?? duration);
  return clamp(
    (audioDuration / duration) * playbackRate * clamp(job.audioSpeed || 1, 0.75, 1.5),
    0.5,
    4,
  );
}

export default function OpenAiDubbing() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewAudioRef = useRef<HTMLAudioElement>(null);
  const uploadObjectUrlRef = useRef<string | null>(null);
  const previewObjectUrlRef = useRef<string | null>(null);
  const currentJobIdRef = useRef("");
  const nextJobIdRef = useRef("");
  const currentJobRef = useRef<OpenAiDubbingJob | undefined>(undefined);
  const nextJobRef = useRef<OpenAiDubbingJob | undefined>(undefined);
  const nextRequestedRef = useRef(false);
  const internalSeekRef = useRef(false);
  const autoPlayAfterReadyRef = useRef(false);
  const cancelMutationRef = useRef(useCancelOpenAiDubbingJob().mutate);

  const { data: options, isLoading: isLoadingOptions, error: optionsError } =
    useGetOpenAiDubbingOptions();
  const createJob = useCreateOpenAiDubbingJob();
  const cancelJob = useCancelOpenAiDubbingJob();
  const previewVoice = usePreviewOpenAiDubbingVoice();

  const [sourceMode, setSourceMode] = useState<SourceMode>("url");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [localFile, setLocalFile] = useState<File | null>(null);
  const [localPreviewUrl, setLocalPreviewUrl] = useState("");
  const [uploadedSourceUrl, setUploadedSourceUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [startTime, setStartTime] = useState("0");
  const [currentJobId, setCurrentJobId] = useState("");
  const [nextJobId, setNextJobId] = useState("");
  const [jobError, setJobError] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [videoRate, setVideoRate] = useState("1");
  const [audioSpeed, setAudioSpeed] = useState("1");
  const [manualOffset, setManualOffset] = useState("0");
  const [videoVolume, setVideoVolume] = useState("0.25");
  const [audioVolume, setAudioVolume] = useState("1");
  const [maxSegmentSeconds, setMaxSegmentSeconds] = useState("30");
  const [selectedSttModel, setSelectedSttModel] = useState("");
  const [selectedTranslationModel, setSelectedTranslationModel] = useState("");
  const [selectedPreparationModel, setSelectedPreparationModel] = useState("");
  const [selectedAnalysisModel, setSelectedAnalysisModel] = useState("");
  const [selectedVoice, setSelectedVoice] = useState("");
  const [previewText, setPreviewText] = useState(DEFAULT_TEXT);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const playbackGenerationRef = useRef(0);

  const {
    data: currentJob,
    isLoading: isLoadingCurrentJob,
    error: currentJobQueryError,
  } = useGetOpenAiDubbingJob(currentJobId, {
    query: {
      enabled: Boolean(currentJobId),
      queryKey: getGetOpenAiDubbingJobQueryKey(currentJobId),
      refetchInterval: currentJobId ? 1400 : false,
    },
  });
  const { data: nextJob } = useGetOpenAiDubbingJob(nextJobId, {
    query: {
      enabled: Boolean(nextJobId),
      queryKey: getGetOpenAiDubbingJobQueryKey(nextJobId),
      refetchInterval: nextJobId ? 1400 : false,
    },
  });

  const available = useMemo(() => optionNames(options), [options]);
  const processingSource = sourceMode === "file" ? uploadedSourceUrl : remoteUrl.trim();
  const previewSource = sourceMode === "file" ? localPreviewUrl : remoteUrl.trim();
  const hasSource = Boolean(processingSource);
  const activeStatus = currentJob?.status;
  const activeProgress = currentJob?.progress || (isLoadingCurrentJob ? "جاري الاتصال بخادم المعالجة…" : "");
  const isProcessing = activeStatus === "pending" || activeStatus === "processing" || createJob.isPending;

  cancelMutationRef.current = cancelJob.mutate;
  currentJobRef.current = currentJob;
  nextJobRef.current = nextJob;
  currentJobIdRef.current = currentJobId;
  nextJobIdRef.current = nextJobId;

  useEffect(() => {
    if (!options) return;
    setSelectedSttModel((value) => value || available.stt[0]?.id || "");
    setSelectedTranslationModel((value) => value || available.text[0]?.id || "");
    setSelectedPreparationModel((value) => value || available.text[0]?.id || "");
    setSelectedAnalysisModel((value) => value || available.text[0]?.id || "");
    setSelectedVoice((value) => value || available.voices[0]?.id || "");
  }, [available, options]);

  useEffect(() => {
    if (!currentJob) return;
    if (currentJob.status === "failed" || currentJob.status === "cancelled") {
      setJobError(currentJob.error || statusLabel(currentJob.status));
      setIsPlaying(false);
    }
    if (currentJob.status === "completed" && currentJob.audioUrl) {
      setAudioReady(true);
      const audio = audioRef.current;
      if (audio && audio.src !== new URL(currentJob.audioUrl, window.location.origin).href) {
        audio.src = currentJob.audioUrl;
        audio.load();
      }
      if (autoPlayAfterReadyRef.current) {
        autoPlayAfterReadyRef.current = false;
        window.setTimeout(() => {
          const video = videoRef.current;
          if (!video || !audio) return;
          audio.currentTime = mappedAudioTime(currentJob, video.currentTime, Number(manualOffset) || 0);
          audio.playbackRate = expectedAudioRate(currentJob, video.playbackRate);
          void audio.play().catch(() => undefined);
          setIsPlaying(true);
        }, 120);
      }
    }
  }, [currentJob, manualOffset]);

  useEffect(() => {
    if (currentJobQueryError) setJobError(getErrorMessage(currentJobQueryError, "تعذر قراءة حالة المقطع."));
  }, [currentJobQueryError]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Number(videoVolume);
    video.playbackRate = Number(videoRate);
  }, [videoRate, videoVolume, previewSource]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = Number(audioVolume);
    const job = currentJobRef.current;
    audio.playbackRate = job?.status === "completed"
      ? expectedAudioRate(job, videoRef.current?.playbackRate ?? Number(videoRate))
      : Number(audioSpeed);
  }, [audioSpeed, audioVolume, currentJobId, videoRate]);

  useEffect(() => {
    return () => {
      if (uploadObjectUrlRef.current) URL.revokeObjectURL(uploadObjectUrlRef.current);
      if (previewObjectUrlRef.current) URL.revokeObjectURL(previewObjectUrlRef.current);
      const ids = [currentJobIdRef.current, nextJobIdRef.current].filter(Boolean);
      ids.forEach((jobId) => cancelMutationRef.current({ jobId }));
    };
  }, []);

  const cancelJobById = useCallback((jobId: string) => {
    if (!jobId) return;
    cancelMutationRef.current({ jobId });
  }, []);

  const stopPlayback = useCallback(() => {
    videoRef.current?.pause();
    audioRef.current?.pause();
    setIsPlaying(false);
  }, []);

  const clearBlobPreview = useCallback(() => {
    if (previewObjectUrlRef.current) URL.revokeObjectURL(previewObjectUrlRef.current);
    previewObjectUrlRef.current = null;
    setPreviewError("");
  }, []);

  const cancelActiveJobs = useCallback(() => {
    playbackGenerationRef.current += 1;
    const ids = [currentJobIdRef.current, nextJobIdRef.current].filter(Boolean);
    ids.forEach(cancelJobById);
    ids.forEach((jobId) => {
      void queryClient.cancelQueries({ queryKey: getGetOpenAiDubbingJobQueryKey(jobId) });
      queryClient.removeQueries({ queryKey: getGetOpenAiDubbingJobQueryKey(jobId), exact: true });
    });
    setCurrentJobId("");
    setNextJobId("");
    setAudioReady(false);
    nextRequestedRef.current = false;
    stopPlayback();
    if (audioRef.current) {
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }
  }, [cancelJobById, queryClient, stopPlayback]);

  const uploadFile = useCallback(async (file: File) => {
    setUploading(true);
    setUploadError("");
    try {
      const response = await fetch(
        `/api/openai-dubbing/upload?filename=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        },
      );
      const body = (await response.json()) as { sourceUrl?: string; message?: string; error?: string };
      if (!response.ok || !body.sourceUrl) {
        throw new Error(body.message || body.error || "تعذر رفع الفيديو.");
      }
      setUploadedSourceUrl(body.sourceUrl);
    } catch (error) {
      setUploadedSourceUrl("");
      setUploadError(getErrorMessage(error, "تعذر رفع الفيديو."));
    } finally {
      setUploading(false);
    }
  }, []);

  const handleFileChange = useCallback(
    (file?: File) => {
      if (!file) return;
      if (!/^video\/(mp4|webm)|video\/|\.mp4$|\.webm$/i.test(`${file.type} ${file.name}`)) {
        setUploadError("اختر ملف MP4 أو WebM صالحاً.");
        return;
      }
      cancelActiveJobs();
      setLocalFile(file);
      setSourceMode("file");
      setUploadError("");
      if (uploadObjectUrlRef.current) URL.revokeObjectURL(uploadObjectUrlRef.current);
      const objectUrl = URL.createObjectURL(file);
      uploadObjectUrlRef.current = objectUrl;
      setLocalPreviewUrl(objectUrl);
      void uploadFile(file);
    },
    [cancelActiveJobs, uploadFile],
  );

  const buildJobRequest = useCallback(
    (at: number): CreateOpenAiDubbingJobRequest => ({
      sourceUrl: processingSource,
      startTime: Math.max(0, at),
      sttModel: selectedSttModel as CreateOpenAiDubbingJobRequest["sttModel"],
      translationModel: selectedTranslationModel,
      preparationModel: selectedPreparationModel,
      analysisModel: selectedAnalysisModel,
      voice: selectedVoice as CreateOpenAiDubbingJobRequest["voice"],
      videoRate: Number(videoRate),
      audioSpeed: Number(audioSpeed),
      manualOffset: Number(manualOffset),
      maxSegmentSeconds: Number(maxSegmentSeconds),
    }),
    [
      audioSpeed,
      manualOffset,
      maxSegmentSeconds,
      processingSource,
      selectedAnalysisModel,
      selectedPreparationModel,
      selectedSttModel,
      selectedTranslationModel,
      selectedVoice,
      videoRate,
    ],
  );

  const requestJob = useCallback(
    (at: number, isNext = false) => {
      if (!processingSource) {
        setJobError("أضف رابط فيديو أو ارفع ملفاً أولاً.");
        return;
      }
      if (!selectedSttModel || !selectedTranslationModel || !selectedPreparationModel || !selectedAnalysisModel || !selectedVoice) {
        setJobError("انتظر تحميل النماذج والأصوات المتاحة.");
        return;
      }
      setJobError("");
      const generation = playbackGenerationRef.current;
      if (isNext) nextRequestedRef.current = true;
      createJob.mutate(
        { data: buildJobRequest(at) },
        {
          onSuccess: (response) => {
            if (generation !== playbackGenerationRef.current) {
              if (isNext) nextRequestedRef.current = false;
              cancelJobById(response.jobId);
              return;
            }
            if (isNext) {
              setNextJobId(response.jobId);
            } else {
              setCurrentJobId(response.jobId);
              setAudioReady(false);
            }
          },
          onError: (error) => {
            if (isNext) nextRequestedRef.current = false;
            setJobError(getErrorMessage(error, "تعذر إنشاء مهمة الدبلجة."));
          },
        },
      );
    },
    [
      buildJobRequest,
      cancelJobById,
      createJob,
      processingSource,
      selectedAnalysisModel,
      selectedPreparationModel,
      selectedSttModel,
      selectedTranslationModel,
      selectedVoice,
    ],
  );

  const startPlayback = useCallback(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    const job = currentJobRef.current;
    if (!video || !audio || !job?.audioUrl || job.status !== "completed") return;
    const requested = Number(startTime);
    const time = Number.isFinite(requested) && requested >= job.startTime ? requested : video.currentTime;
    internalSeekRef.current = true;
    video.currentTime = Math.max(0, time);
    audio.currentTime = mappedAudioTime(job, time, Number(manualOffset) || 0);
    window.setTimeout(() => {
      internalSeekRef.current = false;
    }, 250);
    video.playbackRate = Number(videoRate);
    audio.playbackRate = expectedAudioRate(job, Number(videoRate));
    void video.play().catch(() => undefined);
    void audio.play().catch(() => undefined);
    setIsPlaying(true);
  }, [manualOffset, startTime, videoRate]);

  const handleStart = useCallback(() => {
    cancelActiveJobs();
    const at = Math.max(0, Number(startTime) || 0);
    autoPlayAfterReadyRef.current = true;
    requestJob(at);
  }, [cancelActiveJobs, requestJob, startTime]);

  const handleVideoSeeked = useCallback(() => {
    const video = videoRef.current;
    if (!video || internalSeekRef.current) return;
    const at = video.currentTime;
    setCurrentTime(at);
    setStartTime(String(Number(at.toFixed(2))));
    cancelActiveJobs();
    requestJob(at);
  }, [cancelActiveJobs, requestJob]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
    const job = currentJobRef.current;
    if (!job || job.status !== "completed") return;
    const segmentEnd = job.endTime ?? job.startTime + Number(maxSegmentSeconds);
    if (
      !nextRequestedRef.current &&
      !nextJobIdRef.current &&
      video.currentTime >= segmentEnd - 5 &&
      Number.isFinite(video.duration) &&
      video.currentTime < video.duration - 0.5
    ) {
      requestJob(segmentEnd, true);
    }
    const next = nextJobRef.current;
    if (next && next.status === "completed" && video.currentTime >= segmentEnd) {
      autoPlayAfterReadyRef.current = !video.paused;
      const previousJobId = currentJobIdRef.current;
      setCurrentJobId(nextJobIdRef.current);
      setNextJobId("");
      nextRequestedRef.current = false;
      setAudioReady(false);
      if (previousJobId && previousJobId !== nextJobIdRef.current) {
        queryClient.removeQueries({
          queryKey: getGetOpenAiDubbingJobQueryKey(previousJobId),
          exact: true,
        });
      }
    }
    if (audioRef.current && !audioRef.current.paused) {
      const expected = mappedAudioTime(job, video.currentTime, Number(manualOffset) || 0);
      const drift = Math.abs(audioRef.current.currentTime - expected);
      if (drift > 0.25 && drift < 3) audioRef.current.currentTime = expected;
    }
  }, [manualOffset, maxSegmentSeconds, queryClient, requestJob]);

  const handleVideoPlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audioReady || !audio) return;
    const job = currentJobRef.current;
    if (job?.status === "completed") {
      const video = videoRef.current;
      const expected = mappedAudioTime(job, video?.currentTime ?? job.startTime, Number(manualOffset) || 0);
      audio.currentTime = expected;
      audio.playbackRate = expectedAudioRate(job, video?.playbackRate ?? Number(videoRate));
      void audio.play().catch(() => undefined);
    }
    setIsPlaying(true);
  }, [audioReady, manualOffset, videoRate]);

  const handleVideoPause = useCallback(() => {
    audioRef.current?.pause();
    setIsPlaying(false);
  }, []);

  const handlePreview = useCallback(() => {
    if (!selectedVoice) return;
    setPreviewLoading(true);
    setPreviewError("");
    clearBlobPreview();
    previewVoice.mutate(
      { data: { voice: selectedVoice as "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer", text: previewText.trim() || DEFAULT_TEXT } },
      {
        onSuccess: (blob) => {
          const url = URL.createObjectURL(blob);
          previewObjectUrlRef.current = url;
          if (previewAudioRef.current) {
            previewAudioRef.current.src = url;
            void previewAudioRef.current.play().catch(() => undefined);
          }
        },
        onError: (error) => setPreviewError(getErrorMessage(error, "تعذر إنشاء معاينة الصوت.")),
        onSettled: () => setPreviewLoading(false),
      },
    );
  }, [clearBlobPreview, previewText, previewVoice, selectedVoice]);

  const isEstimatedTiming = useMemo(() => {
    const data = currentJob?.synchronizationData;
    return Boolean(
      data &&
        (data.estimated === true ||
          data.sourceTiming === "estimated-by-openai" ||
          data.timingQuality === "estimated" ||
          data.timingStatus === "estimated"),
    );
  }, [currentJob?.synchronizationData]);

  const canStart = hasSource && !uploading && !isLoadingOptions && !createJob.isPending;

  return (
    <main dir="rtl" className="min-h-[100dvh] overflow-hidden bg-[#061513] text-[#e5f6ee]">
      <div className="pointer-events-none fixed inset-0 opacity-60" aria-hidden="true">
        <div className="absolute -right-40 -top-32 h-[32rem] w-[32rem] rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="absolute -bottom-56 -left-40 h-[28rem] w-[28rem] rounded-full bg-teal-400/[0.07] blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-[1480px] px-4 py-5 sm:px-6 lg:px-10 lg:py-8">
        <header className="mb-7 flex flex-col gap-5 border-b border-white/[0.08] pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-emerald-300/80">
              <span className="grid h-7 w-7 place-items-center rounded-lg border border-emerald-300/20 bg-emerald-300/10">
                <AudioLines className="h-4 w-4" />
              </span>
              الدبلجة العربية
            </div>
            <h1 className="font-display text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              مساحة دبلجة تحفظ موضعك
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-7 text-[#9dc2b5]">
              ترجم الفيديو بصوت عربي طبيعي، وابدأ من الثانية التي تختارها دون فقدان الإيقاع.
              كل مقطع يعمل مستقلاً، والمقطع التالي يُجهّز قبل أن تصل إليه.
            </p>
          </div>
          <div data-testid="status-api-options" className="flex items-center gap-2 self-start rounded-full border border-white/10 bg-white/[0.035] px-3 py-2 text-xs text-[#9dc2b5] sm:self-auto">
            <span className={`h-2 w-2 rounded-full ${optionsError ? "bg-rose-400" : isLoadingOptions ? "animate-pulse bg-amber-300" : "bg-emerald-300"}`} />
            {optionsError ? "تعذر تحميل الإعدادات" : isLoadingOptions ? "جاري تحميل الإعدادات" : "الاتصال جاهز"}
          </div>
        </header>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(350px,0.72fr)]">
          <section className="min-w-0 space-y-5">
            <Card className="overflow-hidden border-white/[0.1] bg-[#0b211d]/90 shadow-2xl shadow-emerald-950/30">
              <div className="border-b border-white/[0.08] px-5 py-4 sm:px-6">
                <div className="flex items-center justify-between gap-3">
                  <div>
                   <p className="text-xs font-semibold tracking-[0.16em] text-emerald-300/70">01 / المصدر</p>
                    <h2 className="mt-1 font-display text-xl font-bold text-white">مصدر الفيديو</h2>
                  </div>
                  <div className="flex rounded-lg border border-white/10 bg-black/10 p-1 text-xs">
                    <button data-testid="button-source-url" onClick={() => setSourceMode("url")} className={`rounded-md px-3 py-2 transition ${sourceMode === "url" ? "bg-emerald-300 text-[#062019]" : "text-[#9dc2b5] hover:bg-white/5"}`}>
                      <Link2 className="ml-1 inline h-3.5 w-3.5" /> رابط
                    </button>
                    <button data-testid="button-source-file" onClick={() => setSourceMode("file")} className={`rounded-md px-3 py-2 transition ${sourceMode === "file" ? "bg-emerald-300 text-[#062019]" : "text-[#9dc2b5] hover:bg-white/5"}`}>
                      <UploadCloud className="ml-1 inline h-3.5 w-3.5" /> ملف
                    </button>
                  </div>
                </div>
              </div>
              <CardContent className="p-5 sm:p-6">
                {sourceMode === "url" ? (
                  <div className="space-y-2">
                    <label htmlFor="remote-video-url" className="text-sm font-semibold text-[#c8e1d7]">رابط MP4 أو WebM مباشر</label>
                    <Input
                      id="remote-video-url"
                      data-testid="input-remote-video-url"
                      dir="ltr"
                      type="url"
                      value={remoteUrl}
                      onChange={(event) => {
                        cancelActiveJobs();
                        setRemoteUrl(event.target.value);
                        setJobError("");
                      }}
                      placeholder="https://…/episode.mp4"
                      className="h-12 border-white/10 bg-[#071a17] text-left text-sm text-white placeholder:text-[#64847a]"
                    />
                    <p className="text-xs leading-6 text-[#789e91]">يُستخدم الرابط نفسه للمعالجة. تأكد من أنه متاح للخادم وقابل للتشغيل.</p>
                  </div>
                ) : (
                  <button
                    type="button"
                    data-testid="button-upload-video"
                    onClick={() => fileInputRef.current?.click()}
                    className="group flex w-full items-center justify-between rounded-xl border border-dashed border-emerald-300/30 bg-emerald-300/[0.045] p-4 text-right transition hover:border-emerald-300/60 hover:bg-emerald-300/[0.08]"
                  >
                    <span className="flex items-center gap-3">
                      <span className="grid h-11 w-11 place-items-center rounded-xl bg-emerald-300/10 text-emerald-200">
                        {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileVideo className="h-5 w-5" />}
                      </span>
                      <span>
                        <span className="block text-sm font-bold text-white">{localFile?.name || "اختر فيديو من جهازك"}</span>
                        <span className="mt-1 block text-xs text-[#88ada0]">{uploading ? "جاري رفع نسخة المعالجة…" : localFile ? (uploadedSourceUrl ? "تم رفع النسخة، جاهز للمعالجة" : "بانتظار اكتمال الرفع") : "MP4 أو WebM — لا يتجاوز حجم المتصفح"}</span>
                      </span>
                    </span>
                    <span className="text-xs font-bold text-emerald-200">{localFile ? "تغيير" : "تصفح"}</span>
                    <input ref={fileInputRef} data-testid="input-video-file" type="file" accept="video/mp4,video/webm,.mp4,.webm" className="hidden" onChange={(event) => handleFileChange(event.target.files?.[0])} />
                  </button>
                )}
                {uploadError && <p data-testid="status-upload-error" className="mt-3 flex items-center gap-2 text-xs text-rose-200"><AlertCircle className="h-4 w-4" />{uploadError}</p>}
              </CardContent>
            </Card>

            <Card className="overflow-hidden border-white/[0.1] bg-[#0b211d]/90 shadow-2xl shadow-emerald-950/30">
              <CardHeader className="border-b border-white/[0.08] px-5 py-4 sm:px-6">
                 <p className="text-xs font-semibold tracking-[0.16em] text-emerald-300/70">02 / التشغيل</p>
                <CardTitle className="mt-1 font-display text-xl text-white">المعاينة ومطابقة الصوت</CardTitle>
              </CardHeader>
              <CardContent className="p-5 sm:p-6">
                <div className="relative aspect-video overflow-hidden rounded-2xl border border-white/10 bg-[#04100e]">
                  {previewSource ? (
                    <video
                      ref={videoRef}
                      data-testid="video-source-preview"
                      src={previewSource}
                      controls
                      playsInline
                      className="h-full w-full object-contain"
                      onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
                      onTimeUpdate={handleTimeUpdate}
                      onPlay={handleVideoPlay}
                      onPause={handleVideoPause}
                      onSeeked={handleVideoSeeked}
                      onEnded={() => {
                        audioRef.current?.pause();
                        setIsPlaying(false);
                      }}
                    />
                  ) : (
                    <div data-testid="empty-video-preview" className="flex h-full flex-col items-center justify-center gap-3 text-center text-[#6f968a]">
                      <span className="grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-white/[0.04]"><FileVideo className="h-6 w-6" /></span>
                      <p className="text-sm">أضف مصدراً لتظهر المعاينة هنا</p>
                    </div>
                  )}
                  <div className="pointer-events-none absolute inset-x-4 top-4 flex justify-between text-[10px] font-semibold tracking-[0.18em] text-white/50">
                    <span>الفيديو الأصلي</span>
                    <span>{formatTime(currentTime)} / {formatTime(duration)}</span>
                  </div>
                </div>
                <audio ref={audioRef} data-testid="audio-dubbed-track" onEnded={() => setIsPlaying(false)} className="hidden" />
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button data-testid="button-play-dubbing" onClick={isPlaying ? stopPlayback : startPlayback} disabled={!audioReady} className="min-w-32 bg-emerald-300 text-[#062019] hover:bg-emerald-200">
                    {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    {isPlaying ? "إيقاف" : "تشغيل الدبلجة"}
                  </Button>
                  <Button data-testid="button-use-current-time" variant="outline" onClick={() => setStartTime(String(Number(currentTime.toFixed(2))))} className="border-white/10 bg-transparent text-[#b9d7cc]">
                    <Clock3 className="h-4 w-4" /> استخدم الموضع الحالي
                  </Button>
                  {audioReady && <span data-testid="status-audio-ready" className="mr-auto flex items-center gap-1.5 text-xs text-emerald-200"><Check className="h-4 w-4" /> الصوت جاهز</span>}
                </div>
              </CardContent>
            </Card>
          </section>

          <aside className="min-w-0 space-y-5">
            <Card className="border-emerald-300/20 bg-[#10352b]/90 shadow-2xl shadow-emerald-950/30">
              <CardHeader className="px-5 pb-3 pt-5 sm:px-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                   <p className="text-xs font-semibold tracking-[0.16em] text-emerald-300/70">03 / مختبر الصوت</p>
                    <CardTitle className="mt-1 font-display text-xl text-white">اختيار الصوت</CardTitle>
                  </div>
                  <Sparkles className="h-5 w-5 text-emerald-200" />
                </div>
              </CardHeader>
              <CardContent className="space-y-4 px-5 pb-5 sm:px-6">
                <div>
                  <label htmlFor="voice-select" className="mb-2 block text-xs font-semibold text-[#b7d8cb]">الصوت العربي</label>
                  <Select value={selectedVoice} onValueChange={setSelectedVoice} disabled={isLoadingOptions}>
                    <SelectTrigger id="voice-select" data-testid="select-voice" className="h-11 border-white/10 bg-[#08251f] text-white"><SelectValue placeholder="اختر صوتاً" /></SelectTrigger>
                    <SelectContent>{available.voices.map((voice) => <SelectItem key={voice.id} value={voice.id}>{voice.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <label htmlFor="preview-text" className="mb-2 block text-xs font-semibold text-[#b7d8cb]">نص المعاينة</label>
                  <textarea id="preview-text" data-testid="input-preview-text" value={previewText} onChange={(event) => setPreviewText(event.target.value.slice(0, 500))} rows={3} className="w-full resize-none rounded-lg border border-white/10 bg-[#08251f] px-3 py-2 text-sm leading-6 text-white outline-none ring-emerald-300/40 placeholder:text-[#64847a] focus:ring-2" />
                </div>
                <Button data-testid="button-preview-voice" variant="outline" onClick={handlePreview} disabled={previewLoading || !selectedVoice} className="w-full border-emerald-300/25 bg-transparent text-emerald-100 hover:bg-emerald-300/10">
                  {previewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Volume2 className="h-4 w-4" />}
                  {previewLoading ? "جاري إنشاء المعاينة" : "استمع إلى الصوت"}
                </Button>
                <audio ref={previewAudioRef} data-testid="audio-voice-preview" controls className="h-9 w-full" />
                {previewError && <p data-testid="status-preview-error" className="text-xs text-rose-200">{previewError}</p>}
              </CardContent>
            </Card>

            <Card className="border-white/[0.1] bg-[#0b211d]/90 shadow-2xl shadow-emerald-950/30">
              <CardHeader className="px-5 pb-3 pt-5 sm:px-6">
                <div className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-emerald-300" /><CardTitle className="font-display text-lg text-white">الضبط الدقيق</CardTitle></div>
                <p className="text-xs leading-6 text-[#789e91]">تُرسل هذه القيم مع كل مقطع جديد.</p>
              </CardHeader>
              <CardContent className="space-y-4 px-5 pb-5 sm:px-6">
                <div className="grid grid-cols-2 gap-3">
                  <ControlSelect label="التعرّف STT" testId="select-stt-model" value={selectedSttModel} onChange={setSelectedSttModel} options={available.stt.map((model) => ({ value: model.id, label: model.name }))} />
                  <ControlSelect label="الترجمة" testId="select-translation-model" value={selectedTranslationModel} onChange={setSelectedTranslationModel} options={available.text.map((model) => ({ value: model.id, label: model.name }))} />
                  <ControlSelect label="تحضير النص" testId="select-preparation-model" value={selectedPreparationModel} onChange={setSelectedPreparationModel} options={available.text.map((model) => ({ value: model.id, label: model.name }))} />
                  <ControlSelect label="تحليل التوقيت" testId="select-analysis-model" value={selectedAnalysisModel} onChange={setSelectedAnalysisModel} options={available.text.map((model) => ({ value: model.id, label: model.name }))} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <NumberField label="سرعة الفيديو" testId="input-video-rate" value={videoRate} onChange={setVideoRate} min={0.5} max={2} step={0.05} suffix="×" />
                  <NumberField label="سرعة الصوت" testId="input-audio-speed" value={audioSpeed} onChange={setAudioSpeed} min={0.75} max={1.5} step={0.05} suffix="×" />
                  <NumberField label="إزاحة يدوية" testId="input-manual-offset" value={manualOffset} onChange={setManualOffset} min={-5} max={5} step={0.1} suffix="ث" />
                  <NumberField label="طول المقطع" testId="input-max-segment" value={maxSegmentSeconds} onChange={setMaxSegmentSeconds} min={15} max={55} step={1} suffix="ث" />
                </div>
                <div className="space-y-3 border-t border-white/[0.08] pt-4">
                  <RangeField label="صوت الفيديو" testId="input-video-volume" value={videoVolume} onChange={setVideoVolume} min={0} max={1} step={0.05} />
                  <RangeField label="صوت الدبلجة" testId="input-dub-volume" value={audioVolume} onChange={setAudioVolume} min={0} max={1} step={0.05} />
                </div>
              </CardContent>
            </Card>

            <Card className="border-emerald-300/20 bg-[#09251f]/95 shadow-2xl shadow-emerald-950/30">
              <CardContent className="p-5 sm:p-6">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                     <p className="text-xs font-semibold tracking-[0.16em] text-emerald-300/70">04 / المقطع</p>
                    <h2 className="mt-1 font-display text-lg font-bold text-white">ابدأ من موضع محدد</h2>
                  </div>
                  <Gauge className="h-5 w-5 text-emerald-200" />
                </div>
                <div className="mb-4">
                  <label htmlFor="start-time" className="mb-2 block text-xs font-semibold text-[#b7d8cb]">الثانية التي يبدأ منها المقطع</label>
                  <div className="relative">
                    <Input id="start-time" data-testid="input-start-time" dir="ltr" type="number" min={0} max={duration || undefined} step="0.01" value={startTime} onChange={(event) => setStartTime(event.target.value)} className="h-12 border-white/10 bg-[#071a17] pl-12 text-left text-lg font-semibold text-white" />
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-[#6f968a]">ثانية</span>
                  </div>
                </div>
                <Button data-testid="button-start-dubbing" onClick={handleStart} disabled={!canStart} className="h-12 w-full bg-emerald-300 font-bold text-[#062019] hover:bg-emerald-200">
                  {createJob.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Play className="h-5 w-5" />}
                  {createJob.isPending ? "جاري إرسال المقطع" : "ابدأ الدبلجة من هنا"}
                </Button>
                {!hasSource && <p data-testid="status-missing-source" className="mt-3 text-center text-xs text-amber-100/80">أضف مصدراً قبل بدء المعالجة.</p>}
              </CardContent>
            </Card>

            <JobStatusPanel job={currentJob} status={activeStatus} progress={activeProgress} error={jobError} nextJob={nextJob} />
          </aside>
        </div>

        <section className="mt-5 grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
          <Card className="border-white/[0.1] bg-[#0b211d]/80">
            <CardHeader className="px-5 pb-3 pt-5 sm:px-6"><CardTitle className="font-display text-lg text-white">كيف نحافظ على التوقيت؟</CardTitle></CardHeader>
            <CardContent className="px-5 pb-5 text-sm leading-7 text-[#8fb6a8] sm:px-6">
              ساعة الفيديو هي المرجع. نُزامن مسار الصوت معها، ونُجهّز مقطعاً واحداً فقط إلى الأمام حتى يبقى التشغيل خفيفاً وقابلاً للتوقع.
            </CardContent>
          </Card>
          <Card className="border-white/[0.1] bg-[#0b211d]/80">
            <CardHeader className="px-5 pb-3 pt-5 sm:px-6"><CardTitle className="font-display text-lg text-white">النص والتوقيت</CardTitle></CardHeader>
            <CardContent className="px-5 pb-5 sm:px-6">
              {currentJob?.originalText || currentJob?.arabicText ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextBlock label="النص الأصلي" value={currentJob.originalText || "—"} testId="text-original-transcript" />
                  <TextBlock label="النص العربي" value={currentJob.preparedText || currentJob.arabicText || "—"} testId="text-arabic-transcript" />
                </div>
              ) : (
                <p data-testid="empty-transcript" className="text-sm text-[#789e91]">سيظهر النص بعد اكتمال أول مقطع.</p>
              )}
              {isEstimatedTiming && <p data-testid="status-estimated-timing" className="mt-4 flex items-center gap-2 text-xs text-amber-100"><Clock3 className="h-4 w-4" />التوقيت المعروض تقديري من GPT، وليس طوابع كلام دقيقة.</p>}
              {currentJob?.speechTimings?.length ? <div data-testid="list-speech-timings" className="mt-4 flex flex-wrap gap-2">{currentJob.speechTimings.slice(0, 8).map((timing) => <span key={timing.utteranceId} className="rounded-md border border-white/10 bg-white/[0.035] px-2 py-1 text-xs text-[#a5c6ba]">{formatTime(timing.startTime)} – {formatTime(timing.endTime)}</span>)}</div> : null}
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
  );
}

function ControlSelect({
  label,
  testId,
  value,
  onChange,
  options,
}: {
  label: string;
  testId: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="min-w-0">
      <label className="mb-1.5 block truncate text-[11px] font-semibold text-[#9dc2b5]">{label}</label>
      <Select value={value} onValueChange={onChange} disabled={!options.length}>
        <SelectTrigger data-testid={testId} className="h-10 border-white/10 bg-[#071a17] text-xs text-white"><SelectValue placeholder="غير متاح" /></SelectTrigger>
        <SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}

function NumberField({
  label,
  testId,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
}: {
  label: string;
  testId: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  step: number;
  suffix: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block truncate text-[11px] font-semibold text-[#9dc2b5]">{label}</span>
      <span className="relative block">
        <Input data-testid={testId} dir="ltr" type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(event.target.value)} className="h-10 border-white/10 bg-[#071a17] pl-8 text-left text-sm text-white" />
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-[#64847a]">{suffix}</span>
      </span>
    </label>
  );
}

function RangeField({
  label,
  testId,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  testId: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-xs text-[#9dc2b5]">{label}</span>
      <input data-testid={testId} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(event.target.value)} className="h-1.5 min-w-0 flex-1 accent-emerald-300" />
      <span data-testid={`${testId}-value`} className="w-8 text-left font-mono text-[11px] text-[#b7d8cb]">{Math.round(Number(value) * 100)}%</span>
    </label>
  );
}

function JobStatusPanel({
  job,
  status,
  progress,
  error,
  nextJob,
}: {
  job?: OpenAiDubbingJob;
  status?: JobStatus;
  progress: string;
  error: string;
  nextJob?: OpenAiDubbingJob;
}) {
  return (
    <Card className="border-white/[0.1] bg-[#0b211d]/90 shadow-2xl shadow-emerald-950/30">
      <CardContent className="p-5 sm:p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className={`grid h-8 w-8 place-items-center rounded-lg border ${statusTone(status)}`}>
              {status === "completed" ? <Check className="h-4 w-4" /> : status === "failed" || status === "cancelled" ? <X className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
            </span>
            <div>
               <p className="text-xs font-semibold tracking-[0.14em] text-emerald-300/70">حالة المهمة</p>
              <p data-testid="status-dubbing-job" className="mt-0.5 text-sm font-bold text-white">{statusLabel(status)}</p>
            </div>
          </div>
          {job?.progress && <span data-testid="status-job-progress" className="max-w-[46%] truncate text-left text-xs text-[#91b6a8]">{job.progress}</span>}
        </div>
        {status && !isFinished(status) && (
          <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full w-2/5 animate-pulse rounded-full bg-emerald-300" /></div>
        )}
        <p data-testid="text-job-progress" className="min-h-5 text-xs leading-6 text-[#8fb6a8]">{error || progress || "أنشئ مقطعاً لتظهر حالته هنا."}</p>
        {error && <p data-testid="status-dubbing-error" className="mt-2 flex items-center gap-2 text-xs text-rose-200"><AlertCircle className="h-4 w-4" />{error}</p>}
        {nextJob && (nextJob.status === "pending" || nextJob.status === "processing") && <p data-testid="status-next-job" className="mt-3 flex items-center gap-2 border-t border-white/[0.08] pt-3 text-xs text-emerald-200"><RotateCcw className="h-3.5 w-3.5" />المقطع التالي قيد التجهيز تلقائياً</p>}
      </CardContent>
    </Card>
  );
}

function TextBlock({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-3">
      <p className="mb-1 text-[11px] font-semibold text-emerald-300/70">{label}</p>
      <p data-testid={testId} className="text-sm leading-7 text-[#c0dcd1]">{value}</p>
    </div>
  );
}