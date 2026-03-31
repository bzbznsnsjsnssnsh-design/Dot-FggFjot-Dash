import { useState, useMemo } from 'react';

export function useYoutubeUrl() {
  const [url, setUrl] = useState('');

  const videoId = useMemo(() => {
    if (!url) return null;
    const match = url.match(
      /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([^&?\n]+)/
    );
    return match ? match[1] : null;
  }, [url]);

  return {
    url,
    setUrl,
    videoId,
    isValid: !!videoId
  };
}
