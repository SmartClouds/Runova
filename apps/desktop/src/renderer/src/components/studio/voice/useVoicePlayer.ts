import { useCallback, useEffect, useRef, useState } from 'react';

export interface VoicePlayer {
  /** The key of what is playing, or null. */
  playing: string | null;
  /**
   * Plays a file's address or sound held in memory, stopping whatever played before. Rejects when
   * the sound cannot play; stopping it before it starts is not a failure.
   */
  play: (key: string, source: string | Blob) => Promise<void>;
  stop: () => void;
}

/**
 * One sound at a time for the voice panel: a scene's narration or a voice sample. Each is known by
 * a key, so its button can offer Stop while it plays, and starting another stops it.
 */
export function useVoicePlayer(): VoicePlayer {
  const audio = useRef<HTMLAudioElement | null>(null);
  const ownedUrl = useRef<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  const stop = useCallback(() => {
    const current = audio.current;
    audio.current = null;
    current?.pause();
    if (ownedUrl.current) URL.revokeObjectURL(ownedUrl.current);
    ownedUrl.current = null;
    setPlaying(null);
  }, []);

  const play = useCallback(
    async (key: string, source: string | Blob) => {
      stop();
      const src = typeof source === 'string' ? source : URL.createObjectURL(source);
      if (typeof source !== 'string') ownedUrl.current = src;
      const element = new Audio(src);
      audio.current = element;
      element.addEventListener('ended', () => {
        if (audio.current === element) stop();
      });
      setPlaying(key);
      try {
        await element.play();
      } catch (error) {
        // Stopped, or replaced by another sound, before it started.
        if (audio.current !== element) return;
        stop();
        throw error;
      }
    },
    [stop],
  );

  useEffect(() => stop, [stop]);

  return { playing, play, stop };
}
