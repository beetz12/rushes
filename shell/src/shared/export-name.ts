/**
 * The file name the export save dialog suggests: the recording's title plus
 * its date, so exports are recognisable in Finder instead of an internal id.
 */
export function suggestedExportName(
  title: string | undefined,
  createdAt: string | undefined,
  extension: string,
): string {
  const cleaned = (title ?? '')
    // Characters Finder or other apps reject in names, plus control characters.
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 100)
    .trim();
  const base =
    cleaned && cleaned.toLowerCase() !== 'untitled recording' ? cleaned : 'Rushes recording';
  const date = createdAt && /^\d{4}-\d{2}-\d{2}/.test(createdAt) ? createdAt.slice(0, 10) : '';
  const stem = date && !base.includes(date) ? `${base} ${date}` : base;
  return `${stem}.${extension}`;
}
