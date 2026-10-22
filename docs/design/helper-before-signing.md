# Prepare native automation before application signing

The package entrypoint registers an awaited `afterPack` hook with the pinned
builder. It adds the ARM64 automation helper to the fresh Rushes bundle before
builder sanity checks, Electron fuses and containing-app signing. The embedder
selects its own isolated Swift build inputs and inherits the app versions.

Development packaging may explicitly use ad-hoc signing. Distribution continues
to require the existing Developer ID/notarization preflight and passes production
intent to the embedder; the hook does not load credentials or publish artifacts.
Missing helper executable, property list or action metadata refuses the boundary.
Cancellation is checked before launch and again after all native work retires.

The native command owns a new POSIX session. Normal completion must have no
remaining build descendants. Cancellation, timeout or caller SIGINT/SIGTERM
retires every process group still in that session, escalating within fixed
budgets and requiring two empty snapshots. Output retains only its last64KiB.
A hard-killed caller or a descendant deliberately starting a new session is
outside this process proof; neither is presented as verified cleanup.

The entrypoint regression proves hook registration, five generated hook tests
prove orchestration, and six Node process tests exercise real generated child
lifetimes independently of Vitest. An actual SDK/build receipt must separately
show nested helper metadata and signatures before outer signing. These component
checks do not constitute a production installer, notarization or update acceptance.
