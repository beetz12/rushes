# Packaging intent preflight

The old packaging entry point ignored distribution and notarization requests:
it always selected development signing and explicitly disabled notarization.
Two regressions execute that actual entry point with only its external builder
replaced. Missing Developer ID or missing notary credentials reached the builder
and returned successfully. Explicit development packaging is the positive control.

The entry point now validates signing intent before resource checks or builder
invocation. Distribution requires an explicit Developer ID Application identity,
distribution type, notarization enabled, macOS, and a complete authentication
method. The authentication precedence matches pinned builder26.15.3: Apple ID,
then API key, then Keychain profile. Partial earlier methods refuse fallback.
An explicitly supplied Apple team must match the selected certificate's team.
Production CI requires a manually dispatched CI event (workflow_dispatch), and
pull requests cannot sign. No automatic certificate import or credential action
is performed by preflight. This event check does not identify a particular workflow.

Accepted production configuration forces signing, hardened runtime and
notarization. The existing builder uses Apple's timestamp service by default;
this guard introduces no timestamp override. Development remains dir-only with
notarization disabled. The returned configuration contains no notary secrets.
Presence checks are not authentication or certificate-availability evidence.
Actual signatures, secure timestamps, helper/version/source linkage, accepted
notary logs, DMG/ZIP/feed and install/update acceptance are still required later.
This source correction performs no production build or release.

Pinned implementation inspected locally: app-builder-lib/out/macPackager.js,
mac/MacTargetHelper.js, codeSign/macCodeSign.js, and @electron/osx-sign's signer.
Official reference: https://www.electron.build/v26/docs/code-signing/macOS/
Context7 was unavailable due to its monthly quota; pinned source supplied the
actual skip behavior and supported environment names.

Entrypoint tests use generated access-only resource files in an owned temporary
working directory and neutralize inherited CI settings before each fixture. They
invoke the actual source entrypoint by absolute path; real release outputs are
not a test precondition. Explicit CI refusal controls remain separate.
