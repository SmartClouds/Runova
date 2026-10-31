import type { FileDiskChange } from '@shared/apiTypes';
import { useEffect, useRef } from 'react';

/**
 * Calls `onChange` whenever the file at `path` changes on disk (an agent rewrote it, another
 * editor saved it, it was deleted). Main watches the file only while some tab asks for it, so
 * this starts the watch on mount and lets go of it on unmount.
 */
export function useFileDiskChanges(path: string, onChange: (change: FileDiskChange) => void): void {
  // The latest callback, so a change sees the tab's current state without re-subscribing.
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    const off = window.runova.fs.onFileChanged((changed, change) => {
      if (changed === path) latest.current(change);
    });
    // A file the app may not watch (outside every project) just never reports a change.
    void window.runova.fs.watchFile(path).catch(() => undefined);
    return () => {
      off();
      void window.runova.fs.unwatchFile(path).catch(() => undefined);
    };
  }, [path]);
}
