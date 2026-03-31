import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AudioLines, Languages, Mic, Download, Sparkles, CheckCircle2 } from 'lucide-react';

interface PipelineBarProps {
  isVisible: boolean;
  progressText: string;
  segmentLabel: string;
  done: boolean;
}

function textToPercent(text: string): number {
  if (!text) return 5;
  if (text.includes('تنزيل') || text.includes('استخراج') || text.includes('تجهيز')) return 20;
  if (text.includes('تنقية') || text.includes('تنظيف') || text.includes('صوت')) return 42;
  if (text.includes('نص') || text.includes('Whisper') || text.includes('تحويل')) return 62;
  if (text.includes('ترجمة') || text.includes('GPT')) return 80;
  if (text.includes('توليد') || text.includes('عربي') || text.includes('TTS') || text.includes('Edge') || text.includes('Google')) return 92;
  if (text.includes('اكتمل') || text.includes('✅')) return 100;
  return 10;
}

function getIcon(text: string) {
  if (text.includes('نص') || text.includes('تحويل')) return <Mic className="w-4 h-4" />;
  if (text.includes('ترجمة')) return <Languages className="w-4 h-4" />;
  if (text.includes('توليد') || text.includes('TTS')) return <AudioLines className="w-4 h-4" />;
  if (text.includes('تنزيل') || text.includes('استخراج')) return <Download className="w-4 h-4" />;
  if (text.includes('اكتمل') || text.includes('✅')) return <CheckCircle2 className="w-4 h-4" />;
  return <Sparkles className="w-4 h-4" />;
}

export function PipelineBar({ isVisible, progressText, segmentLabel, done }: PipelineBarProps) {
  const [displayPercent, setDisplayPercent] = useState(0);
  const targetPercent = done ? 100 : textToPercent(progressText);

  useEffect(() => {
    if (!isVisible) { setDisplayPercent(0); return; }
    const diff = targetPercent - displayPercent;
    if (Math.abs(diff) < 1) return;
    const step = diff > 0 ? Math.max(1, diff * 0.15) : diff;
    const t = setTimeout(() => setDisplayPercent(p => Math.min(100, Math.max(0, p + step))), 60);
    return () => clearTimeout(t);
  }, [targetPercent, displayPercent, isVisible]);

  useEffect(() => {
    if (isVisible && !done) setDisplayPercent(2);
  }, [segmentLabel]);

  const steps = [
    { label: 'استخراج الصوت', threshold: 20 },
    { label: 'تنقية الصوت', threshold: 42 },
    { label: 'تحويل لنص', threshold: 62 },
    { label: 'ترجمة', threshold: 80 },
    { label: 'توليد صوت', threshold: 92 },
    { label: 'جاهز!', threshold: 100 },
  ];

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          className="fixed bottom-4 left-4 right-4 md:left-auto md:right-6 md:w-[420px] z-40"
        >
          <div className="bg-black/80 backdrop-blur-md border border-white/10 rounded-2xl p-4 shadow-2xl">
            {/* Header row */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-primary text-sm font-medium">
                {getIcon(progressText)}
                <span>معالجة الخلفية</span>
                {segmentLabel && (
                  <span className="text-xs text-white/40 font-mono">{segmentLabel}</span>
                )}
              </div>
              <span className="text-xs text-white/50 font-mono tabular-nums">
                {Math.round(displayPercent)}%
              </span>
            </div>

            {/* Main progress bar */}
            <div className="relative h-2 bg-white/10 rounded-full overflow-hidden mb-3">
              {/* Glow shimmer */}
              <motion.div
                className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent"
                animate={{ x: ["-100%", "200%"] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
              />
              {/* Fill */}
              <motion.div
                className="absolute left-0 top-0 h-full bg-gradient-to-r from-primary to-emerald-400 rounded-full"
                animate={{ width: `${displayPercent}%` }}
                transition={{ duration: 0.3, ease: "easeOut" }}
              />
            </div>

            {/* Step dots */}
            <div className="flex items-center justify-between mb-2">
              {steps.map((step, i) => {
                const active = displayPercent >= step.threshold;
                const current = !active && (i === 0 || displayPercent >= steps[i - 1].threshold);
                return (
                  <div key={i} className="flex flex-col items-center gap-1">
                    <div
                      className={`w-2 h-2 rounded-full transition-all duration-300 ${
                        active ? 'bg-primary scale-125' :
                        current ? 'bg-primary/50 animate-pulse' :
                        'bg-white/20'
                      }`}
                    />
                    <span className={`text-[9px] hidden md:block transition-colors duration-300 ${active ? 'text-primary' : 'text-white/30'}`}>
                      {step.label}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Current step text */}
            <p className="text-xs text-white/60 text-right">
              {done ? '✅ اكتمل المقطع، جاري تجهيز التالي...' : progressText || 'جاري المعالجة...'}
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
