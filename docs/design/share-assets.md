# Review geometry and edited share assets

This is original integration code based on this repository's plan and public module contracts. No reference clone is opened or copied.

A new edit inherits a recording's normalized bubble centre, visibility and optional size fraction. The persisted point sizes are not fractions. Older metadata without a fraction keeps the editor's size default unless a stored screen point-to-pixel scale permits an exact conversion. Existing saved edits, drafts and in-memory changes remain authoritative.

Share assets freeze one validated edit snapshot. The native share exporter and the composition thumbnail use that snapshot. A generation directory inside canonical renders/shared_assets holds video, poster and optional edited transcript/captions; no source-time subtitle file is exposed as the share asset. Every managed directory and file uses the existing canonical containment helpers. Files are staged, then the complete generation is renamed into place. Content identity includes the native render identity and projected metadata, so later transcript enrichment creates its own generation while reusing the cached video.

For each kept clip in output order, a source word is retained when its midpoint belongs to that clip. Its time interval is clipped to the clip boundaries and scaled into output time. Repeated source ranges produce distinct word identifiers. Cues are rebuilt per clip, preventing captions from carrying across a removed interval. Source words and media files are never changed.

Chapters describe source sections. Each retained part of a section is projected onto the edited timeline. A trim into a section carries its title to output zero; reordering carries the active title to each new clip. Adjacent identical titles are collapsed. Cut-only sections disappear. All derived timestamps are bounded by edited duration.

The desktop reserves the public link before requesting these local assets and later uploads only the returned projected files. This facade has no network or provider access. Tests generate and decode actual synthetic video/poster media, inspect word and chapter timestamps under trim/speed/reorder, verify raw SHA preservation and reject escaping managed-directory links.
