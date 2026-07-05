import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Mic, Search, ChevronDown, X, Check, Volume2, Globe } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

interface Voice {
  id: string;
  name: string;
  gender: string;
  locale: string;
}

interface VoicePickerProps {
  voices: Voice[];
  selectedVoice: string;
  onSelect: (voiceId: string) => void;
  disabled?: boolean;
}

const LOCALE_LABELS: Record<string, string> = {
  'multilingual': '🌍 متعدد اللغات (يتحدث العربية)',
  'ar-SA': '🇸🇦 المملكة العربية السعودية',
  'ar-EG': '🇪🇬 مصر',
  'ar-AE': '🇦🇪 الإمارات',
  'ar-KW': '🇰🇼 الكويت',
  'ar-QA': '🇶🇦 قطر',
  'ar-BH': '🇧🇭 البحرين',
  'ar-IQ': '🇮🇶 العراق',
  'ar-JO': '🇯🇴 الأردن',
  'ar-LB': '🇱🇧 لبنان',
  'ar-MA': '🇲🇦 المغرب',
  'ar-TN': '🇹🇳 تونس',
  'ar-DZ': '🇩🇿 الجزائر',
  'ar-SY': '🇸🇾 سوريا',
  'ar-OM': '🇴🇲 عُمان',
  'ar-LY': '🇱🇾 ليبيا',
  'ar-YE': '🇾🇪 اليمن',
  'ar': '🌐 عربي',
  'en-US': '🇺🇸 English (American)',
  'en-AU': '🇦🇺 English (Australian)',
  'fr-FR': '🇫🇷 Français',
  'de-DE': '🇩🇪 Deutsch',
  'it-IT': '🇮🇹 Italiano',
  'ko-KR': '🇰🇷 한국어',
  'pt-BR': '🇧🇷 Português (Brasil)',
};

// Arabic locales first, then multilingual, then others
const LOCALE_ORDER = [
  'ar-SA','ar-EG','ar-AE','ar-KW','ar-QA','ar-BH','ar-IQ','ar-JO',
  'ar-LB','ar-MA','ar-TN','ar-DZ','ar-SY','ar-OM','ar-LY','ar-YE','ar',
  'multilingual',
  'en-US','en-AU','fr-FR','de-DE','it-IT','ko-KR','pt-BR',
];

export function VoicePicker({ voices, selectedVoice, onSelect, disabled }: VoicePickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [previewing, setPreviewing] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const selected = voices.find(v => v.id === selectedVoice);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return voices;
    return voices.filter(v =>
      v.name.toLowerCase().includes(q) ||
      v.locale.toLowerCase().includes(q) ||
      (LOCALE_LABELS[v.locale] || '').toLowerCase().includes(q)
    );
  }, [voices, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, Voice[]>();
    for (const v of filtered) {
      const loc = v.locale;
      const list = map.get(loc) ?? [];
      list.push(v);
      map.set(loc, list);
    }
    const sorted = Array.from(map.entries()).sort((a, b) => {
      const ai = LOCALE_ORDER.indexOf(a[0]);
      const bi = LOCALE_ORDER.indexOf(b[0]);
      const aOrder = ai === -1 ? 99 : ai;
      const bOrder = bi === -1 ? 99 : bi;
      return aOrder - bOrder || a[0].localeCompare(b[0]);
    });
    return sorted.map(([locale, list]) => ({
      locale,
      label: LOCALE_LABELS[locale] || locale,
      voices: list,
    }));
  }, [filtered]);

  const playPreview = async (e: React.MouseEvent, voiceId: string) => {
    e.stopPropagation();
    if (previewing === voiceId) {
      audioRef.current?.pause();
      setPreviewing(null);
      return;
    }
    setPreviewing(voiceId);
    try {
      const res = await fetch('/api/translate/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId }),
      });
      if (!res.ok) throw new Error('Preview failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (audioRef.current) {
        audioRef.current.pause();
        URL.revokeObjectURL(audioRef.current.src);
      }
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setPreviewing(null);
      audio.onerror = () => setPreviewing(null);
      await audio.play();
    } catch {
      setPreviewing(null);
    }
  };

  const handleSelect = (voiceId: string) => {
    onSelect(voiceId);
    setOpen(false);
    setSearch('');
    if (audioRef.current) { audioRef.current.pause(); }
    setPreviewing(null);
  };

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        URL.revokeObjectURL(audioRef.current.src);
      }
    };
  }, []);

  return (
    <>
      <Button
        variant="outline"
        className="w-full justify-between bg-background/50 border-border/50 h-10 px-3 text-sm"
        onClick={() => setOpen(true)}
        disabled={disabled}
        dir="rtl"
      >
        <span className="truncate">{selected ? selected.name : 'اختر الصوت...'}</span>
        <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0 mr-2" />
      </Button>

      <Dialog open={open} onOpenChange={v => { setOpen(v); if (!v) setSearch(''); }}>
        <DialogContent className="max-w-lg p-0 overflow-hidden border-border/50 bg-card/95 backdrop-blur" dir="rtl">
          <DialogHeader className="px-5 pt-5 pb-3 border-b border-border/30">
            <DialogTitle className="text-base flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-primary" />
              اختر الصوت
              <span className="text-xs text-muted-foreground font-normal mr-auto">
                {voices.length} صوت متاح
              </span>
            </DialogTitle>
          </DialogHeader>

          <div className="px-4 py-3 border-b border-border/20">
            <div className="relative">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="ابحث باسم الصوت أو اللغة أو الدولة..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pr-9 pl-8 h-9 text-sm bg-background/50 border-border/50"
                dir="rtl"
                autoFocus
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {search && (
              <p className="text-xs text-muted-foreground mt-1.5 pr-1">
                {filtered.length} نتيجة
              </p>
            )}
          </div>

          <ScrollArea className="h-[380px]">
            <div className="px-3 py-2 space-y-3">
              {grouped.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  لا توجد أصوات مطابقة
                </div>
              ) : (
                grouped.map(({ locale, label, voices: groupVoices }) => (
                  <div key={locale}>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-semibold mb-1 px-2 py-0.5">
                      <Globe className="w-3 h-3 shrink-0" />
                      <span>{label}</span>
                      <span className="opacity-50 font-normal">({groupVoices.length})</span>
                    </div>
                    <div className="space-y-0.5">
                      {groupVoices.map(v => {
                        const isSelected = selectedVoice === v.id;
                        const isBusy = previewing === v.id;
                        return (
                          <div
                            key={v.id}
                            className={
                              `group flex items-center gap-2 px-2 py-2 rounded-md cursor-pointer transition-colors select-none ` +
                              (isSelected ? 'bg-primary/15 text-primary' : 'hover:bg-muted/50')
                            }
                            onClick={() => handleSelect(v.id)}
                          >
                            {/* Selection indicator */}
                            <div className="shrink-0 w-4 flex items-center justify-center">
                              {isSelected
                                ? <Check className="w-4 h-4 text-primary" />
                                : <div className="w-3 h-3 rounded-full border-2 border-border/60" />
                              }
                            </div>

                            {/* Name */}
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-medium truncate block">{v.name}</span>
                            </div>

                            {/* Gender badge */}
                            <span className="text-[10px] text-muted-foreground shrink-0 px-1.5 py-0.5 rounded bg-muted/40">
                              {v.gender}
                            </span>

                            {/* Preview mic button */}
                            <Button
                              variant="ghost"
                              size="icon"
                              className={
                                `w-7 h-7 shrink-0 transition-all ` +
                                (isBusy
                                  ? 'opacity-100 bg-primary/20'
                                  : 'opacity-0 group-hover:opacity-100 focus:opacity-100')
                              }
                              onClick={e => playPreview(e, v.id)}
                              title="استمع للصوت قبل الاختيار"
                            >
                              <Mic className={`w-3.5 h-3.5 ${isBusy ? 'animate-pulse text-primary' : 'text-muted-foreground'}`} />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>

          {/* Footer hint */}
          <div className="px-4 py-2 border-t border-border/20 text-[11px] text-muted-foreground flex items-center gap-3">
            <span>اضغط على الاسم للاختيار</span>
            <span>•</span>
            <span className="flex items-center gap-1"><Mic className="w-3 h-3" /> للاستماع قبل الاختيار</span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
