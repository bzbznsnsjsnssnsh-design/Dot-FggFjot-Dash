import React, { useState, useRef, useEffect, useCallback } from 'react';
import YouTube from 'react-youtube';
import { Play, Youtube, Settings, Wand2, RefreshCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { useToast } from '@/hooks/use-toast';
import { useGetTtsModels } from '@workspace/api-client-react';
import { useYoutubeUrl } from '@/hooks/use-youtube-url';
import { ProcessingOverlay } from '@/components/processing-overlay';
import { PipelineBar } from '@/components/pipeline-bar';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card } from '@/components/ui/card';

const SEGMENT_DURATION = 20;
const POLL_INTERVAL = 1500;

interface SegmentJob {
  jobId: string;
  status: 'processing' | 'completed' | 'failed';
  audioUrl: string | null;
  progress: string;
}

function formatTime(secs: number) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function requestSegment(videoUrl: string, startTime: number, model: string, voice: string, speed: number): Promise<string> {
  const res = await fetch('/api/translate/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoUrl, startTime, model, voice, speed }),
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
      return { jobId, status: 'completed', audioUrl: `/api/translate/audio/${jobId}`, progress: data.progress };
    }
    if (data.status === 'failed') {
      return { jobId, status: 'failed', audioUrl: null, progress: data.progress };
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

  const [selectedModel, setSelectedModel] = useState('');
  const [selectedVoice, setSelectedVoice] = useState('');
  const [speed, setSpeed] = useState(1.0);

  const [isPlaying, setIsPlaying] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [overlayProgress, setOverlayProgress] = useState('جاري تهيئة المقطع...');
  const [hasStarted, setHasStarted] = useState(false);

  const [pipelineVisible, setPipelineVisible] = useState(false);
  const [pipelineProgress, setPipelineProgress] = useState('');
  const [pipelineSegmentLabel, setPipelineSegmentLabel] = useState('');
  const [pipelineDone, setPipelineDone] = useState(false);

  const segmentCacheRef = useRef<Map<number, SegmentJob>>(new Map());
  const inFlightRef = useRef<Map<number, Promise<SegmentJob>>>(new Map());
  const furthestQueuedRef = useRef(-1);
  const chainAbortRef = useRef<AbortController | null>(null);

  const { data: modelsData, isLoading: isLoadingModels } = useGetTtsModels();

  const normalizeStart = (t: number) => Math.floor(t / SEGMENT_DURATION) * SEGMENT_DURATION;

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
    inFlightRef.current.clear();
    furthestQueuedRef.current = -1;
    setHasStarted(false);
    setShowOverlay(false);
    setPipelineVisible(false);
    setPipelineDone(false);
  }, [url]);

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

    const jobId = await requestSegment(url, key, selectedModel, selectedVoice, speed);

    const job = await pollJob(jobId, (p) => {
      onProgress?.(p);
      if (pipelineUpdate) setPipelineProgress(p);
    }, signal);

    if (job.status === 'completed') {
      segmentCacheRef.current.set(key, job);
      if (pipelineUpdate) {
        setPipelineDone(true);
        setTimeout(() => setPipelineDone(false), 800);
      }
    }

    return job;
  }, [url, selectedModel, selectedVoice, speed]);

  const startChain = useCallback(async (fromSegment: number, signal: AbortSignal) => {
    let current = normalizeStart(fromSegment);
    while (!signal.aborted) {
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
        const t = setTimeout(r, 500);
        signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
      });
    }
  }, [fetchSegment]);

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
        while (!segmentCacheRef.current.has(key)) {
          await new Promise(r => setTimeout(r, 400));
        }
        job = segmentCacheRef.current.get(key);
      }
    }

    setShowOverlay(false);

    if (!job || job.status === 'failed') {
      toast({ title: '❌ فشل المقطع', variant: 'destructive' });
      return;
    }

    if (audioRef.current && job.audioUrl) {
      isSyncingRef.current = true;
      ytPlayerRef.current?.seekTo(key, true);
      audioRef.current.src = job.audioUrl;
      audioRef.current.load();
      await new Promise(r => setTimeout(r, 600));
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {});
      ytPlayerRef.current?.playVideo();
      activeSegmentKeyRef.current = key;
      lastTimeRef.current = key;
      setIsPlaying(true);
      setTimeout(() => { isSyncingRef.current = false; }, 800);
    }
  }, [fetchSegment, toast]);

  const handleInitialPlay = useCallback(async () => {
    if (!isValid || !selectedModel || !selectedVoice) {
      toast({ title: 'بيانات ناقصة', description: 'تأكد من الرابط والنموذج والصوت.', variant: 'destructive' });
      return;
    }

    chainAbortRef.current?.abort();
    segmentCacheRef.current.clear();
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

      if (audioRef.current && job.audioUrl) {
        isSyncingRef.current = true;
        ytPlayerRef.current?.seekTo(key, true);
        audioRef.current.src = job.audioUrl;
        audioRef.current.load();
        await new Promise(r => setTimeout(r, 600));
        audioRef.current.currentTime = 0;
        audioRef.current.play().catch(() => {});
        ytPlayerRef.current?.playVideo();
        activeSegmentKeyRef.current = key;
        lastTimeRef.current = key;
        setIsPlaying(true);
        setTimeout(() => { isSyncingRef.current = false; }, 800);
      }

      setPipelineVisible(true);
      const nextKey = key + SEGMENT_DURATION;
      startChain(nextKey, abortCtrl.signal);

    } catch {
      setShowOverlay(false);
      toast({ title: '❌ خطأ في الاتصال', variant: 'destructive' });
    }
  }, [isValid, selectedModel, selectedVoice, fetchSegment, startChain, toast]);

  const handleAudioEnded = useCallback(() => {
    const nextKey = activeSegmentKeyRef.current + SEGMENT_DURATION;
    playSegment(nextKey, false);
  }, [playSegment]);

  // Seek detection
  useEffect(() => {
    if (!hasStarted) return;
    const timer = setInterval(() => {
      if (!ytPlayerRef.current || !isPlaying) return;
      const time = ytPlayerRef.current.getCurrentTime();
      if (Math.abs(time - lastTimeRef.current) > 4 && !isSeekingRef.current) {
        isSeekingRef.current = true;
        const key = normalizeStart(time);
        const cached = segmentCacheRef.current.has(key);
        playSegment(time, !cached);

        chainAbortRef.current?.abort();
        const abortCtrl = new AbortController();
        chainAbortRef.current = abortCtrl;
        const nextKey = key + SEGMENT_DURATION;
        startChain(nextKey, abortCtrl.signal);

        setTimeout(() => { isSeekingRef.current = false; }, 1200);
      }
      lastTimeRef.current = time;
    }, 500);
    return () => clearInterval(timer);
  }, [hasStarted, isPlaying, playSegment, startChain]);

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

  const currentModelObj = modelsData?.models?.find(m => m.id === selectedModel);

  return (
    <div className="min-h-screen bg-background text-foreground relative overflow-hidden" dir="rtl">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-background via-background to-primary/5 pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-primary/5 blur-3xl rounded-full pointer-events-none" />

      <audio ref={audioRef} onEnded={handleAudioEnded} className="hidden" />

      {/* Full blocking overlay - first load only */}
      <ProcessingOverlay isVisible={showOverlay} progressText={overlayProgress} />

      {/* Persistent pipeline bar - background processing */}
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

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Model selector */}
                  <div className="space-y-2">
                    <label className="text-xs text-muted-foreground font-medium">مزود الصوت (TTS)</label>
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

                  {/* Voice selector */}
                  <div className="space-y-2">
                    <label className="text-xs text-muted-foreground font-medium">الصوت</label>
                    <Select
                      value={selectedVoice}
                      onValueChange={setSelectedVoice}
                      disabled={isLoadingModels || showOverlay || !selectedModel}
                    >
                      <SelectTrigger className="bg-background/50 border-border/50">
                        <SelectValue placeholder="اختر الصوت..." />
                      </SelectTrigger>
                      <SelectContent>
                        {currentModelObj?.voices.map(v => (
                          <SelectItem key={v.id} value={v.id}>
                            <span>{v.name}</span>
                            <span className="text-muted-foreground text-xs mr-2">({v.gender})</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Speed slider */}
                <div className="mt-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-muted-foreground font-medium">سرعة الصوت</label>
                    <span className="text-xs font-mono text-primary">{speed.toFixed(1)}x</span>
                  </div>
                  <Slider
                    min={0.5}
                    max={2.0}
                    step={0.1}
                    value={[speed]}
                    onValueChange={([v]) => setSpeed(v)}
                    disabled={showOverlay}
                    className="cursor-pointer"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>0.5x</span>
                    <span>1.0x (طبيعي)</span>
                    <span>2.0x</span>
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
