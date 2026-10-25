import * as checkCases from "node:test";
import assertions from "node:assert/strict";
import * as generatedDisk from "node:fs/promises";
import * as generatedHost from "node:os";
import * as generatedPaths from "node:path";
import { MacObserver } from "./mac.mjs";
const details =
  "Identifier=com.nexai.rushes\nTeamIdentifier=ABCDEFGHIJ\nAuthority=Developer ID Application: GENERATED ONLY\nCodeDirectory v=20500 size=444 flags=0x10000(runtime) hashes=3+7 location=embedded\nTimestamp=fixture\n";
async function fixture(t, mode = "good") {
  const root = await generatedDisk.mkdtemp(
      generatedPaths.join(generatedHost.tmpdir(), "signature-fixture-"),
    ),
    app = generatedPaths.join(root, "Rushes.app");
  t.after(() => generatedDisk.rm(root, { recursive: true, force: true }));
  for (const relative of [
    "Contents/MacOS/Rushes",
    "Contents/Resources/bin/rushcore-engine",
    "Contents/Resources/bin/rushes",
    "Contents/Helpers/RushesAutomation.app/Contents/MacOS/RushesAutomation",
  ]) {
    const path = generatedPaths.join(app, relative);
    await generatedDisk.mkdir(generatedPaths.dirname(path), {
      recursive: true,
    });
    await generatedDisk.writeFile(path, Buffer.from("cffaedfe00000000", "hex"));
  }
  const commands = [];
  class GeneratedCommands extends MacObserver {
    async command(file, args) {
      commands.push({ file, args });
      if (file.endsWith("/plutil"))
        return JSON.stringify({
          CFBundleIdentifier: "com.nexai.rushes",
          CFBundleName: "Rushes",
          CFBundleExecutable: "Rushes",
          CFBundleShortVersionString: "0.1.3",
        });
      if (file.endsWith("/codesign") && args.includes("-d"))
        return mode === "development"
          ? details.replace("Developer ID Application:", "Apple Development:")
          : details;
      if (file.endsWith("/spctl"))
        return mode === "gatekeeper-reject"
          ? "source=Unnotarized Developer ID"
          : "source=Notarized Developer ID";
      if (file.endsWith("/xattr"))
        return mode === "no-quarantine" ? "" : "0083;fixture;acceptance";
      return "";
    }
  }
  return { observer: new GeneratedCommands(async () => {}), app, commands };
}
checkCases.test(
  "GENERATED ONLY command fixture reaches every nested executable check without qualifying production",
  async (t) => {
    const f = await fixture(t),
      observed = await f.observer.application(f.app, "ABCDEFGHIJ", "0.1.3", {
        quarantine: true,
      });
    assertions.equal(observed.machOCount, 4);
    assertions.equal(observed.productionAccepted, undefined);
    assertions.ok(
      f.commands.some((command) => command.file.endsWith("/spctl")),
    );
    assertions.equal(
      f.commands.filter(
        (command) =>
          command.file.endsWith("/codesign") &&
          command.args.includes("--verify"),
      ).length,
      5,
    );
  },
);
for (const mode of ["development", "gatekeeper-reject", "no-quarantine"])
  checkCases.test(
    "GENERATED ONLY negative " +
      mode +
      " cannot pass signed application checks",
    async (t) => {
      const f = await fixture(t, mode);
      await assertions.rejects(
        f.observer.application(f.app, "ABCDEFGHIJ", "0.1.3", {
          quarantine: true,
        }),
        mode === "development"
          ? /Developer ID/
          : mode === "gatekeeper-reject"
            ? /Gatekeeper/
            : /quarantine/,
      );
    },
  );
