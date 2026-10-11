# Protected composed camera output

Composed exports, thumbnails and new shares read one immutable recording policy snapshot. An absent policy disables blur for that historical take; later global defaults cannot change it. Malformed policies fail the operation. The policy schema and bounded radius come from ProductionEffectsPolicy.

With blur enabled, CameraBlurDerivedSource decodes the raw camera and normalizes its stored orientation. CameraBlurExportWorker runs off the capture callback and returns protected processed or no-person frames; a failure cancels the derived writer and the requested export. No raw-camera fallback enters this writer. Its H.264 MOV preserves the source sample timestamps and duration, then replaces only the camera input in the composition. Raw screen/camera/audio masters remain untouched.

The derived cache lives strictly inside canonical renders/camera_blur. Its identity contains the policy and a streaming source-master SHA256. The final render cache contains the immutable policy and the SHA256 of the actual derived video bytes. Stamp and media containment are revalidated at install; a modified derived file is refused. Every video hash streams bounded1MiB chunks rather than loading whole recordings. Partial files and writer sidecars are cleaned only under their owned prefix.

Editor-tracks remains the PLAN's explicit raw-master clone handoff. Audio-only has no camera input. Late share enrichment reuses the exact already-published video and poster, projecting new transcript metadata through the frozen edit; it cannot silently rerender under a newer policy.

Synthetic tests decode actual encoded checker-pattern footage and compare image detail before/after blur, verify repeat-cache identity, composition thumbnails and share outputs, unchanged master hashes, frozen late share media, orientation and full60-frame derived decode, processor failures without output fallback, malformed policy refusal and escaping managed-directory negative control. They do not open a camera or make remote uploads.
