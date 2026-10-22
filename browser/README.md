# Rushes shared browser recorder

This experimental client targets screen, camera and microphone recording in
current and previous pinned Chrome on Windows and Mac. Recordings and their separate original
tracks stay in the browser's local storage until you explicitly export or upload.
Browser permission prompts choose the screen and devices. No desktop install is
needed to develop or test this client.

Use Node22.22.0 declared in .nvmrc:

```sh
npm --prefix browser ci
npm --prefix browser run build
npm --prefix browser run dev
```

Open the local URL printed by Vite. Choose your sources, record, then review and
export the combined video or individual originals. Local drafts belong to this
browser profile; clearing its site data removes those drafts.

Run the shared tests with a pinned Chrome installed by
`node scripts/install-test-chrome.mjs --generation current --destination /absolute/path`.
The installer prints the actual runtime and exports both browser variables in
GitHub Actions. For local tests set RUSHES_CAPTURE_BROWSER_EXECUTABLE and
RUSHES_CHROME to the printed executable. FFmpeg and ffprobe are required for the
generated-media checks. Run `node scripts/check-browser-recorder.mjs`. The full
repository gate is `bash scripts/check.sh`.

This repository contains the shared recorder/client and generated-media checks.
The hosted multi-tenant service, account database, provider processing, billing
and provider seam tests remain in a separate private repository. Account/cloud
buttons require that configured service; local recording and export do not. No
backend provisioning, credentials or paid plan activation is part of this tree.

The public browser workflow tests pinned Chrome on standard Windows/Mac runners.
It retains source/runtime identities and generated diagnostics. A short result
does not establish ten-minute, physical-device or paid-cloud acceptance. Known
recording qualification gaps remain visible in CI; this is not a public launch.

CI keeps generated short recordings, source/runtime hashes, traces, logs and
independent supplied-reference PCM for one day. Encoded180s reference masters are
not uploaded by default. These compact diagnostics are not a substitute for the
full raw-media acceptance required before a production recording claim.
