# Review and share integration checkpoint

Implemented original manifest bubble geometry seeding for new edits (centre, visibility, optional size fraction; legacy point sizes are never mistaken for fractions). Existing drafts and saved edits remain authoritative. Export and thumbnail can freeze an edit snapshot. The native share.assets facade returns canonical generation paths under renders/shared_assets, exact composition poster JPG, and transcript/VTT/chapters projected through kept ranges, speed and reorder. Cut words are dropped by midpoint; replayed clips have distinct IDs. Optional path keys are omitted until transcript exists. Video and transcript/master sources remain unchanged.

Focused 19 export/edit/share tests passed with generated and decoded synthetic media. New share tests inspect 800ms reordered/speed output, word/cue/chapter clocks, generated poster dimensions, source SHA preservation, reuse/enrichment, bubble geometry and canonical shared-assets containment. Native audio composition now allocates a contiguous track per clip after the new reordering fixture reproduced a blocked reader on a single backwards-seeking compressed track; the same fixture completes with spectral pitch preservation retained.

First unfinished step: finish declared full gate, confirm strengthened decoded-audio assertion, then commit this bounded integration helper. No live capture, remote sharing or SaaS account work occurred here.

## Reviewable checkpoint

The minimal final implementation passed 20 focused tests in 3 suites, including simultaneous edited share preparation and decoded audio on both outputs. Explicit changed-Swift/design clean checker returned 0; git diff whitespace check passed. The original audio pump remains unchanged. Experimental admission and dedicated-reader changes were removed because they did not explain the full-gate stall.

Three unfiltered full-gate attempts were interrupted with their actual exit 143 after the shared CLI integration helper stalled; none is reported green. Root identified `launchOnDemand` waiting for child exit before draining its pipe (the current source has this ordering at CLIIntegrationTests.swift213–216). Root is supplying the exact helper fix; all subsequent full gates will be serialized. The gate did not reach the JavaScript or notices stages during these attempts. Evidence logs and the owned native-reader sample are preserved for comparison.

First unfinished step: apply root's supplied exact test-helper fix and rerun the declared full gate as directed; root also owns assembled share-provider and live app validation. This checkpoint performs no remote upload or live recording.
