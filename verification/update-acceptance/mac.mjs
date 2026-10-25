import * as disk from "node:fs/promises";
import * as paths from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runOwnedHelper } from "../../shell/scripts/owned-helper-build.mjs";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  PRODUCT,
  requireValue,
  contained,
  boundedJSON,
  fileDigest,
  tree,
  sameTree,
  signature,
  zipEntries,
  executableContent,
  authoritativeAccount,
} from "./policy.mjs";
const execute = promisify(execFile);
export class MacObserver {
  constructor(log, cwd) {
    this.log = log;
    this.sequence = 0;
    this.cwd = cwd;
  }
  async command(file, args, timeout = 60000) {
    let result;
    try {
      const r = await execute(file, args, {
        timeout,
        cwd: this.cwd,
        maxBuffer: 8 * 1024 ** 2,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
      result = { exit: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (error) {
      result = {
        exit: Number.isInteger(error.code) ? error.code : 1,
        stdout: String(error.stdout ?? ""),
        stderr: String(error.stderr ?? ""),
        signal: error.signal,
      };
    }
    await this.log({
      kind: "command",
      sequence: ++this.sequence,
      at: Date.now(),
      file,
      args,
      ...result,
    });
    requireValue(
      result.exit === 0,
      `${paths.basename(file)} failed (${result.exit}). See the owned command journal.`,
    );
    return result.stdout + result.stderr;
  }
  async build(file, args, timeout = 900000) {
    let measured;
    try {
      measured = await runOwnedHelper(file, args, {
        cwd: this.cwd,
        timeoutMs: Math.min(timeout, 900000),
      });
      await this.log({
        kind: "owned-build",
        at: Date.now(),
        file,
        args,
        ...measured,
      });
      requireValue(
        measured.actualExitCode === 0 && measured.retirementConfirmed,
        "Build exit/descendant retirement did not qualify.",
      );
      return measured;
    } catch (error) {
      await this.log({
        kind: "owned-build-failed",
        at: Date.now(),
        file,
        args,
        ...(error.buildResult ?? {}),
      });
      throw error;
    }
  }
  async plist(path) {
    return JSON.parse(
      await this.command("/usr/bin/plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        path,
      ]),
    );
  }
  async application(app, team, version, { quarantine = false } = {}) {
    requireValue(
      !(await disk.lstat(app)).isSymbolicLink(),
      "Application root cannot be linked.",
    );
    const inventory = await tree(app);
    const info = await this.plist(paths.join(app, "Contents/Info.plist"));
    requireValue(
      info.CFBundleIdentifier === PRODUCT &&
        info.CFBundleName === "Rushes" &&
        info.CFBundleExecutable === "Rushes" &&
        info.CFBundleShortVersionString === version,
      "Installed app identifier/version differs.",
    );
    await this.command("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      app,
    ]);
    signature(
      await this.command("/usr/bin/codesign", ["-d", "--verbose=4", app]),
      team,
      PRODUCT,
    );
    const machos = [];
    for (const [relative, entry] of Object.entries(inventory)) {
      if (entry.kind !== "file" || entry.size < 4) continue;
      const path = paths.join(app, relative),
        handle = await disk.open(path, "r"),
        bytes = Buffer.alloc(4);
      try {
        await handle.read(bytes, 0, 4, 0);
      } finally {
        await handle.close();
      }
      if (
        [
          "feedface",
          "feedfacf",
          "cefaedfe",
          "cffaedfe",
          "cafebabe",
          "bebafeca",
          "cafebabf",
          "bfbafeca",
        ].includes(bytes.toString("hex"))
      )
        machos.push(path);
    }
    for (const required of [
      "Contents/MacOS/Rushes",
      "Contents/Resources/bin/rushcore-engine",
      "Contents/Resources/bin/rushes",
      "Contents/Helpers/RushesAutomation.app/Contents/MacOS/RushesAutomation",
    ])
      requireValue(
        machos.includes(paths.join(app, required)),
        `Required executable missing: ${required}`,
      );
    for (const executable of machos) {
      await this.command("/usr/bin/codesign", [
        "--verify",
        "--strict",
        executable,
      ]);
      signature(
        await this.command("/usr/bin/codesign", [
          "-d",
          "--verbose=4",
          executable,
        ]),
        team,
      );
    }
    await this.command("/usr/bin/xcrun", ["stapler", "validate", app]);
    requireValue(
      (
        await this.command("/usr/sbin/spctl", [
          "--assess",
          "--type",
          "execute",
          "--verbose=4",
          app,
        ])
      ).includes("source=Notarized Developer ID"),
      "Gatekeeper did not confirm notarized Developer ID.",
    );
    if (quarantine)
      requireValue(
        (
          await this.command("/usr/bin/xattr", [
            "-p",
            "com.apple.quarantine",
            app,
          ])
        ).trim().length > 0,
        "Installed app quarantine is absent.",
      );
    return { info, inventory, machOCount: machos.length };
  }
  async artifacts(directory, manifest, team, workspace) {
    await disk.mkdir(workspace, { mode: 0o700 });
    for (const file of manifest.files) {
      const path = paths.join(directory, file.url),
        stat = await disk.lstat(path);
      requireValue(
        stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.size === file.size &&
          (await fileDigest(path, "sha512")) === file.sha512,
        "Release artifact differs from exact manifest.",
      );
    }
    const dmg = paths.join(
        directory,
        manifest.files.find((x) => x.url.endsWith(".dmg")).url,
      ),
      zip = paths.join(
        directory,
        manifest.files.find((x) => x.url.endsWith(".zip")).url,
      );
    const quarantine = (
      await this.command("/usr/bin/xattr", ["-p", "com.apple.quarantine", dmg])
    ).trim();
    requireValue(
      quarantine.length > 0,
      "Actual downloaded DMG must be quarantined.",
    );
    await this.command("/usr/bin/hdiutil", ["verify", dmg]);
    await this.command("/usr/bin/xcrun", ["stapler", "validate", dmg]);
    const mount = paths.join(workspace, "mount"),
      extract = paths.join(workspace, "zip");
    await disk.mkdir(mount);
    await disk.mkdir(extract);
    await this.command("python3", [
      fileURLToPath(new URL("./zip_inspect.py", import.meta.url)),
      zip,
    ]);
    zipEntries(await this.command("/usr/bin/unzip", ["-Z1", zip]));
    await this.command("/usr/bin/ditto", ["-x", "-k", zip, extract]);
    const zipped = paths.join(extract, "Rushes.app");
    await this.application(zipped, team, manifest.version);
    let attached = false;
    try {
      await this.command("/usr/bin/hdiutil", [
        "attach",
        "-readonly",
        "-nobrowse",
        "-mountpoint",
        mount,
        dmg,
      ]);
      attached = true;
      const mounted = paths.join(mount, "Rushes.app");
      await this.application(mounted, team, manifest.version);
      const mountedTree = await tree(mounted),
        zipTree = await tree(zipped);
      sameTree(mountedTree, zipTree);
      const payload = paths.join(workspace, "payload.noindex", "Rushes.app");
      await disk.mkdir(paths.dirname(payload));
      await this.command("/usr/bin/ditto", [
        "--rsrc",
        "--extattr",
        mounted,
        payload,
      ]);
      await this.command("/usr/bin/xattr", [
        "-w",
        "com.apple.quarantine",
        quarantine,
        payload,
      ]);
      sameTree(mountedTree, await tree(payload));
      await this.application(payload, team, manifest.version, {
        quarantine: true,
      });
      return { payload, inventory: mountedTree, quarantine, manifest };
    } finally {
      if (attached) await this.command("/usr/bin/hdiutil", ["detach", mount]);
    }
  }
  async prepareHelperComparison(app, builtHelper, directory) {
    await disk.mkdir(directory, { mode: 0o700 });
    const originals = {
      built: paths.join(builtHelper, "Contents/MacOS/RushesAutomation"),
      packaged: paths.join(
        app,
        "Contents/Helpers/RushesAutomation.app/Contents/MacOS/RushesAutomation",
      ),
    };
    const result = { directory, originals: {}, copies: {} };
    for (const [side, original] of Object.entries(originals)) {
      const copy = paths.join(directory, side + ".macho");
      result.originals[side] = await fileDigest(original);
      await disk.copyFile(original, copy, 1);
      await this.command("/usr/bin/codesign", ["--remove-signature", copy]);
      await this.command("/usr/bin/strip", ["-S", copy]);
      result.copies[side] = {
        path: copy,
        sha256: await fileDigest(copy),
        content: await executableContent(copy, { ignoreUUID: true }),
      };
    }
    requireValue(
      result.copies.built.content === result.copies.packaged.content,
      "Helper compiled code/loader data differs after debug/signature normalization.",
    );
    return result;
  }
  async sourceBinding(repo, app, revision, helper) {
    const builtHelper = helper?.path,
      comparison = helper?.comparison;

    requireValue(
      (
        await this.command("/usr/bin/git", ["-C", repo, "rev-parse", "HEAD"])
      ).trim() === revision,
      "Source revision differs from selected candidate.",
    );
    requireValue(
      !(
        await this.command("/usr/bin/git", [
          "-C",
          repo,
          "status",
          "--porcelain",
          "--untracked-files=normal",
        ])
      ).trim(),
      "Source gate requires a clean committed checkout.",
    );
    const ownRequire = createRequire(paths.join(repo, "shell/package.json"));
    const asarModule = ownRequire.resolve("@electron/asar");
    requireValue(
      contained(paths.join(repo, "shell/node_modules"), asarModule),
      "Use this checkout's own pinned ASAR dependency.",
    );
    const asar = await import(pathToFileURL(asarModule).toString());
    const packed = paths.join(app, "Contents/Resources/app.asar");
    const unpacked = asar
      .listPackage(packed)
      .map((name) => name.replace(/^\//, ""));
    const sourcePackage = await boundedJSON(
      paths.join(repo, "shell/package.json"),
    );
    const archivePackage = JSON.parse(
      asar.extractFile(packed, "package.json").toString("utf8"),
    );
    requireValue(
      archivePackage.main === sourcePackage.main &&
        archivePackage.name === sourcePackage.name &&
        archivePackage.version === sourcePackage.version &&
        (!archivePackage.productName ||
          archivePackage.productName === sourcePackage.build.productName),
      "Packaged entrypoint/identity differs from source metadata.",
    );
    const builtMain = await tree(paths.join(repo, "shell/dist"));
    for (const member of unpacked) {
      requireValue(
        !member.startsWith("/") &&
          !member.split("/").includes("..") &&
          !member.includes("\\"),
        "ASAR member escapes its archive.",
      );
      const item = asar.statFile(packed, member, false);
      if (item.files) continue;
      requireValue(
        !item.link,
        "ASAR links cannot bypass source identity checks.",
      );
      if (member === "package.json") continue;
      requireValue(
        member.startsWith("dist/") || member.startsWith("node_modules/"),
        "Unexpected executable ASAR resource.",
      );
      if (member.startsWith("dist/"))
        requireValue(
          builtMain[member.slice(5)],
          "ASAR contains an ungated built entry.",
        );
      else {
        const origin = paths.join(repo, "shell", member);
        const { createHash } = await import("node:crypto");
        requireValue(
          createHash("sha256")
            .update(asar.extractFile(packed, member))
            .digest("hex") === (await fileDigest(origin)),
          "Packaged dependency differs from pinned installed source.",
        );
      }
    }
    for (const [source, target] of [
      ["shell/dist", "dist"],
      ["cloud/dist", "Contents/Resources/cloud"],
      ["viewer/dist", "Contents/Resources/viewer"],
    ]) {
      const sourceRoot = paths.join(repo, source),
        inventory = await tree(sourceRoot);
      for (const [relative, entry] of Object.entries(inventory)) {
        if (entry.kind === "directory") continue;
        requireValue(
          entry.kind === "file",
          "Build output symlink refused for source binding.",
        );
        if (source === "shell/dist") {
          const member = paths.posix.join(
            target,
            relative.split(paths.sep).join("/"),
          );
          requireValue(
            unpacked.includes(member),
            "Packaged renderer/main member missing.",
          );
          const { createHash } = await import("node:crypto");
          requireValue(
            createHash("sha256")
              .update(asar.extractFile(packed, member))
              .digest("hex") === entry.sha256,
            "Packaged main/renderer differs from gated source output.",
          );
        } else
          requireValue(
            (await fileDigest(paths.join(app, target, relative))) ===
              entry.sha256,
            "Packaged SDK/viewer differs from gated source output.",
          );
      }
    }
    for (const name of ["rushcore-engine", "rushes"])
      requireValue(
        (await executableContent(paths.join(repo, ".build/release", name))) ===
          (await executableContent(
            paths.join(app, "Contents/Resources/bin", name),
          )),
        "Packaged native executable differs from the gated release build.",
      );
    requireValue(
      builtHelper,
      "A fresh source-built helper binding is required.",
    );
    const packagedHelper = paths.join(
      app,
      "Contents/Helpers/RushesAutomation.app",
    );
    const sourceHelperInfo = await this.plist(
      paths.join(builtHelper, "Contents/Info.plist"),
    );
    const packagedHelperInfo = await this.plist(
      paths.join(packagedHelper, "Contents/Info.plist"),
    );
    for (const field of [
      "CFBundleIdentifier",
      "CFBundleExecutable",
      "CFBundleShortVersionString",
      "CFBundleVersion",
      "LSMinimumSystemVersion",
      "LSUIElement",
    ])
      requireValue(
        JSON.stringify(sourceHelperInfo[field]) ===
          JSON.stringify(packagedHelperInfo[field]),
        "Packaged helper metadata differs from fresh source build.",
      );
    requireValue(
      comparison &&
        (await fileDigest(
          paths.join(builtHelper, "Contents/MacOS/RushesAutomation"),
        )) === comparison.originals.built &&
        (await fileDigest(
          paths.join(packagedHelper, "Contents/MacOS/RushesAutomation"),
        )) === comparison.originals.packaged,
      "Measured helper originals changed after source comparison.",
    );
    for (const selected of Object.values(comparison.copies))
      requireValue(
        (await fileDigest(selected.path)) === selected.sha256 &&
          (await executableContent(selected.path, { ignoreUUID: true })) ===
            selected.content,
        "Retained canonical helper comparison changed.",
      );
    const helperContent = comparison.copies.built.content;
    requireValue(
      helperContent === comparison.copies.packaged.content,
      "Packaged helper code differs from fresh source build.",
    );
    const helperMetadata = await tree(
      paths.join(builtHelper, "Contents/Resources/Metadata.appintents"),
    );
    sameTree(
      helperMetadata,
      await tree(
        paths.join(packagedHelper, "Contents/Resources/Metadata.appintents"),
      ),
    );
    return {
      helper: {
        content: helperContent,
        metadata: helperMetadata,
        info: sourceHelperInfo,
      },
      revision,
      asar: await fileDigest(packed),
      native: await fileDigest(
        paths.join(app, "Contents/Resources/bin/rushcore-engine"),
      ),
    };
  }
  async processes(app) {
    const text = await this.command("/bin/ps", [
      "-axo",
      "pid=,ppid=,uid=,command=",
    ]);
    return text.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match && match[4].startsWith(app + "/Contents/")
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              uid: Number(match[3]),
              command: match[4],
            },
          ]
        : [];
    });
  }
  async mediaTool(name) {
    const selected = (await this.command("/usr/bin/which", [name])).trim();
    requireValue(
      paths.isAbsolute(selected) && !selected.includes("\n"),
      "Exact decoder tool path required.",
    );
    const executable = await disk.realpath(selected);
    const version = await this.command(executable, ["-version"]);
    requireValue(
      version.startsWith(name + " version "),
      "Independent media tool identity is unavailable.",
    );
    return {
      path: executable,
      sha256: await fileDigest(executable),
      version: version.split("\n")[0],
    };
  }
  async decode(path) {
    const ffmpeg = await this.mediaTool("ffmpeg"),
      ffprobe = await this.mediaTool("ffprobe");
    await this.command(
      ffmpeg.path,
      ["-nostdin", "-v", "error", "-xerror", "-i", path, "-f", "null", "-"],
      120000,
    );
    const counted = JSON.parse(
      await this.command(
        ffprobe.path,
        [
          "-v",
          "error",
          "-count_frames",
          "-show_entries",
          "stream=codec_type,nb_read_frames",
          "-of",
          "json",
          path,
        ],
        120000,
      ),
    );
    requireValue(
      Array.isArray(counted.streams) &&
        counted.streams.length > 0 &&
        counted.streams.every(
          (stream) =>
            ["video", "audio"].includes(stream.codec_type) &&
            Number.isSafeInteger(Number(stream.nb_read_frames)) &&
            Number(stream.nb_read_frames) > 0,
        ),
      "Preserved media has no independently counted decoded frames.",
    );
    return { ffmpeg, ffprobe, streams: counted.streams };
  }
}
export async function dedicatedAccount(
  config,
  evidence,
  { requireGUI = false } = {},
) {
  requireValue(
    process.platform === "darwin" && process.arch === "arm64",
    "Real acceptance requires the supported ARM64 macOS host.",
  );
  const who = os.userInfo();
  const authoritativeHome = await disk.realpath(who.homedir);
  authoritativeAccount(
    who,
    config.account,
    authoritativeHome,
    process.env.HOME,
  );
  requireValue(
    /^rushes-qa-[a-z0-9]{3,12}$/.test(who.username) &&
      who.username === config.account.username &&
      authoritativeHome === config.account.home &&
      (await disk.realpath(os.homedir())) === authoritativeHome &&
      (!process.env.HOME || process.env.HOME === who.homedir),
    "Run only as the real dedicated rushes-qa OS account; HOME overrides are refused.",
  );
  requireValue(
    (await disk.realpath(evidence)) === paths.resolve(evidence) &&
      (await disk.realpath(config.account.home)) === config.account.home &&
      contained(config.account.home, evidence) &&
      evidence.split(paths.sep).some((part) => part.endsWith(".noindex")),
    "Evidence/install roots must be inside the acceptance account and a .noindex directory.",
  );
  const marker = paths.join(
      config.account.home,
      ".rushes-update-acceptance-account.json",
    ),
    stat = await disk.lstat(marker);
  requireValue(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.uid === who.uid &&
      (stat.mode & 0o077) === 0,
    "Dedicated-account marker must be owned and private.",
  );
  const declared = await boundedJSON(marker);
  requireValue(
    declared.schema === "rushes.acceptance-account/1" &&
      declared.username === who.username &&
      declared.home === config.account.home &&
      declared.purpose === "disposable Rushes acceptance only",
    "Dedicated-account marker mismatch.",
  );
  if (requireGUI)
    requireValue(
      (await disk.stat("/dev/console")).uid === who.uid,
      "The dedicated QA account must own the active graphical console.",
    );
  return { uid: who.uid, username: who.username, home: config.account.home };
}
