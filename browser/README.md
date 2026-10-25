# Rushes web library and sharing

The shipped web app opens the private library and supports account management,
playback, downloads, explicit share links and billing. Record in the Mac app,
then use its Share action. The web app requests no screen, camera or microphone
access. Browser recording is deferred on every platform.

Use the pinned Node22.22.0 runtime from `.nvmrc`:

```sh
npm --prefix browser ci
npm --prefix browser run build
npm --prefix browser run dev
npm --prefix browser run test:web
```

The local development server proxies `/api` and `/auth` to the separately running
service on127.0.0.1:8787. Without that configured service, cloud actions remain
unavailable. The commercial backend, Google credentials, tenant database and
Stripe integration live in a separate private repository; none is provisioned by
building this public client.

The web viewing tests use owned generated H264 media over a real local HTTP
server. Chrome tests can use the exact binary printed by
`node scripts/install-test-chrome.mjs --generation current --destination /absolute/path`
through `RUSHES_CHROME`. `RUSHES_TEST_BROWSER=webkit` checks Mac WebKit. These are
local checks; authenticated cloud and payment acceptance require separate proof.

`test:web` classifies every test file and retains the existing account, library,
sharing and billing regressions. The legacy full command remains `npm test`.
Deferred recording diagnostics are explicitly named
`npm --prefix browser run test:deferred-recorder`; their failures remain unresolved
and do not count as Mac/web qualification. No recorder diagnostic runs in the
shipped entry. Historical instructions are in `docs/deferred-recording.md`.

Old browser drafts are retained. `/local-drafts` offers an explicit download-only
recovery view; use the same original browser profile and origin. Reading that
page neither starts recording nor uploads its saved bytes. Changing browser or
clearing its site data cannot transfer those drafts.

See `../docs/verification/mac-web-release.md` for the release gates and current
scope. A passing client test suite is not a public-launch claim.
