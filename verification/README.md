# Independent process contracts

These checks drive the actual released Swift engine and CLI in owned roots,
with `--capture-stub`. They do not use real capture devices or the user library.
The Swift media probe decodes every sample through AVAssetReader independently
of RushCore's package verifier. The normal take is a positive control; corrupt
media is a negative control for the independent decoder and app verifier.

Run from the repository after `swift build -c release`:

```
python3 verification/process_contracts.py --evidence-dir /absolute/new/evidence/directory
```

Use a new evidence directory for each pass. Each actual process exit, command,
socket request/reply, fixture and engine error is preserved. `report.json`
records the tested commit, individual verified/failed contracts and untested
surfaces. Exit 1 means a behavior contract failed. Build/compiler failures are
saved separately in `probe-build.json` and `harness-error.txt`.

The baseline run at commit `c0eaa5b` observed the oversized-duration engine
crash, a zero exit for corrupt-media verification, successful verification of a
failed take with no present media, successful reading of `../outside.mov`,
ignored wrong-type duration, and input time that retained paused wall time.
These are regression contracts, not maker implementation suggestions. Capture,
UI, exports, external hosting and macOS permissions require separate real
checks; synthetic success does not establish their readiness.
