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

Out of scope: the future hosted multi-tenant cloud service (separate
repository and program), and issues in dependencies that do not affect Rushes.

## Privacy stance

Rushes is local-first. Recordings, transcripts and settings stay on your Mac.
The app makes no network requests except share uploads you configure yourself
and model assets Apple delivers for local transcription. Secrets live in the
Keychain. See `docs/PLAN.md` (privacy and security) for the rules the code
follows.
