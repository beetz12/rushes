# Installing Rushes

Rushes runs on Apple silicon Macs with macOS 26.4 or later. Each release offers two downloads with the same app inside:

- `Rushes-<version>-arm64.dmg`: a disk image. Use this one.
- `Rushes-<version>-arm64.zip`: the same app in a zip archive.

## Install from the DMG

1. Open the downloaded `.dmg`.
2. Drag **Rushes** into **Applications**.
3. Eject the disk image, then open Rushes from Applications.
4. On first launch, allow Screen Recording, Camera and Microphone when macOS asks. You can change these later in System Settings > Privacy & Security.

From the zip: double-click it to unpack it, then move **Rushes.app** into Applications.

## Preview builds that are not notarized

Right now Rushes builds are not notarized. A file named `...-unsigned-preview.dmg` (or `.zip`) is signed ad hoc and has not been checked by Apple. A file named `...-dev-signed-not-notarized` is signed with a development certificate and is not notarized either. When you open either one, macOS blocks it the first time and says it cannot verify the app. To open it anyway:

1. Install Rushes into Applications as above and try to open it once. When macOS shows the warning, click **Done** (not **Move to Trash**).
2. Open **System Settings > Privacy & Security**.
3. Scroll down to **Security**. Next to the message that Rushes was blocked, click **Open Anyway**. The button appears for about an hour after the blocked attempt. If you do not see it, try to open Rushes again, then come back.
4. Confirm with **Open Anyway** again and enter your login password or use Touch ID.

macOS remembers this choice for that copy of the app. On current macOS, Control-clicking the app and choosing **Open** no longer skips this check. Use the steps above instead.

Only do this for a build you downloaded from the Rushes GitHub Releases page. Each release lists SHA-256 checksums in `SHA256SUMS.txt`. You can compare one with `shasum -a 256 <file>` in Terminal.

## Notarized builds (pending)

A notarized build opens without these steps. It needs an Apple Developer ID certificate and Apple notarization, and Rushes does not have a Developer ID yet. Until it does, every release is a preview build. Maintainers: the notarized lane of `.github/workflows/release.yml` fails on purpose unless the Developer ID and notarization secrets are configured, and `shell/scripts/package-signing.mjs` refuses production packaging without a Developer ID identity and `RUSHES_NOTARIZE=1`.

## Updates

Rushes tells you when a newer version is out. It does not download or install anything itself.

- About a minute after launch, and then once a day, Rushes asks GitHub (`api.github.com/repos/beetz12/rushes/releases`) for the latest published release. Draft releases are never offered. Prerelease builds are offered only if the copy you run is itself a preview build.
- When a newer version exists, you get one desktop notification per version: "Rushes X.Y.Z is available". Clicking it opens that release's page on github.com. The notification waits while you are recording or counting down.
- The request carries a generic `Rushes/<version>` User-Agent and nothing else that identifies you or your Mac: no account, no device ID, no telemetry. Rushes keeps the versions it already told you about in `updates.json` in its Application Support folder.
- Settings > Updates has a **Check for updates automatically** switch (on by default) and a **Check now** button, which shows "You're up to date", "Version X is available" or "Couldn't check".

Updates are manual for now. To update, download the new `.dmg` from the release page and install it over the old copy as described above. In-place automatic updates need a Developer ID signed, notarized build, and every current build is a preview. They will come once notarized builds exist.

## Building the installers yourself

```sh
swift build -c release
npm --prefix cloud ci && npm --prefix cloud run build
npm --prefix viewer ci && npm --prefix viewer run build
npm --prefix shell ci && npm --prefix shell run package
```

The installers are written to `shell/release/`. With no signing identity set, they are named `-unsigned-preview`. With `RUSHES_SIGN_IDENTITY` or `CSC_NAME` set to an Apple Development identity, they are named `-dev-signed-not-notarized`.
