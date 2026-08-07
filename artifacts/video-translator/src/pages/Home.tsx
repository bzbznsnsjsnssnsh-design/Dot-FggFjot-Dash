import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import YouTube from 'react-youtube';
import { Play, Youtube, Settings, Wand2, RefreshCcw, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { useToast } from '@/hooks/use-toast';
import { useGetTtsModels } from '@workspace/api-client-react';
import { useYoutubeUrl } from '@/hooks/use-youtube-url';
import { ProcessingOverlay } from '@/components/processing-overlay';
import { PipelineBar } from '@/components/pipeline-bar';
import { VoicePicker } from '@/components/voice-picker';

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
  const audioRef = useRef<HTMLAudioElement>(null);
  const lastTimeRef = useRef(0);
  const isSeekingRef = useRef(false);
  const isSyncingRef = useRef(false);
  const activeSegmentKeyRef = useRef(0);
  const audioOffsetRef = useRef(0);

  const [selectedModel, setSelectedModel] = useState('');
  const [selectedVoice, setSelectedVoice] = useState('');
  const [audioOffset, setAudioOffset] = useState(0.0);

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

  const normalizeStart = (t: number) => Math.floor(t / SEGMENT_DURATION) * SEGMENT_DURATION;

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
    const label = `${formatTime(key)} – ${formatTime(key + SEGMENT_DURATION)}`;

    if (pipelineUpdate) {
      setPipelineSegmentLabel(label);
      setPipelineDone(false);
      setPipelineProgress('جاري استخراج الصوت...');
    }

    const jobId = await requestSegment(url, key, selectedModel, selectedVoice);

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
  }, [url, selectedModel, selectedVoice, prefetchAudioBlob]);

  const startChain = useCallback(async (fromSegment: number, signal: AbortSignal) => {
    let current = normalizeStart(fromSegment);
    while (!signal.aborted) {
      // Stop when we've passed the actual video duration
      const videoDuration = ytPlayerRef.current?.getDuration?.() ?? Infinity;
      if (Number.isFinite(videoDuration) && current >= videoDuration) {
        setPipelineVisible(false);
        break;
      }

      const key = current;
      if (!segmentCacheRef.current.has(key)) {
        try {
          furthestQueuedRef.current = key;
          await fetchSegment(key, signal, undefined, true);
        } catch {
          if (signal.aborted) break;
          await new Promise<void>(r => setTimeout(r, 3000));
          continue;
        }
      }
      current += SEGMENT_DURATION;
      await new Promise<void>(r => {
        const t = setTimeout(r, 300);
        signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
      });
    }
  }, [fetchSegment]);

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
    ytPlayerRef.current?.seekTo(key, true);

    audioRef.current.src = audioUrl;
    audioRef.current.load();

    const doPlay = () => {
      if (!audioRef.current) return;
      audioRef.current.currentTime = 0;
      if (offset >= 0) {
        ytPlayerRef.current?.setPlaybackRate(rate < 1.0 ? rate : 1.0);
        ytPlayerRef.current?.playVideo();
        setTimeout(() => { audioRef.current?.play().catch(() => {}); }, offset * 1000);
      } else {
        audioRef.current.play().catch(() => {});
        setTimeout(() => {
          ytPlayerRef.current?.setPlaybackRate(rate < 1.0 ? rate : 1.0);
          ytPlayerRef.current?.playVideo();
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
  }, [getAudioUrl]);

  /**
   * Seamless audio-only transition (no backward video seek).
   * Starts audio at an offset that matches the video's current position so
   * the two tracks stay aligned without ever seeking the video backward.
   */
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

      const ytTime = ytPlayerRef.current?.getCurrentTime?.() ?? key;
      // Offset audio so it matches where the video currently is.
      // This prevents any backward seek: if video is at key+3, audio starts at t=3.
      const audioStart = Math.max(0, Math.min(ytTime - key, 45)); // clamp 0–45 s
      audioRef.current.currentTime = audioStart;
      audioRef.current.play().catch(() => {});

      // Only seek video FORWARD if it fell significantly behind the segment boundary.
      // NEVER seek backward — that is the root cause of the backward-jump bug.
      if (ytTime < key - 2.0) {
        console.debug(`[transition] video behind by ${(key - ytTime).toFixed(2)}s → seeking forward to ${key}`);
        ytPlayerRef.current?.seekTo(key, true);
      }

      // Update lastTimeRef to actual video position (not key) so seek-detector
      // doesn't fire on this transition.
      lastTimeRef.current = ytTime;

      console.debug(`[transition] key=${key} ytTime=${ytTime.toFixed(2)} audioStart=${audioStart.toFixed(2)}`);

      ytPlayerRef.current?.setPlaybackRate(rate < 1.0 ? rate : 1.0);
      setIsPlaying(true);
      setTimeout(() => { isSyncingRef.current = false; }, 800);
    };

    if (isBlobUrl) {
      doPlay();
    } else {
      setTimeout(doPlay, 400);
    }
  }, [getAudioUrl]);

  /**
   * Handle audio ending: decide how to move to the next segment.
   * - If next segment is cached + blob ready → seamless transition (video never pauses)
   * - If next segment is cached + blob still loading → short wait then switch
   * - If next segment not yet cached → pause video + wait silently (no overlay)
   *   Once ready, seek video back to correct position and play
   */
  const handleAudioEnded = useCallback(async () => {
    const nextKey = activeSegmentKeyRef.current + SEGMENT_DURATION;

    // Stop at end of video
    const videoDuration = ytPlayerRef.current?.getDuration?.() ?? Infinity;
    if (Number.isFinite(videoDuration) && nextKey >= videoDuration) {
      setIsPlaying(false);
      ytPlayerRef.current?.pauseVideo();
      return;
    }

    const cached = segmentCacheRef.current.get(nextKey);

    if (cached?.status === 'completed' && cached.audioUrl) {
      // Check if blob URL is ready
      const blobUrl = blobUrlCacheRef.current.get(nextKey);
      if (blobUrl) {
        // ✅ Best case: blob in memory → instant, seamless transition
        transitionToNext(cached, nextKey);
      } else {
        // Blob still downloading — wait up to 2s for it
        let waited = 0;
        while (!blobUrlCacheRef.current.has(nextKey) && waited < 2000) {
          await new Promise(r => setTimeout(r, 100));
          waited += 100;
        }
        transitionToNext(cached, nextKey);
      }
      return;
    }

    // Segment not ready yet — pause video silently and wait
    ytPlayerRef.current?.pauseVideo();
    setIsPlaying(false);

    // Wait for background chain to finish (up to 60s)
    let waited = 0;
    while (!segmentCacheRef.current.has(nextKey) && waited < 60000) {
      await new Promise(r => setTimeout(r, 500));
      waited += 500;
    }

    const readyJob = segmentCacheRef.current.get(nextKey);
    if (!readyJob || readyJob.status === 'failed') {
      // Last resort: request this segment directly with overlay
      setShowOverlay(true);
      setOverlayProgress('جاري تجهيز المقطع...');
      try {
        const abortCtrl = new AbortController();
        const job = await fetchSegment(nextKey, abortCtrl.signal, (p) => setOverlayProgress(p));
        setShowOverlay(false);
        if (job.status === 'completed') {
          playSynced(job, nextKey);
        } else {
          toast({ title: '❌ فشل المقطع', variant: 'destructive' });
        }
      } catch {
        setShowOverlay(false);
        toast({ title: '❌ خطأ في تحميل المقطع', variant: 'destructive' });
      }
      return;
    }

    // Segment is now ready — play it (video was paused at current position)
    setShowOverlay(false);
    // Wait for blob pre-fetch (it may have just completed)
    let blobWaited = 0;
    while (!blobUrlCacheRef.current.has(nextKey) && blobWaited < 2000) {
      await new Promise(r => setTimeout(r, 100));
      blobWaited += 100;
    }
    playSynced(readyJob, nextKey);
  }, [transitionToNext, fetchSegment, playSynced, toast]);

  const playSegment = useCallback(async (startTime: number, showLoading: boolean) => {
    const key = normalizeStart(startTime);

    ytPlayerRef.current?.pauseVideo();
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
  }, [fetchSegment, toast, playSynced]);

  const handleInitialPlay = useCallback(async () => {
    if (!isValid || !selectedModel || !selectedVoice) {
      toast({ title: 'بيانات ناقصة', description: 'تأكد من الرابط والنموذج والصوت.', variant: 'destructive' });
      return;
    }

    chainAbortRef.current?.abort();
    segmentCacheRef.current.clear();
    blobUrlCacheRef.current.forEach(u => URL.revokeObjectURL(u));
    blobUrlCacheRef.current.clear();
    inFlightRef.current.clear();

    const time = ytPlayerRef.current?.getCurrentTime() || 0;
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
  }, [isValid, selectedModel, selectedVoice, fetchSegment, startChain, toast, playSynced]);

  // ── Seek detection ──────────────────────────────────────────────────────────
  // Fires only on genuine USER seeks (> 4 s jump).
  // Gated on both isSeekingRef AND isSyncingRef so internal corrections
  // (transitionToNext, sync monitor) never trigger a false seek.
  useEffect(() => {
    if (!hasStarted) return;
    const timer = setInterval(() => {
      if (!ytPlayerRef.current || !isPlaying) return;
      if (isSyncingRef.current || isSeekingRef.current) return; // skip internal syncs
      const time = ytPlayerRef.current.getCurrentTime();
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
  }, [hasStarted, isPlaying, playSegment, startChain]);

  // ── Continuous sync monitor ──────────────────────────────────────────────
  // Every 2 s, compares (segmentKey + audio.currentTime) with video position.
  // Corrects drift > SYNC_DRIFT_THRESHOLD by seeking the video to match audio.
  // Audio is the master clock because it is finite and precisely timed.
  useEffect(() => {
    if (!hasStarted) return;
    const id = setInterval(() => {
      if (!isPlaying || isSyncingRef.current || isSeekingRef.current) return;
      const audio = audioRef.current;
      if (!audio || audio.paused || audio.ended || !audio.src) return;
      const yt = ytPlayerRef.current;
      if (!yt?.getCurrentTime) return;

      const segKey = activeSegmentKeyRef.current;
      const audioPos = audio.currentTime;
      const expectedVideoTime = segKey + audioPos;
      const actualVideoTime = yt.getCurrentTime();
      const drift = actualVideoTime - expectedVideoTime; // + = video ahead of audio

      console.debug(
        `[sync] key=${segKey} audio=${audioPos.toFixed(2)}` +
        ` expected=${expectedVideoTime.toFixed(2)} actual=${actualVideoTime.toFixed(2)}` +
        ` drift=${drift >= 0 ? '+' : ''}${drift.toFixed(2)}`
      );

      if (Math.abs(drift) > SYNC_DRIFT_THRESHOLD) {
        console.debug(`[sync] ⚠ correcting ${drift.toFixed(2)}s drift → seeking video to ${expectedVideoTime.toFixed(2)}`);
        isSyncingRef.current = true;
        yt.seekTo(expectedVideoTime, true);
        lastTimeRef.current = expectedVideoTime; // prevent seek-detector false-fire
        setTimeout(() => { isSyncingRef.current = false; }, 1200);
      }
    }, 2000);
    return () => clearInterval(id);
  }, [hasStarted, isPlaying]);

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

  const adjustOffset = (delta: number) => {
    setAudioOffset(prev => {
      const next = Math.round((prev + delta) * 10) / 10;
      return Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, next));
    });
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
              onChange={e => setUrl(e.target.value)}
              className="pr-12 py-6 text-lg bg-card/60 border-border/50 backdrop-blur focus-visible:ring-primary/50 text-left font-mono placeholder:text-right placeholder:font-sans"
              disabled={showOverlay}
            />
          </div>
          {!isValid && url.length > 0 && (
            <p className="text-destructive text-xs mt-2 text-right">
              الرابط المدخل غير صحيح، يرجى إدخال رابط يوتيوب صالح.
            </p>
          )}
        </motion.div>

        <AnimatePresence>
          {isValid && videoId && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="space-y-5"
            >
              {/* YouTube player */}
              <Card className="overflow-hidden border-border/50 bg-card/60 backdrop-blur">
                <div className="aspect-video w-full">
                  <YouTube
                    videoId={videoId}
                    className="w-full h-full"
                    iframeClassName="w-full h-full"
                    opts={{
                      width: '100%',
                      height: '100%',
                      playerVars: { autoplay: 0, controls: 1, rel: 0 },
                    }}
                    onReady={e => { ytPlayerRef.current = e.target; }}
                    onStateChange={handleYoutubeStateChange}
                  />
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

                {/* Audio offset control */}
                <div className="mt-4">
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
                </div>

                {/* Play button */}
                <Button
                  onClick={handleInitialPlay}
                  disabled={showOverlay || !selectedModel || !selectedVoice || isLoadingModels}
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
        {!isValid && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4"
          >
            {[
              { icon: '🎬', title: 'أدخل رابط يوتيوب', desc: 'الصق رابط أي فيديو يوتيوب في الحقل أعلاه' },
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
