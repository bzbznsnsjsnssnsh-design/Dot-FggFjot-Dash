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
  'ar-SA': 'عربي — سعودي',
  'ar-EG': 'عربي — مصري',
  'ar-AE': 'عربي — إماراتي',
  'ar': 'عربي',
  'en-US': 'English — American',
  'fr-FR': 'Français',
  'de-DE': 'Deutsch',
  'zh-CN': '中文',
  'pt-BR': 'Português — Brasil',
};

const LOCALE_ORDER = ['ar-SA', 'ar-EG', 'ar-AE', 'ar', 'en-US', 'fr-FR', 'de-DE', 'zh-CN', 'pt-BR'];

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
    // Sort by LOCALE_ORDER then alphabetically
    const sorted = Array.from(map.entries()).sort((a, b) => {
      const ai = LOCALE_ORDER.indexOf(a[0]);
      const bi = LOCALE_ORDER.indexOf(b[0]);
      const order = (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return order || a[0].localeCompare(b[0]);
    });
    return sorted.map(([locale, list]) => ({
      locale,
      label: LOCALE_LABELS[locale] || locale,
      voices: list,
    }));
  }, [filtered]);

  const playPreview = async (voiceId: string) => {
    if (previewing === voiceId) return;
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
      >
        <span className="truncate">{selected ? selected.name : 'اختر الصوت...'}</span>
        <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg p-0 overflow-hidden border-border/50 bg-card/95 backdrop-blur" dir="rtl">
          <DialogHeader className="px-5 pt-5 pb-2">
            <DialogTitle className="text-base flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-primary" />
              اختر الصوت
            </DialogTitle>
          </DialogHeader>

          <div className="px-5 pb-2">
            <div className="relative">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="البحث باسم الصوت أو اللغة..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pr-10 pl-3 h-9 text-sm bg-background/50 border-border/50"
                dir="rtl"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          <ScrollArea className="h-[340px] px-5 pb-5">
            {grouped.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">
                لا توجد أصوات مطابقة للبحث
              </div>
            ) : (
              <div className="space-y-4">
                {grouped.map(({ locale, label, voices: groupVoices }) => (
                  <div key={locale}>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-semibold mb-1.5 pr-1">
                      <Globe className="w-3 h-3" />
                      <span>{label}</span>
                      <span className="text-[10px] font-normal opacity-60">({groupVoices.length})</span>
                    </div>
                    <div className="space-y-0.5">
                      {groupVoices.map(v => (
                        <div
                          key={v.id}
                          className={
                            `group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer transition-colors ` +
                            (selectedVoice === v.id
                              ? 'bg-primary/15 text-primary'
                              : 'hover:bg-muted/60')
                          }
                          onClick={() => handleSelect(v.id)}
                        >
                          <div className="shrink-0 w-4 h-4 flex items-center justify-center">
                            {selectedVoice === v.id ? (
                              <Check className="w-4 h-4 text-primary" />
                            ) : (
                              <div className="w-4 h-4 rounded-full border-2 border-border" />
                            )}
                          </div>

                          <div className="flex-1 min-w-0 flex items-center gap-2">
                            <span className="truncate font-medium">{v.name}</span>
                            <span className="text-[11px] text-muted-foreground shrink-0">({v.gender})</span>
                          </div>

                          <Button
                            variant="ghost"
                            size="icon"
                            className="w-7 h-7 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                            onClick={e => { e.stopPropagation(); playPreview(v.id); }}
                            disabled={previewing === v.id}
                          >
                            <Mic className={`w-3.5 h-3.5 ${previewing === v.id ? 'animate-pulse text-primary' : 'text-muted-foreground'}`} />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}
