# Security policy

## Reporting a vulnerability

Please report security vulnerabilities privately through GitHub's private
vulnerability reporting for this repository (Security tab -> Report a
vulnerability). Do not open a public issue for a security problem.

Include what you found, how to reproduce it, the `rushes version` output, and
your macOS version. We aim to respond within a week.

## Scope

- The Rushes desktop app, the `rushcore-engine` engine and the `rushes` CLI.
- The self-host single-user share Worker in `worker/`.
- The static share viewer in `viewer/`.
- The shared browser recorder/client in `browser/`, including local drafts,
  exports and its client-side HTTP/authentication handling.

Out of scope: the future hosted multi-tenant cloud service (separate
repository and program), and issues in dependencies that do not affect Rushes.

## Privacy stance

The desktop app is local-first. Its recordings, transcripts and settings stay on your Mac.
The app makes no network requests except share uploads you configure yourself
and model assets Apple delivers for local transcription. Secrets live in the
Keychain. See `docs/PLAN.md` (privacy and security) for the rules the code
follows.


The experimental browser client stores local recordings in that browser profile's
origin-private file system. Browser/device permissions are requested through
explicit recording actions. On load the browser client automatically requests configuration and session
status from the configured service. Recording uploads and billing actions require
explicit user actions. The service implementation is not in this repository. Public CI uses generated inputs and must never upload real
camera, microphone, screen footage, credentials or browser profiles.
