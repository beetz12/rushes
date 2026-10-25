# Mac recording and web delivery release checks

Current scope,2026-10-24: native Mac recording; web sharing, playback, library and
billing. Browser recording and native Windows recording are deferred. Retain
original camera/screen/audio files and the compact Mac recorder. The web entry
must initialize neither capture devices nor browser recording storage.

The public tree owns the recorder, desktop shell, client SDK, viewer, personal
self-hosted service and their CI. The commercial backend and provider credentials
remain private. Private backend checks run locally; private Actions are disabled.
Generated fixtures may be CI artifacts. Personal recordings, credentials and
backend implementation may not be public artifacts.

## Source and local qualification

- `bash scripts/check-mac-web.sh`: native, shell, client, viewer, personal Worker,
  shipped web, notices, clean-room and verifier checks. The original
  `scripts/check.sh` remains the full deferred-recorder diagnostic gate.
- `npm --prefix browser run test:web`: explicit test partition plus all shared
  account/library/share/billing regressions. Test files added without a scope
  classification fail. The shipped HTML entry does not import the recorder.
- Public Mac/Windows Chrome and Mac WebKit viewing checks exercise generated
  H264 playback/seek and narrow/default/wide layouts, without capture permissions.
- Fresh exact-native-source process checks,12s then30-minute generated recording,
  Stop, decode and interruption recovery. Generated inputs do not prove physical
  camera/microphone acquisition or sensor synchronization.
- Brief authorized installed-app tests verify actual screen/window/area, camera
  and microphone inputs, separate originals, combined playback/export and cleanup.
  Preserve tested source, package and binary identities.

## Mac to cloud

A native account link requires explicit browser approval, PKCE/state and a
revocable credential held only by the Mac main process in encrypted storage.
Cancellation before its atomic save retires late responses. During that short
save the UI explicitly refuses cancellation; it never promises an unsafe disk
rollback. Changing account/provider retires old share mutations.

Native MP4 has its own ingest/media kind. Do not forge a browser WebM manifest.
Actual persisted bytes, full checksum, media timing and geometry authorize
publication. The server must preserve tenant isolation, idempotent resume,
retention, subscription and usage limits. Local structural tests are distinct
from genuine exported-media playback and authentic Google/R2/Stripe acceptance.
Stripe remains in test mode through qualification; payment redirects do not
grant entitlements. The optional cloud plan keeps its existing terms.

## Distribution

The current installer preparation targets Apple silicon/macOS26.4+. Produce a
DMG and ZIP from the same app/helper/native binaries. Development packages are
explicit and have updates disabled. They do not satisfy production signing.

Production requires DeveloperID, nested signatures, accepted notarization,
stapling and Gatekeeper checks on quarantined installed artifacts, followed by
an actual signed N-to-N+1 update with recordings/settings retained. Signed-payload
and digest checks, source/artifact identity, interrupted/bad update controls and
rollback acceptance remain mandatory.

The updater reserves native idle admission before installation; all engine start
paths must respect it. Only a confirmed live managed engine may be held. A failed
or unknown release cannot enable recording. Owner loss while held terminates
that same engine; normal GUI loss during a take retains its prior behavior.

Public update metadata and versioned installer files use a dedicated release
namespace, separate from tenant media and raw retention. Upload artifacts only
after actual signature checks and publish the metadata last. Source tests,
mocked feeds and a running process do not prove installed-update success.

A public release/default-branch change and cloud deployment remain explicit
final actions after the reviewed source and artifacts are concrete. Do not
label this release ready while its installed, provider or signing checks are
missing.
