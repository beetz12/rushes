type ManifestHealth = {
  status?: string;
  verified?: { ok?: boolean } | null;
  warnings?: { code?: string; message?: string }[];
};
export type MediaCheck = { status?: string; error?: { code?: string } | null };

/** A saved file and a successful decode are separate outcomes. Summary/AI jobs
 * deliberately have no input here: their failures cannot invalidate footage. */
export function recordingHealth(manifest: ManifestHealth, check?: MediaCheck | null): string {
  const failed =
    manifest.status === 'failed' ||
    manifest.warnings?.some(
      (warning) =>
        warning.code === 'ended-early' &&
        /^(stream-error|writer-failed)/.test(warning.message ?? ''),
    );
  if (failed) return 'Saved with issues · originals kept';
  if (
    manifest.verified?.ok === false ||
    (check?.status === 'failed' && check.error?.code !== 'finalization-pending')
  )
    return 'Media check found issues · originals kept';
  if (manifest.verified?.ok === true) return 'Verified';
  if (!['complete', 'recovered'].includes(manifest.status ?? ''))
    return manifest.status ?? 'Not yet saved';
  if (check?.error?.code === 'finalization-pending') return 'Saved · waiting for files to finish';
  if (['queued', 'running'].includes(check?.status ?? '')) return 'Saved · checking media';
  return 'Saved · not yet verified';
}

export function libraryRecordingStatus(status: string): string {
  if (status === 'complete') return 'Saved';
  if (status === 'recovered') return 'Recovered';
  if (status === 'failed') return 'Needs attention · originals kept';
  return status;
}
