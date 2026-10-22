# Native helper build inputs

The automation helper is compiled in a fresh private scratch directory, with the
resolved dependency versions enforced. The binary output must remain inside that
directory. Metadata extraction receives that exact compiler root, so other build
configurations, architectures, old timestamps and unrelated module outputs cannot
choose its inputs. A whole-module or per-source input must be unique, belong to
the selected module/configuration, and remain inside the selected root. Ambiguity,
missing input and symlink escapes refuse packaging instead of selecting by mtime.

Embedding passes the containing app's short and build versions explicitly. A
standalone helper defaults to the project package version. Explicit empty values
are errors. Existing bundle identifiers, executable name, QA-only socket rules and
recording commands stay unchanged. The build and metadata tool do not launch the
helper, register Shortcuts, run an engine or acquire sensors.

Production mode requires release configuration, Developer ID and no QA socket.
The helper requests a secure timestamp and verifies its strict signature against
Apple's generic anchor, then requires the exact selected authority/team and one
timestamp in the returned description. Development signing remains explicitly
separate and may use an ad-hoc identity without a timestamp. These source checks
do not prove an available Developer ID key, notarization or installed discovery.

The source controls exercise isolated compiler selection, target/configuration
and architecture ambiguity, missing incremental inputs, symlinks, exact versions,
production/QA refusal, signature-description negatives, and actual entrypoint
refusal before invoking the compiler. Full SDK build/signature evidence and the
umbrella gate are separate requirements. The package entrypoint now awaits the
helper's `afterPack` integration before containing-app signing. Production
installer, notarization and update acceptance remain separate requirements.
