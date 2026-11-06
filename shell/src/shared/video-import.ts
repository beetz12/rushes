// Importing downloaded videos (for example Loom MP4s) into the library.
// The engine does the copying; this file decides what to send and how to
// report it, so the logic is testable without Electron.

export const importExtensions = ['mp4', 'mov', 'm4v'] as const;

export function isImportableVideo(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot < path.lastIndexOf('/')) return false;
  return (importExtensions as readonly string[]).includes(path.slice(dot + 1).toLowerCase());
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

export interface ImportProgress {
  index: number; // 1-based position of the file being copied
  total: number;
  name: string;
}

export interface ImportOutcome {
  imported: { id: string; title: string }[];
  failed: { name: string; message: string }[];
  skipped: string[]; // names that are not .mp4, .mov or .m4v
}

type ImportOne = (path: string) => Promise<any>;

/// Imports one file at a time: each copy streams a whole video through the
/// disk. The engine refuses an import while a recording is running; it does
/// not stop a recording from starting during an import.
export async function importVideos(
  paths: string[],
  importOne: ImportOne,
  onProgress?: (progress: ImportProgress) => void,
): Promise<ImportOutcome> {
  const unique = [...new Set(paths.filter((path) => path.length > 0))];
  const accepted = unique.filter(isImportableVideo);
  const outcome: ImportOutcome = {
    imported: [],
    failed: [],
    skipped: unique.filter((path) => !isImportableVideo(path)).map(fileName),
  };
  for (const [position, path] of accepted.entries()) {
    const name = fileName(path);
    onProgress?.({ index: position + 1, total: accepted.length, name });
    try {
      const result = await importOne(path);
      outcome.imported.push({ id: String(result?.id ?? ''), title: String(result?.title ?? name) });
    } catch (error) {
      outcome.failed.push({ name, message: (error as Error)?.message ?? String(error) });
    }
  }
  return outcome;
}

export function progressText(progress: ImportProgress): string {
  return progress.total > 1
    ? `Importing ${progress.index} of ${progress.total}: ${progress.name}…`
    : `Importing ${progress.name}…`;
}

/// One line for the app's note bar; failures name the file and the reason.
export function importSummary(outcome: ImportOutcome): string {
  const parts: string[] = [];
  const count = outcome.imported.length;
  if (count === 1) parts.push(`Imported “${outcome.imported[0].title}”. Transcript and captions are on the way.`);
  else if (count > 1) parts.push(`Imported ${count} videos. Transcripts and captions are on the way.`);
  for (const failure of outcome.failed) parts.push(`${failure.name}: ${failure.message}`);
  if (outcome.skipped.length)
    parts.push(`Skipped ${outcome.skipped.join(', ')}: Rushes imports .mp4, .mov and .m4v files.`);
  return parts.join(' ') || 'No videos were imported.';
}
