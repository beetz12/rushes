// "Import video…" in the Library: a native file picker for downloaded videos
// (Loom MP4s and the like), plus dropping video files anywhere on the Library.
import React, { useEffect, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { fileName, importSummary, importVideos, progressText } from '../shared/video-import';
import { createNativeAPI } from './native-api';
import './library-import.css';

const api = window.rushes ? createNativeAPI(window.rushes) : undefined;

export function ImportVideosButton({
  reload,
  setNote,
}: {
  reload: () => Promise<void>;
  setNote: (note: string) => void;
}) {
  const [progress, setProgress] = useState<string | null>(null);
  const busy = useRef(false);
  const start = async (paths: string[], refused: string[] = []) => {
    if (!api || busy.current) return;
    if (!paths.length) {
      if (refused.length) setNote(importSummary({ imported: [], failed: [], skipped: refused }));
      return;
    }
    busy.current = true;
    try {
      const outcome = await importVideos(
        paths,
        (path) => api.importVideo(path),
        (p) => setProgress(progressText(p)),
      );
      outcome.skipped.push(...refused);
      setNote(importSummary(outcome));
      await reload();
    } finally {
      busy.current = false;
      setProgress(null);
    }
  };
  const latest = useRef(start);
  latest.current = start;
  useEffect(() => {
    const over = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      const dropped = [...event.dataTransfer.files];
      // The preload resolves the dropped File objects; main grants only real videos.
      void api
        ?.allowDroppedVideos(dropped)
        .then((granted) => {
          const names = new Set(granted.map(fileName));
          const refused = dropped.map((file) => file.name).filter((name) => !names.has(name));
          return latest.current(granted, refused);
        })
        .catch((error: Error) => setNote(error.message));
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);
  return (
    <button
      className="secondary library-import"
      disabled={progress !== null}
      title="Import .mp4, .mov or .m4v files, such as videos downloaded from Loom. You can also drop them here."
      onClick={() =>
        void api
          ?.chooseVideos()
          .then((paths) => start(paths))
          .catch((error: Error) => setNote(error.message))
      }
    >
      <FileUp size={20} />
      {progress ?? 'Import video…'}
    </button>
  );
}
