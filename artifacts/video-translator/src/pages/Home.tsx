import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import YouTube from 'react-youtube';
import Hls from 'hls.js';
import * as dashjs from 'dashjs';
import { Play, Youtube, Settings, Wand2, RefreshCcw, ChevronLeft, ChevronRight, RotateCcw, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { useToast } from '@/hooks/use-toast';
import {
  useGetOpenAiDubbingOptions,
  useGetTtsModels,
  usePreviewOpenAiDubbingVoice,
} from '@workspace/api-client-react';
import { useYoutubeUrl } from '@/hooks/use-youtube-url';
import { ProcessingOverlay } from '@/components/processing-overlay';
import { PipelineBar } from '@/components/pipeline-bar';
import { VoicePicker } from '@/components/voice-picker';
import { detectMediaKind, isHttpUrl, nativeVideoType, type MediaKind, type MediaProbe } from '@/lib/media-source';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card } from '@/components/ui/card';

const SEGMENT_DURATION = 50;
const POLL_INTERVAL = 1500;
const OFFSET_STEP = 0.1;
const OFFSET_MIN = -2.0;
const OFFSET_MAX = 2.0;
// If audio/video drift exceeds this, hard-correct by seeking video
const SYNC_DRIFT_THRESHOLD = 3.0;

interface SegmentJob {
  jobId: string;
  status: 'processing' | 'completed' | 'failed';
  audioUrl: string | null;
  progress: string;
  videoRate: number;
}

function formatTime(secs: number) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function requestSegment(videoUrl: string, startTime: number, model: string, voice: string): Promise<string> {
  const res = await fetch('/api/translate/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoUrl, startTime, model, voice, speed: 1.0 }),
  });
  const data = await res.json();
  return data.jobId as string;
}

async function pollJob(
  jobId: string,
  onProgress: (p: string) => void,
  signal: AbortSignal
): Promise<SegmentJob> {
  while (!signal.aborted) {
    const res = await fetch(`/api/translate/status/${jobId}`);
    const data = await res.json();
    onProgress(data.progress || '');
    if (data.status === 'completed') {
      return {
        jobId,
        status: 'completed',
        audioUrl: `/api/translate/audio/${jobId}`,
        progress: data.progress,
        videoRate: data.videoRate ?? 1.0,
      };
    }
    if (data.status === 'failed') {
      return { jobId, status: 'failed', audioUrl: null, progress: data.progress, videoRate: 1.0 };
    }
    await new Promise<void>(r => {
      const t = setTimeout(r, POLL_INTERVAL);
      signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
    });
  }
  throw new Error('aborted');
}

export default function Home() {
  const { toast } = useToast();
  const { url, setUrl, videoId, isValid } = useYoutubeUrl();

  const ytPlayerRef = useRef<any>(null);
  const genericVideoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const dashRef = useRef<dashjs.MediaPlayerClass | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const lastTimeRef = useRef(0);
  const isSeekingRef = useRef(false);
  const isSyncingRef = useRef(false);
  const isAdvancingRef = useRef(false);
  const pendingTransitionKeyRef = useRef<number | null>(null);
  const activeSegmentKeyRef = useRef(0);
  const audioOffsetRef = useRef(0);

  const [selectedModel, setSelectedModel] = useState('');
  const [selectedVoice, setSelectedVoice] = useState('');
  const [audioOffset, setAudioOffset] = useState(0.0);
  const [videoVolume, setVideoVolume] = useState(0.3);
  const [ttsVolume, setTtsVolume] = useState(1.0);
  const [localFile, setLocalFile] = useState<File | null>(null);
  const [localObjectUrl, setLocalObjectUrl] = useState<string | null>(null);
  const [uploadedLocalUrl, setUploadedLocalUrl] = useState<string | null>(null);
  const [mediaProbe, setMediaProbe] = useState<MediaProbe | null>(null);
  const [mediaProbeLoading, setMediaProbeLoading] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const [openAiVoice, setOpenAiVoice] = useState('');
  const [openAiPreviewText, setOpenAiPreviewText] = useState('مرحباً بكم في هذا المقطع. هذه معاينة لصوت الدبلجة.');
  const [openAiPreviewUrl, setOpenAiPreviewUrl] = useState('');
  const [openAiPreviewError, setOpenAiPreviewError] = useState('');

  const [isPlaying, setIsPlaying] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [overlayProgress, setOverlayProgress] = useState('جاري تهيئة المقطع...');
  const [hasStarted, setHasStarted] = useState(false);

  const [pipelineVisible, setPipelineVisible] = useState(false);
  const [pipelineProgress, setPipelineProgress] = useState('');
  const [pipelineSegmentLabel, setPipelineSegmentLabel] = useState('');
  const [pipelineDone, setPipelineDone] = useState(false);

  // Segment job cache: key → SegmentJob
  const segmentCacheRef = useRef<Map<number, SegmentJob>>(new Map());
  // Pre-fetched audio blob URLs: key → blob URL (already in memory, instant to play)
  const blobUrlCacheRef = useRef<Map<number, string>>(new Map());
  const inFlightRef = useRef<Map<number, Promise<SegmentJob>>>(new Map());
  const furthestQueuedRef = useRef(-1);
  const chainAbortRef = useRef<AbortController | null>(null);

  const { data: modelsData, isLoading: isLoadingModels } = useGetTtsModels();
  const { data: openAiOptions, isLoading: isLoadingOpenAiOptions } = useGetOpenAiDubbingOptions();
  const previewOpenAiVoice = usePreviewOpenAiDubbingVoice();

  const normalizeStart = (t: number) => Math.floor(t / SEGMENT_DURATION) * SEGMENT_DURATION;
  const isYouTubeSource = !!videoId;
  const detectedKind = useMemo<MediaKind>(() => detectMediaKind(url), [url]);
  const remotePlayable = !isYouTubeSource && !!mediaProbe && mediaProbe.kind !== 'unknown';
  const mediaKind = isYouTubeSource ? 'youtube' : (localFile ? 'direct' : (mediaProbe?.kind ?? detectedKind));
  const genericSourceUrl = localObjectUrl
    ?? uploadedLocalUrl
    ?? (remotePlayable && mediaProbe?.needsTranscode
      ? `/api/media/transcode?url=${encodeURIComponent(mediaProbe.finalUrl || url)}`
      : (remotePlayable ? (mediaProbe?.finalUrl || url) : ''));
  const mediaReady = isYouTubeSource || !!localFile && !!genericSourceUrl || remotePlayable && !!genericSourceUrl;
  const processingSource = isYouTubeSource
    ? url
    : (uploadedLocalUrl || mediaProbe?.finalUrl || url);
  const getMediaTime = useCallback(() => {
    if (isYouTubeSource) return ytPlayerRef.current?.getCurrentTime?.() ?? 0;
    return genericVideoRef.current?.currentTime ?? 0;
  }, [isYouTubeSource]);
  const getMediaDuration = useCallback(() => {
    if (isYouTubeSource) return ytPlayerRef.current?.getDuration?.() ?? Infinity;
    return genericVideoRef.current?.duration || Infinity;
  }, [isYouTubeSource]);
  const playMedia = useCallback(() => {
    if (isYouTubeSource) ytPlayerRef.current?.playVideo?.();
    else genericVideoRef.current?.play().catch(err => console.debug('[media] play rejected', err));
  }, [isYouTubeSource]);
  const pauseMedia = useCallback(() => {
    if (isYouTubeSource) ytPlayerRef.current?.pauseVideo?.();
    else genericVideoRef.current?.pause();
  }, [isYouTubeSource]);
  const seekMedia = useCallback((time: number) => {
    if (isYouTubeSource) ytPlayerRef.current?.seekTo?.(time, true);
    else if (genericVideoRef.current) genericVideoRef.current.currentTime = time;
  }, [isYouTubeSource]);
  const setMediaRate = useCallback((rate: number) => {
    if (isYouTubeSource) ytPlayerRef.current?.setPlaybackRate?.(rate);
    else if (genericVideoRef.current) genericVideoRef.current.playbackRate = rate;
  }, [isYouTubeSource]);

  useEffect(() => { audioOffsetRef.current = audioOffset; }, [audioOffset]);

  // Set defaults
  useEffect(() => {
    if (modelsData?.models?.length && !selectedModel) {
      const first = modelsData.models[0];
      setSelectedModel(first.id);
      if (first.voices?.length) setSelectedVoice(first.voices[0].id);
    }
  }, [modelsData, selectedModel]);

  useEffect(() => {
    if (selectedModel && modelsData?.models) {
      const model = modelsData.models.find(m => m.id === selectedModel);
      if (model?.voices?.length && !model.voices.some(v => v.id === selectedVoice)) {
        setSelectedVoice(model.voices[0].id);
      }
    }
  }, [selectedModel, modelsData, selectedVoice]);

  useEffect(() => {
    if (openAiOptions?.voices?.length && !openAiVoice) {
      setOpenAiVoice(openAiOptions.voices[0].id);
    }
  }, [openAiOptions, openAiVoice]);

  useEffect(() => {
    return () => {
      if (openAiPreviewUrl) URL.revokeObjectURL(openAiPreviewUrl);
    };
  }, [openAiPreviewUrl]);

  // Reset everything when URL changes
  useEffect(() => {
    chainAbortRef.current?.abort();
    segmentCacheRef.current.clear();
    // Revoke and clear blob URLs
    blobUrlCacheRef.current.forEach(u => URL.revokeObjectURL(u));
    blobUrlCacheRef.current.clear();
    inFlightRef.current.clear();
    furthestQueuedRef.current = -1;
    setHasStarted(false);
    setShowOverlay(false);
    setPipelineVisible(false);
    setPipelineDone(false);
  }, [url]);

  // Probe non-YouTube URLs on the server so content type, not only the
  // extension, determines the playback engine.
  useEffect(() => {
    if (localFile || !url || isYouTubeSource || !isHttpUrl(url)) {
      setMediaProbe(null);
      setMediaProbeLoading(false);
      setMediaError('');
      return;
    }

    const controller = new AbortController();
    setMediaProbeLoading(true);
    setMediaError('');
    fetch(`/api/media/probe?url=${encodeURIComponent(url)}`, { signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'تعذر فحص مصدر الفيديو');
        return data as MediaProbe;
      })
      .then(probe => {
        if (!controller.signal.aborted) setMediaProbe(probe);
      })
      .catch(err => {
        if (!controller.signal.aborted) {
          setMediaProbe(null);
          setMediaError(err instanceof Error ? err.message : 'تعذر فحص الرابط');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setMediaProbeLoading(false);
      });

    return () => controller.abort();
  }, [url, isYouTubeSource, localFile]);

  // Keep a local preview URL, and upload a server copy for the translation
  // worker as well. Unsupported containers are converted to MP4 server-side.
  useEffect(() => {
    if (!localFile) {
      setLocalObjectUrl(null);
      setUploadedLocalUrl(null);
      return;
    }

    setMediaError('');
    setUploadedLocalUrl(null);
    let cancelled = false;
    const objectUrl = nativeVideoType(localFile) ? URL.createObjectURL(localFile) : null;
    setLocalObjectUrl(objectUrl);
    setMediaProbeLoading(true);
    fetch(`/api/media/upload?filename=${encodeURIComponent(localFile.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': localFile.type || 'application/octet-stream' },
      body: localFile,
    })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'تعذر تحويل ملف الفيديو');
        return data as { url: string };
      })
      .then(data => {
        if (!cancelled) setUploadedLocalUrl(data.url);
      })
      .catch(err => {
        if (!cancelled) setMediaError(err instanceof Error ? err.message : 'تعذر تشغيل ملف الفيديو');
      })
      .finally(() => {
        if (!cancelled) setMediaProbeLoading(false);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [localFile]);

  // Select the correct media engine for direct files, HLS and DASH.
  useEffect(() => {
    const video = genericVideoRef.current;
    if (isYouTubeSource || !video || !genericSourceUrl) return;

    hlsRef.current?.destroy();
    hlsRef.current = null;
    dashRef.current?.reset();
    dashRef.current = null;
    video.removeAttribute('src');
    video.load();

    if (mediaKind === 'hls') {
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            console.error('[media] HLS fatal error', data);
            setMediaError('تعذر تشغيل بث HLS');
          }
        });
        hls.loadSource(genericSourceUrl);
        hls.attachMedia(video);
        hlsRef.current = hls;
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = genericSourceUrl;
      } else {
        setMediaError('هذا المتصفح لا يدعم تشغيل HLS');
      }
    } else if (mediaKind === 'dash') {
      const player = dashjs.MediaPlayer().create();
      player.initialize(video, genericSourceUrl, false);
      dashRef.current = player;
    } else {
      video.src = genericSourceUrl;
    }

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      dashRef.current?.reset();
      dashRef.current = null;
      video.removeAttribute('src');
      video.load();
    };
  }, [genericSourceUrl, mediaKind, isYouTubeSource]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = ttsVolume;
    if (genericVideoRef.current) genericVideoRef.current.volume = videoVolume;
    if (ytPlayerRef.current?.setVolume) ytPlayerRef.current.setVolume(videoVolume * 100);
  }, [ttsVolume, videoVolume]);

  /**
   * Pre-fetch audio file as blob so it's in memory before it's needed.
   * Stored by segment key. Called right after a segment completes.
   */
  const prefetchAudioBlob = useCallback((key: number, audioUrl: string) => {
    if (blobUrlCacheRef.current.has(key)) return;
    fetch(audioUrl)
      .then(r => r.blob())
      .then(blob => {
        const blobUrl = URL.createObjectURL(blob);
        blobUrlCacheRef.current.set(key, blobUrl);
      })
      .catch(() => {}); // silent — falls back to direct URL on transition
  }, []);

  /**
   * Get the best audio URL for a key: blob URL if pre-fetched, else direct URL.
   */
  const getAudioUrl = useCallback((key: number, fallback: string): string => {
    return blobUrlCacheRef.current.get(key) ?? fallback;
  }, []);

  const fetchSegment = useCallback(async (
    startTime: number,
    signal: AbortSignal,
    onProgress?: (p: string) => void,
    pipelineUpdate = false
  ): Promise<SegmentJob> => {
    const key = normalizeStart(startTime);
    const existing = inFlightRef.current.get(key);
    if (existing) return existing;

    const work = (async (): Promise<SegmentJob> => {
    const label = `${formatTime(key)} – ${formatTime(key + SEGMENT_DURATION)}`;

    if (pipelineUpdate) {
      setPipelineSegmentLabel(label);
      setPipelineDone(false);
      setPipelineProgress('جاري استخراج الصوت...');
    }

    const jobId = await requestSegment(processingSource, key, selectedModel, selectedVoice);

    const job = await pollJob(jobId, (p) => {
      onProgress?.(p);
      if (pipelineUpdate) setPipelineProgress(p);
    }, signal);

    if (job.status === 'completed') {
      segmentCacheRef.current.set(key, job);
      // Pre-fetch the audio blob immediately so it's in memory for instant playback
      if (job.audioUrl) prefetchAudioBlob(key, job.audioUrl);
      if (pipelineUpdate) {
        setPipelineDone(true);
        setTimeout(() => setPipelineDone(false), 800);
      }
    }

    return job;
    })();

    inFlightRef.current.set(key, work);
    try {
      return await work;
    } finally {
      inFlightRef.current.delete(key);
    }
  }, [processingSource, selectedModel, selectedVoice, prefetchAudioBlob]);

  // Prepare exactly one segment ahead. The current segment is already playing
  // (or being fetched by playSegment); this function must never walk through
  // the entire video in the background.
  const startChain = useCallback(async (fromSegment: number, signal: AbortSignal) => {
    const key = normalizeStart(fromSegment);
    const videoDuration = getMediaDuration();
    if (signal.aborted || (Number.isFinite(videoDuration) && key >= videoDuration)) {
      setPipelineVisible(false);
      return;
    }
    if (segmentCacheRef.current.has(key) || inFlightRef.current.has(key)) return;

    furthestQueuedRef.current = key;
    try {
      await fetchSegment(key, signal, undefined, true);
    } catch (err) {
      if (!signal.aborted) {
        console.error(`[pipeline] ahead segment ${key} failed`, err);
      }
    }
  }, [fetchSegment, getMediaDuration]);

  /**
   * Full seek + play (initial play and manual seeks only).
   * Seeks video to segment start, loads audio from position 0, starts both.
   */
  const playSynced = useCallback((job: SegmentJob, key: number) => {
    if (!audioRef.current || !job.audioUrl) return;

    const offset = audioOffsetRef.current;
    const rate = job.videoRate ?? 1.0;
    const audioUrl = getAudioUrl(key, job.audioUrl);

    console.debug(`[playSynced] key=${key} rate=${rate} offset=${offset} blob=${audioUrl.startsWith('blob:')}`);

    isSyncingRef.current = true;
    seekMedia(key);

    audioRef.current.src = audioUrl;
    audioRef.current.load();

    const doPlay = () => {
      if (!audioRef.current) return;
      audioRef.current.currentTime = 0;
      if (offset >= 0) {
        setMediaRate(rate < 1.0 ? rate : 1.0);
        playMedia();
        setTimeout(() => { audioRef.current?.play().catch(() => {}); }, offset * 1000);
      } else {
        audioRef.current.play().catch(() => {});
        setTimeout(() => {
          setMediaRate(rate < 1.0 ? rate : 1.0);
          playMedia();
        }, -offset * 1000);
      }
      activeSegmentKeyRef.current = key;
      lastTimeRef.current = key;
      setIsPlaying(true);
      setTimeout(() => { isSyncingRef.current = false; }, 1000);
    };

    const isBlobUrl = audioUrl.startsWith('blob:');
    if (isBlobUrl) {
      setTimeout(doPlay, 150);
    } else {
      setTimeout(doPlay, 600);
    }
  }, [getAudioUrl, playMedia, seekMedia, setMediaRate]);

  /** Switch the TTS track at the video's current position. The YouTube player
   * is the master clock during continuous playback; this function never seeks
   * it, which removes the source of automatic backward/forward jumps. */
  const transitionToNext = useCallback((job: SegmentJob, key: number) => {
    if (!audioRef.current || !job.audioUrl) return;
    const rate = job.videoRate ?? 1.0;
    const audioUrl = getAudioUrl(key, job.audioUrl);
    const isBlobUrl = audioUrl.startsWith('blob:');

    activeSegmentKeyRef.current = key;
    isSyncingRef.current = true;

    audioRef.current.src = audioUrl;
    audioRef.current.load();

    const doPlay = () => {
      if (!audioRef.current) return;

      const ytTime = getMediaTime();
      const audioStart = Math.max(0, Math.min(ytTime - key, SEGMENT_DURATION - 0.2));
      audioRef.current.currentTime = audioStart;
      audioRef.current.play().catch(err => {
        console.debug('[transition] audio play was rejected', err);
      });
      lastTimeRef.current = ytTime;
      pendingTransitionKeyRef.current = null;

      console.debug(`[transition] key=${key} ytTime=${ytTime.toFixed(2)} audioStart=${audioStart.toFixed(2)}`);

      setMediaRate(rate < 1.0 ? rate : 1.0);
      setIsPlaying(true);
      setTimeout(() => { isSyncingRef.current = false; }, 800);
    };

    if (isBlobUrl) {
      doPlay();
    } else {
      setTimeout(doPlay, 400);
    }
  }, [getAudioUrl, getMediaTime, setMediaRate]);

  const advanceToNext = useCallback(async (nextKey: number) => {
    if (isAdvancingRef.current) return;
    isAdvancingRef.current = true;
    try {
      const videoDuration = getMediaDuration();
      if (Number.isFinite(videoDuration) && nextKey >= videoDuration) {
        audioRef.current?.pause();
        pauseMedia();
        setIsPlaying(false);
        return;
      }

      const cached = segmentCacheRef.current.get(nextKey);
      if (cached?.status === 'completed' && cached.audioUrl) {
        let waited = 0;
        while (!blobUrlCacheRef.current.has(nextKey) && waited < 2000) {
          await new Promise(r => setTimeout(r, 100));
          waited += 100;
        }
        transitionToNext(cached, nextKey);
        // Once the prepared segment becomes current, prepare exactly one more.
        if (chainAbortRef.current && !chainAbortRef.current.signal.aborted) {
          void startChain(nextKey + SEGMENT_DURATION, chainAbortRef.current.signal);
        }
        return;
      }

      // Hold the video at the boundary while the one-ahead segment finishes.
      pauseMedia();
      audioRef.current?.pause();
      setIsPlaying(false);
      pendingTransitionKeyRef.current = nextKey;

      let waited = 0;
      while (!segmentCacheRef.current.has(nextKey) && waited < 60000) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
      }

      const readyJob = segmentCacheRef.current.get(nextKey);
      if (readyJob?.status === 'completed' && readyJob.audioUrl) {
        let blobWaited = 0;
        while (!blobUrlCacheRef.current.has(nextKey) && blobWaited < 2000) {
          await new Promise(r => setTimeout(r, 100));
          blobWaited += 100;
        }
        transitionToNext(readyJob, nextKey);
        playMedia();
        if (chainAbortRef.current && !chainAbortRef.current.signal.aborted) {
          void startChain(nextKey + SEGMENT_DURATION, chainAbortRef.current.signal);
        }
      } else {
        pendingTransitionKeyRef.current = null;
        toast({ title: '❌ تعذر تجهيز المقطع التالي', description: 'تحقق من الرابط وحاول إعادة التشغيل.', variant: 'destructive' });
      }
    } finally {
      isAdvancingRef.current = false;
    }
  }, [getMediaDuration, pauseMedia, playMedia, startChain, toast, transitionToNext]);

  /**
   * Audio ending is not itself a reason to seek the video. If TTS ends a little
   * early, wait for the video clock to reach the boundary; the sync monitor
   * calls advanceToNext there.
   */
  const handleAudioEnded = useCallback(async () => {
    const nextKey = activeSegmentKeyRef.current + SEGMENT_DURATION;
    const ytTime = getMediaTime();
    if (ytTime < nextKey - 0.75) {
      pendingTransitionKeyRef.current = nextKey;
      console.debug(`[audio-ended] TTS ended early at ${ytTime.toFixed(2)}; waiting for boundary ${nextKey}`);
      return;
    }
    await advanceToNext(nextKey);
  }, [advanceToNext, getMediaTime]);

  const playSegment = useCallback(async (startTime: number, showLoading: boolean) => {
    const key = normalizeStart(startTime);

    pauseMedia();
    audioRef.current?.pause();
    setIsPlaying(false);

    let job = segmentCacheRef.current.get(key);

    if (!job) {
      const abortCtrl = new AbortController();
      if (showLoading) {
        setShowOverlay(true);
        setOverlayProgress('جاري تجهيز المقطع...');
        try {
          job = await fetchSegment(key, abortCtrl.signal, (p) => setOverlayProgress(p));
        } catch {
          setShowOverlay(false);
          toast({ title: '❌ خطأ', description: 'فشل تحميل المقطع.', variant: 'destructive' });
          return;
        }
      } else {
        // Background seek: wait up to 30s without showing overlay
        let waited = 0;
        while (!segmentCacheRef.current.has(key) && waited < 30000) {
          await new Promise(r => setTimeout(r, 400));
          waited += 400;
        }
        job = segmentCacheRef.current.get(key);
        if (!job) {
          // Still not ready: request it directly
          setShowOverlay(true);
          setOverlayProgress('جاري تجهيز المقطع...');
          try {
            job = await fetchSegment(key, abortCtrl.signal, (p) => setOverlayProgress(p));
          } catch {
            setShowOverlay(false);
            toast({ title: '❌ خطأ', description: 'فشل تحميل المقطع.', variant: 'destructive' });
            return;
          }
        }
      }
    }

    setShowOverlay(false);

    if (!job || job.status === 'failed') {
      toast({ title: '❌ فشل المقطع', variant: 'destructive' });
      return;
    }

    // Wait for blob URL if available
    let waited = 0;
    while (!blobUrlCacheRef.current.has(key) && waited < 1500) {
      await new Promise(r => setTimeout(r, 100));
      waited += 100;
    }

    playSynced(job, key);
  }, [fetchSegment, pauseMedia, toast, playSynced]);

  const handleInitialPlay = useCallback(async () => {
    if (!mediaReady || !selectedModel || !selectedVoice) {
      toast({ title: 'بيانات ناقصة', description: 'تأكد من الرابط والنموذج والصوت.', variant: 'destructive' });
      return;
    }

    chainAbortRef.current?.abort();
    segmentCacheRef.current.clear();
    blobUrlCacheRef.current.forEach(u => URL.revokeObjectURL(u));
    blobUrlCacheRef.current.clear();
    inFlightRef.current.clear();

    const time = getMediaTime();
    setHasStarted(true);
    setShowOverlay(true);
    setOverlayProgress('جاري استخراج الصوت...');

    const abortCtrl = new AbortController();
    chainAbortRef.current = abortCtrl;

    const key = normalizeStart(time);

    try {
      const job = await fetchSegment(key, abortCtrl.signal, (p) => setOverlayProgress(p));
      setShowOverlay(false);

      if (!job || job.status === 'failed') {
        toast({ title: '❌ فشل المقطع', variant: 'destructive' });
        return;
      }

      // Wait up to 1s for blob to be ready for a clean start
      let waited = 0;
      while (!blobUrlCacheRef.current.has(key) && waited < 1000) {
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
      }

      playSynced(job, key);

      setPipelineVisible(true);
      const nextKey = key + SEGMENT_DURATION;
      startChain(nextKey, abortCtrl.signal);

    } catch {
      setShowOverlay(false);
      toast({ title: '❌ خطأ في الاتصال', variant: 'destructive' });
    }
  }, [mediaReady, getMediaTime, selectedModel, selectedVoice, fetchSegment, startChain, toast, playSynced]);

  // ── Seek detection ──────────────────────────────────────────────────────────
  // Fires only on genuine USER seeks (> 4 s jump).
  // Gated on both isSeekingRef AND isSyncingRef so internal corrections
  // (transitionToNext, sync monitor) never trigger a false seek.
  useEffect(() => {
    if (!hasStarted) return;
    const timer = setInterval(() => {
      if (!isPlaying || (!ytPlayerRef.current && !genericVideoRef.current)) return;
      if (isSyncingRef.current || isSeekingRef.current) return; // skip internal syncs
      const time = getMediaTime();
      const delta = Math.abs(time - lastTimeRef.current);
      if (delta > 4) {
        console.debug(`[seek-detect] jump ${lastTimeRef.current.toFixed(1)}→${time.toFixed(1)} (Δ${delta.toFixed(1)}s) — treating as user seek`);
        isSeekingRef.current = true;
        const key = normalizeStart(time);
        const cached = segmentCacheRef.current.has(key);
        playSegment(time, !cached);

        chainAbortRef.current?.abort();
        const abortCtrl = new AbortController();
        chainAbortRef.current = abortCtrl;
        startChain(key + SEGMENT_DURATION, abortCtrl.signal);

        setTimeout(() => { isSeekingRef.current = false; }, 1500);
      }
      lastTimeRef.current = time;
    }, 500);
    return () => clearInterval(timer);
  }, [hasStarted, isPlaying, getMediaTime, playSegment, startChain]);

  // ── Continuous sync monitor ──────────────────────────────────────────────
  // The YouTube player is the master clock. We correct the finite TTS track
  // to the video position, never the other way around, so sync can never
  // create a backward/forward YouTube jump.
  useEffect(() => {
    if (!hasStarted) return;
    const id = setInterval(() => {
      if (!isPlaying || isSyncingRef.current || isSeekingRef.current || isAdvancingRef.current) return;
      const audio = audioRef.current;
      if (!ytPlayerRef.current && !genericVideoRef.current) return;

      const segKey = activeSegmentKeyRef.current;
      const actualVideoTime = getMediaTime();
      const nextKey = segKey + SEGMENT_DURATION;

      if (pendingTransitionKeyRef.current === nextKey || actualVideoTime >= nextKey - 0.5) {
        void advanceToNext(nextKey);
        return;
      }

      if (!audio || audio.paused || audio.ended || !audio.src) {
        console.debug(`[sync] audio unavailable key=${segKey} video=${actualVideoTime.toFixed(2)}`);
        return;
      }

      const audioPos = audio.currentTime;
      const expectedVideoTime = segKey + audioPos;
      const drift = actualVideoTime - expectedVideoTime; // + = video ahead of audio

      console.debug(
        `[sync] key=${segKey} audio=${audioPos.toFixed(2)}` +
        ` expected=${expectedVideoTime.toFixed(2)} actual=${actualVideoTime.toFixed(2)}` +
        ` drift=${drift >= 0 ? '+' : ''}${drift.toFixed(2)}`
      );

      if (Math.abs(drift) > SYNC_DRIFT_THRESHOLD) {
        const correctedAudioTime = Math.max(0, Math.min(
          actualVideoTime - segKey,
          Math.max(0, (audio.duration || SEGMENT_DURATION) - 0.1),
        ));
        console.debug(`[sync] correcting audio by ${drift.toFixed(2)}s → audio.currentTime=${correctedAudioTime.toFixed(2)}`);
        isSyncingRef.current = true;
        audio.currentTime = correctedAudioTime;
        audio.play().catch(err => console.debug('[sync] audio resume rejected', err));
        lastTimeRef.current = actualVideoTime;
        setTimeout(() => { isSyncingRef.current = false; }, 250);
      }
    }, 2000);
    return () => clearInterval(id);
  }, [hasStarted, isPlaying, advanceToNext, getMediaTime]);

  const handleYoutubeStateChange = (event: any) => {
    if (isSyncingRef.current) return;
    if (event.data === 1 && !showOverlay) {
      setIsPlaying(true);
      if (audioRef.current?.src && audioRef.current.paused && !audioRef.current.ended) {
        audioRef.current.play().catch(() => {});
      }
    } else if (event.data === 2) {
      setIsPlaying(false);
      if (audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause();
      }
    }
  };

  const handleYoutubeReady = (event: any) => {
    ytPlayerRef.current = event.target;
    event.target.setVolume(videoVolume * 100);
  };

  const handleLocalFile = (file: File | undefined) => {
    if (!file) return;
    chainAbortRef.current?.abort();
    audioRef.current?.pause();
    setUrl('');
    setLocalFile(file);
    setHasStarted(false);
    setIsPlaying(false);
    setShowOverlay(false);
    setPipelineVisible(false);
  };

  const handleGenericPlay = () => {
    setIsPlaying(true);
    if (audioRef.current?.src && audioRef.current.paused && !audioRef.current.ended) {
      audioRef.current.play().catch(err => console.debug('[media] audio resume rejected', err));
    }
  };

  const handleGenericPause = () => {
    setIsPlaying(false);
    audioRef.current?.pause();
  };

  const adjustOffset = (delta: number) => {
    setAudioOffset(prev => {
      const next = Math.round((prev + delta) * 10) / 10;
      return Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, next));
    });
  };

  const handleOpenAiPreview = () => {
    if (!openAiVoice) return;
    setOpenAiPreviewError('');
    previewOpenAiVoice.mutate(
      {
        data: {
          voice: openAiVoice as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer',
          text: openAiPreviewText.trim(),
        },
      },
      {
        onSuccess: (audio) => {
          if (openAiPreviewUrl) URL.revokeObjectURL(openAiPreviewUrl);
          setOpenAiPreviewUrl(URL.createObjectURL(audio));
        },
        onError: () => setOpenAiPreviewError('تعذر إنشاء معاينة صوت OpenAI.'),
      },
    );
  };

  const allVoices = useMemo(() => {
    const voices: { id: string; name: string; gender: string; locale: string }[] = [];
    for (const m of modelsData?.models ?? []) {
      for (const v of m.voices ?? []) {
        voices.push({
          id: v.id,
          name: v.name,
          gender: v.gender,
          locale: (v as any).locale || (m.id === 'google-translate' ? 'ar' : 'en-US'),
        });
      }
    }
    return voices;
  }, [modelsData]);

  const offsetDisplay = audioOffset === 0 ? '0.0 ث' : `${audioOffset > 0 ? '+' : ''}${audioOffset.toFixed(1)} ث`;

  return (
    <div className="min-h-screen bg-background text-foreground relative overflow-hidden" dir="rtl">
      <div className="absolute inset-0 bg-gradient-to-br from-background via-background to-primary/5 pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-primary/5 blur-3xl rounded-full pointer-events-none" />

      <audio ref={audioRef} onEnded={handleAudioEnded} className="hidden" />

      <ProcessingOverlay isVisible={showOverlay} progressText={overlayProgress} />

      <PipelineBar
        isVisible={pipelineVisible && !showOverlay}
        progressText={pipelineProgress}
        segmentLabel={pipelineSegmentLabel}
        done={pipelineDone}
      />

      <div className="relative z-10 max-w-3xl mx-auto px-4 py-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-8"
        >
          <div className="flex items-center justify-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center">
              <Youtube className="w-5 h-5 text-primary" />
            </div>
            <h1 className="text-3xl font-bold font-display text-foreground">مترجم الفيديو</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            دبلجة فيديوهات يوتيوب إلى العربية بالذكاء الاصطناعي — مجاناً
          </p>
        </motion.div>

        {/* URL input */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-6"
        >
          <div className="relative">
            <Youtube className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground z-10" />
            <Input
              dir="ltr"
              placeholder="https://www.youtube.com/watch?v=..."
              value={url}
              onChange={e => {
                setLocalFile(null);
                setUrl(e.target.value);
              }}
              className="pr-12 py-6 text-lg bg-card/60 border-border/50 backdrop-blur focus-visible:ring-primary/50 text-left font-mono placeholder:text-right placeholder:font-sans"
              disabled={showOverlay}
            />
          </div>
          <div className="flex items-center justify-between gap-3 mt-3">
            <label className="inline-flex cursor-pointer items-center rounded-md border border-border/50 bg-card/50 px-3 py-2 text-xs text-muted-foreground hover:bg-card">
              اختر ملف فيديو من الجهاز
              <input
                type="file"
                className="sr-only"
                accept="video/*,.mkv,.avi,.mov,.flv,.webm,.mp4"
                disabled={showOverlay}
                onChange={e => handleLocalFile(e.target.files?.[0])}
              />
            </label>
            {localFile && (
              <span className="min-w-0 truncate text-xs text-muted-foreground">{localFile.name}</span>
            )}
          </div>
          {mediaProbeLoading && !localFile && (
            <p className="text-muted-foreground text-xs mt-2 text-right">جاري فحص مصدر الفيديو...</p>
          )}
          {mediaError && (
            <p className="text-destructive text-xs mt-2 text-right">{mediaError}</p>
          )}
          {!isValid && url.length > 0 && !localFile && !mediaProbe && (
            <p className="text-destructive text-xs mt-2 text-right">
              أدخل رابط YouTube أو رابط فيديو مباشر أو بث HLS/DASH صالح.
            </p>
          )}
        </motion.div>

        <AnimatePresence>
          {mediaReady && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="space-y-5"
            >
              {/* YouTube or generic media player */}
              <Card className="overflow-hidden border-border/50 bg-card/60 backdrop-blur">
                <div className="aspect-video w-full">
                  {isYouTubeSource ? (
                    <YouTube
                      videoId={videoId}
                      className="w-full h-full"
                      iframeClassName="w-full h-full"
                      opts={{
                        width: '100%',
                        height: '100%',
                        playerVars: { autoplay: 0, controls: 1, rel: 0 },
                      }}
                      onReady={handleYoutubeReady}
                      onStateChange={handleYoutubeStateChange}
                    />
                  ) : (
                    <video
                      ref={genericVideoRef}
                      className="h-full w-full bg-black object-contain"
                      controls
                      playsInline
                      preload="metadata"
                      onPlay={handleGenericPlay}
                      onPause={handleGenericPause}
                      onError={() => setMediaError('تعذر تشغيل هذا المصدر في المتصفح')}
                    />
                  )}
                </div>
              </Card>

              {/* Controls */}
              <Card className="p-5 border-border/50 bg-card/60 backdrop-blur">
                <div className="flex items-center gap-2 mb-4">
                  <Settings className="w-4 h-4 text-primary" />
                  <h3 className="font-semibold text-sm text-foreground">إعدادات الدبلجة</h3>
                </div>

                {/* Model selector */}
                <div className="mb-4">
                  <label className="text-xs text-muted-foreground font-medium block mb-1.5">مزود الصوت (TTS)</label>
                  <Select
                    value={selectedModel}
                    onValueChange={setSelectedModel}
                    disabled={isLoadingModels || showOverlay}
                  >
                    <SelectTrigger className="bg-background/50 border-border/50">
                      <SelectValue placeholder="اختر المزود..." />
                    </SelectTrigger>
                    <SelectContent>
                      {modelsData?.models.map(m => (
                        <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="mb-5 rounded-xl border border-primary/20 bg-primary/5 p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-primary" />
                    <div>
                      <h4 className="text-sm font-semibold text-foreground">أصوات OpenAI</h4>
                      <p className="text-[11px] text-muted-foreground">معاينة الصوت من داخل قسم الدبلجة الحالي</p>
                    </div>
                  </div>
                  <label className="text-xs text-muted-foreground font-medium block mb-1.5">الصوت العربي</label>
                  <Select
                    value={openAiVoice}
                    onValueChange={setOpenAiVoice}
                    disabled={isLoadingOpenAiOptions || showOverlay}
                  >
                    <SelectTrigger className="bg-background/50 border-border/50">
                      <SelectValue placeholder="اختر صوت OpenAI..." />
                    </SelectTrigger>
                    <SelectContent>
                      {openAiOptions?.voices.map(voice => (
                        <SelectItem key={voice.id} value={voice.id}>{voice.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <textarea
                    value={openAiPreviewText}
                    onChange={event => setOpenAiPreviewText(event.target.value.slice(0, 500))}
                    rows={2}
                    placeholder="اكتب نص المعاينة..."
                    className="mt-3 w-full resize-none rounded-md border border-border/50 bg-background/50 px-3 py-2 text-sm leading-6 outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleOpenAiPreview}
                    disabled={!openAiVoice || previewOpenAiVoice.isPending || showOverlay}
                    className="mt-3 w-full"
                  >
                    {previewOpenAiVoice.isPending ? 'جاري إنشاء المعاينة...' : 'استمع إلى معاينة الصوت'}
                  </Button>
                  {openAiPreviewUrl && (
                    <audio controls src={openAiPreviewUrl} className="mt-3 w-full" />
                  )}
                  {openAiPreviewError && (
                    <p className="mt-2 text-xs text-destructive">{openAiPreviewError}</p>
                  )}
                </div>

                {/* Voice picker */}
                <div className="mb-4">
                  <label className="text-xs text-muted-foreground font-medium block mb-1.5">الصوت</label>
                  <VoicePicker
                    voices={allVoices}
                    selectedVoice={selectedVoice}
                    onSelect={setSelectedVoice}
                    disabled={isLoadingModels || showOverlay || !selectedModel}
                  />
                </div>

                {/* Independent volume controls */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 mt-5">
                  <label className="text-xs text-muted-foreground font-medium">
                    مستوى صوت الفيديو
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={videoVolume}
                        onChange={e => setVideoVolume(Number(e.target.value))}
                        className="w-full accent-primary"
                      />
                      <span className="w-10 text-left font-mono">{Math.round(videoVolume * 100)}%</span>
                    </div>
                  </label>
                  <label className="text-xs text-muted-foreground font-medium">
                    مستوى صوت الدبلجة
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={ttsVolume}
                        onChange={e => setTtsVolume(Number(e.target.value))}
                        className="w-full accent-primary"
                      />
                      <span className="w-10 text-left font-mono">{Math.round(ttsVolume * 100)}%</span>
                    </div>
                  </label>
                </div>

                {/* Audio offset control */}
                {isYouTubeSource && <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs text-muted-foreground font-medium">تزامن الصوت</label>
                    <span className="text-xs text-muted-foreground">
                      {audioOffset < 0 ? 'الصوت مُقدَّم' : audioOffset > 0 ? 'الصوت مُؤخَّر' : 'متزامن'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => adjustOffset(-OFFSET_STEP)}
                      disabled={audioOffset <= OFFSET_MIN || showOverlay}
                      title="تقديم الصوت 0.1 ث"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>

                    <div className="flex-1 flex items-center justify-center bg-background/50 border border-border/50 rounded-md h-8 px-3">
                      <span className="text-sm font-mono text-primary">{offsetDisplay}</span>
                    </div>

                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => adjustOffset(OFFSET_STEP)}
                      disabled={audioOffset >= OFFSET_MAX || showOverlay}
                      title="تأخير الصوت 0.1 ث"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>

                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setAudioOffset(0.0)}
                      disabled={audioOffset === 0 || showOverlay}
                      title="إعادة الضبط"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground mt-1 px-1">
                    <span>← تقديم</span>
                    <span className="text-center opacity-50">كل ضغطة = 0.1 ث</span>
                    <span>تأخير →</span>
                  </div>
                </div>}

                {/* Play button */}
                <Button
                  onClick={handleInitialPlay}
                  disabled={
                    showOverlay
                    || !mediaReady
                    || mediaProbeLoading
                    || (!isYouTubeSource && !!localFile && !uploadedLocalUrl)
                    || (isYouTubeSource && (!selectedModel || !selectedVoice || isLoadingModels))
                  }
                  className="w-full mt-5 py-6 text-base font-semibold bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  {showOverlay ? (
                    <>
                      <RefreshCcw className="w-4 h-4 ml-2 animate-spin" />
                      جاري المعالجة...
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 ml-2" />
                      {hasStarted ? 'إعادة التشغيل' : 'بدء التشغيل والدبلجة'}
                      <Wand2 className="w-4 h-4 mr-2" />
                    </>
                  )}
                </Button>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Info cards */}
        {!mediaReady && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4"
          >
            {[
              { icon: '🎬', title: 'أدخل مصدر الفيديو', desc: 'الصق رابط YouTube أو رابط فيديو مباشر أو اختر ملفاً من جهازك' },
              { icon: '🎙️', title: 'اختر الصوت', desc: 'اختر من أصوات مايكروسوفت أو جوجل المجانية' },
              { icon: '🔊', title: 'استمع بالعربية', desc: 'يُترجم الصوت تلقائياً مع تزامن الفيديو' },
            ].map((item, i) => (
              <Card key={i} className="p-4 border-border/30 bg-card/30 backdrop-blur text-center">
                <div className="text-2xl mb-2">{item.icon}</div>
                <h4 className="font-semibold text-sm text-foreground mb-1">{item.title}</h4>
                <p className="text-xs text-muted-foreground">{item.desc}</p>
              </Card>
            ))}
          </motion.div>
        )}
      </div>
    </div>
  );
}
