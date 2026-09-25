export type MediaKind = "youtube" | "hls" | "dash" | "direct" | "unknown";

export interface MediaProbe {
  kind: MediaKind;
  contentType: string | null;
  finalUrl: string;
  needsTranscode?: boolean;
}

export function getYoutubeVideoId(value: string): string | null {
  if (!value) return null;
  const match = value.match(
    /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([^&?\n]+)/
  );
  return match?.[1] ?? null;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function detectMediaKind(value: string): MediaKind {
  const youtubeId = getYoutubeVideoId(value);
  if (youtubeId) return "youtube";
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    if (pathname.endsWith(".m3u8")) return "hls";
    if (pathname.endsWith(".mpd")) return "dash";
    if (/\.(mp4|m4v|webm|ogg|ogv|mov|mkv|avi|flv|ts|m2ts)$/i.test(pathname)) {
      return "direct";
    }
  } catch {
    // The input is not a valid URL.
  }
  return "unknown";
}

export function nativeVideoType(file: File): boolean {
  if (file.type.startsWith("video/")) {
    return /mp4|webm|ogg|quicktime|x-m4v/i.test(file.type);
  }
  return /\.(mp4|m4v|webm|ogg|ogv)$/i.test(file.name);
}