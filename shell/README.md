# Rushes desktop

Use Node 22.22.0 (`nvm use` in this directory). Build the Swift engine from the repository root before starting: `swift build`. Then `npm ci`, `npm run build`, and `npm start`.

The shell starts `../.build/debug/rushcore-engine` in development. Set `RUSHES_ENGINE_PATH` to another real engine binary when integrating modules. Packaged builds always use `Rushes.app/Contents/Resources/bin/rushcore-engine`. `RUSHES_DATA_DIR` and `RUSHES_RECORDINGS_ROOT` can isolate QA from personal recordings.

`npm test` exercises real UNIX socket framing, response correlation, error propagation, IPC validation, bounded video ranges and media path authorization. `npm run smoke` launches actual Electron, pings the engine, checks renderer isolation, and exits. A default smoke test does not record. Opting into `RUSHES_SMOKE_RECORD_STUB=1` together with `RUSHES_TEST_ENGINE_STUB=1` tests a synthetic recording UI cycle; it never uses live capture. `RUSHES_SMOKE_REVIEW_ID` opens an existing package for read-only playback QA and mutes playback in the test. Set `RUSHES_SMOKE_SCREENSHOT=/absolute/path.png` to capture the rendered UI. `RUSHES_TEST_ENGINE_STUB=1` is honored only by smoke mode and explicitly uses the engine test rig; production launch never enables it.

`npm run dev` serves the renderer for visual review. Start Electron with `RUSHES_DEV_URL=http://127.0.0.1:5173` for a functioning native bridge. A plain browser intentionally cannot record.

To package, first build root release engine/CLI and cloud/viewer modules, then `npm run package`. electron-builder embeds the engine, CLI, cloud SDK, viewer assets, and license acknowledgements. Set `CSC_NAME` or `RUSHES_SIGN_IDENTITY` to a stable Apple Development identity when signing local development builds; unsigned builds are not a fresh-account permission proof. Public notarization is a separate release operation.

Recordings remain under `~/Movies/Rushes`. The main process alone owns engine startup, dialogs, credentials and file access. Renderer capture APIs and raw filesystem access are unavailable. Credentials are encrypted through Electron safeStorage backed by macOS Keychain. Share requests fail with a clear configure error until a real provider is configured. Test the connection in Settings before publishing.

Recorder hotkeys: Shift–Command–R starts/stops, Shift–Command–P pauses/resumes, Shift–Command–Escape requests discard with confirmation. The area selection window and camera preview stay excluded from capture through native engine source filtering and protected Electron panels.

Automatic sharing is off by default. Enable it in Settings to reserve and copy a processing link after the native stopped event while rendering/upload continue in the background. Failures keep the local recording and offer a manual Copy share link retry. This option creates public links; Review lets Worker users set a password and expiry before creating a link, or change/remove them on an existing stable link. Passwords are transient requests, never saved in shell preferences/share state. Bucket providers explicitly reject access policy and feedback operations.

Worker feedback in Review shows play counts, reactions and timestamped comments. Copy a comment's timestamp link to open the published video at that point. Five-minute polling baselines existing views silently, notifies only increased play counts, preserves the last count through failed requests, guards provider/configuration identity, and stops after successful Quit. The private share socket has explicit closed routes for status, policy and feedback; `share.status` only reads state.

Open in editor exports raw originals and reveals them in Finder unless an editor command is saved in Settings. The command supports `{screen}`, `{camera}`, `{mic}`, `{system}`, `{package}` and `{cameraOffsetMs}`. Quotes group arguments, then placeholders expand within each argument; shell expressions remain literal. Missing original tracks fail clearly. The action never changes the masters.
