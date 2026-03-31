import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, AudioLines, Sparkles, Languages, Mic } from 'lucide-react';

interface ProcessingOverlayProps {
  isVisible: boolean;
  progressText?: string;
}

export function ProcessingOverlay({ isVisible, progressText = "جاري التجهيز..." }: ProcessingOverlayProps) {
  const getIcon = () => {
    if (progressText.includes('صوت')) return <AudioLines className="w-12 h-12 text-primary" />;
    if (progressText.includes('ترجمة') || progressText.includes('نص')) return <Languages className="w-12 h-12 text-primary" />;
    if (progressText.includes('توليد') || progressText.includes('عربي')) return <Mic className="w-12 h-12 text-primary" />;
    return <Loader2 className="w-12 h-12 text-primary animate-spin" />;
  };

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 backdrop-blur-sm"
        >
          {/* Background glowing orb */}
          <div className="absolute w-64 h-64 rounded-full bg-primary/10 blur-3xl animate-pulse" />

          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="relative flex flex-col items-center gap-6 text-center px-8"
          >
            <motion.div
              animate={{ scale: [1, 1.1, 1] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            >
              {getIcon()}
            </motion.div>

            <h2 className="text-2xl font-bold text-white">⏳ جاري المعالجة...</h2>

            <p className="text-lg text-primary font-medium">{progressText}</p>

            <p className="text-sm text-white/50 max-w-xs">
              يرجى الانتظار، لا يمكن التفاعل مع الصفحة حتى تكتمل معالجة المقطع المختار.
            </p>

            {/* Progress dots */}
            <div className="flex gap-2">
              {[0, 1, 2].map(i => (
                <motion.div
                  key={i}
                  className="w-2 h-2 rounded-full bg-primary"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.4 }}
                />
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
