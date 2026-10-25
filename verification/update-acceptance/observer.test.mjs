import * as acceptanceCases from "node:test";
import assertions from "node:assert/strict";
import * as sampleDisk from "node:fs/promises";
import * as sampleHost from "node:os";
import * as samplePaths from "node:path";
import * as sampleProcess from "node:child_process";
import { tree } from "./policy.mjs";
import {
  argumentsFor,
  protectedFiles,
  remeasureProtected,
  safeDirectory,
  atomicPrivate,
  checkDownload,
  boundedOperation,
  remeasurePayload,
  cleanupFailure,
  validateBuildRoots,
} from "./observer.mjs";
acceptanceCases.test(
  "exercise is explicit; recheck never implies app/update execution",
  () => {
    assertions.deepEqual(
      argumentsFor(["--recheck", "--evidence-root", "/tmp/example"]),
      { mode: "recheck", evidenceRoot: "/tmp/example" },
    );
    for (const args of [
      [],
      ["--evidence-root", "/tmp/example"],
      ["--exercise", "--recheck", "--evidence-root", "/tmp/example"],
      ["--recheck", "--evidence-root"],
      ["--recheck", "--unknown"],
    ])
      assertions.throws(() => argumentsFor(args));
  },
);
acceptanceCases.test(
  "data remeasurement checks real original bytes and semantic settings values",
  async (t) => {
    const root = await sampleDisk.mkdtemp(
      samplePaths.join(sampleHost.tmpdir(), "acceptance-state-"),
    );
    t.after(() => sampleDisk.rm(root, { recursive: true, force: true }));
    const seed = samplePaths.join(root, "seed"),
      live = samplePaths.join(root, "live"),
      before = samplePaths.join(root, "before");
    await sampleDisk.mkdir(seed);
    await sampleDisk.mkdir(live);
    await sampleDisk.writeFile(samplePaths.join(seed, "settings.json"), "{}");
    await sampleDisk.writeFile(
      samplePaths.join(live, "settings.json"),
      '{"mic":"none","camera":"none"}',
    );
    const expected = await protectedFiles(seed, live, before, true);
    await sampleDisk.writeFile(
      samplePaths.join(live, "settings.json"),
      '{"camera":"none", "mic":"none"}\n',
    );
    await remeasureProtected(live, expected);
    await sampleDisk.writeFile(
      samplePaths.join(live, "settings.json"),
      '{"camera":"none", "mic":"different"}',
    );
    await assertions.rejects(remeasureProtected(live, expected), /changed/);
    await remeasureProtected(before, expected);
  },
);
acceptanceCases.test(
  "a generated successful JSON receipt cannot qualify through the real CLI or create observer state",
  async (t) => {
    const root = await sampleDisk.mkdtemp(
      samplePaths.join(sampleHost.tmpdir(), "acceptance-generated-"),
    );
    t.after(() => sampleDisk.rm(root, { recursive: true, force: true }));
    const config = {
      schema: "rushes.installed-update-inputs/1",
      account: { username: "fixture_only", home: "/Users/fixture_only" },
      expectedTeam: "ABCDEFGHIJ",
      baseline: { directory: root, sourceRevision: "a".repeat(40) },
      candidate: { directory: root, sourceRevision: "b".repeat(40) },
      seed: {
        settings: "/Users/fixture_only/seed/settings",
        recordings: "/Users/fixture_only/seed/recordings",
      },
      feed: {
        url: "https://updates.example.org/acceptance/",
        controlURL:
          "https://updates.example.org/acceptance/__acceptance__/scenario",
        controlTokenEnvironment: "RUSHES_UPDATE_ACCEPTANCE_CONTROL_TOKEN",
      },
      busyCapture: { mode: "display", source: "main" },
    };
    await sampleDisk.writeFile(
      samplePaths.join(root, "inputs.json"),
      JSON.stringify(config),
    );
    await sampleDisk.writeFile(
      samplePaths.join(root, "observed-run.json"),
      JSON.stringify({
        status: "verified",
        productionAccepted: true,
        updateTransitionQualified: true,
        cases: ["good"],
      }),
    );
    const before = await sampleDisk.readdir(root),
      entry = new URL("../installed-update.mjs", import.meta.url);
    const run = sampleProcess.spawnSync(
      process.execPath,
      [entry.pathname, "--recheck", "--evidence-root", root],
      { encoding: "utf8", timeout: 10000 },
    );
    assertions.equal(run.status, 1);
    const reply = JSON.parse(run.stdout);
    assertions.equal(reply.productionAccepted, false);
    assertions.equal(reply.updateTransitionQualified, false);
    assertions.equal(reply.status, "unverified");
    assertions.deepEqual(await sampleDisk.readdir(root), before);
  },
);

acceptanceCases.test(
  "fixed evidence paths and ancestor symlinks refuse before outside writes",
  async (t) => {
    const root = await sampleDisk.mkdtemp(
      samplePaths.join(sampleHost.tmpdir(), "acceptance-links-"),
    );
    t.after(() => sampleDisk.rm(root, { recursive: true, force: true }));
    const outside = samplePaths.join(root, "outside"),
      owned = samplePaths.join(root, "owned.noindex");
    await sampleDisk.mkdir(outside);
    await sampleDisk.mkdir(owned);
    await sampleDisk.symlink(outside, samplePaths.join(owned, "runs"));
    await assertions.rejects(
      safeDirectory(owned, samplePaths.join(owned, "runs", "fresh")),
      /symlink/,
    );
    const original = samplePaths.join(outside, "state");
    await sampleDisk.writeFile(original, "kept");
    await sampleDisk.symlink(
      original,
      samplePaths.join(owned, "latest-attempt.json"),
    );
    await assertions.rejects(
      atomicPrivate(
        owned,
        samplePaths.join(owned, "latest-attempt.json"),
        "changed",
      ),
      /symlink/,
    );
    assertions.equal(await sampleDisk.readFile(original, "utf8"), "kept");
  },
);
acceptanceCases.test(
  "terminal polling joins an already running automatic download",
  async () => {
    let reads = 0;
    const session = {
      api: async (_name, action) =>
        action === "check"
          ? { status: "downloading" }
          : ++reads === 1
            ? { status: "downloading" }
            : { status: "error" },
      events: async () => [],
    };
    const result = await checkDownload(session, "error");
    assertions.equal(result.reply.status, "error");
    assertions.ok(
      result.samples.some((sample) => sample.status === "downloading"),
    );
  },
);

acceptanceCases.test(
  "a hung installed IPC observation has an absolute budget",
  async () => {
    await assertions.rejects(
      boundedOperation(new Promise(() => {}), 2, "generated hung IPC"),
      /generated hung IPC/,
    );
  },
);

acceptanceCases.test(
  "both current payload and installed copy cannot replace the sealed archive identity",
  async (t) => {
    const root = await sampleDisk.mkdtemp(
      samplePaths.join(sampleHost.tmpdir(), "sealed-payload-"),
    );
    t.after(() => sampleDisk.rm(root, { recursive: true, force: true }));
    const payload = samplePaths.join(root, "payload"),
      app = samplePaths.join(root, "installed");
    await sampleDisk.mkdir(payload);
    await sampleDisk.mkdir(app);
    for (const folder of [payload, app])
      await sampleDisk.writeFile(
        samplePaths.join(folder, "Info.plist"),
        "original signed version metadata",
      );
    const sealed = { payload, inventory: await tree(payload) };
    await remeasurePayload(root, sealed, app);
    for (const folder of [payload, app])
      await sampleDisk.writeFile(
        samplePaths.join(folder, "Info.plist"),
        "different same-version bundle metadata",
      );
    await assertions.rejects(remeasurePayload(root, sealed, app), /differ/);
  },
);
acceptanceCases.test(
  "unconfirmed cleanup is visible and retains the owned case location",
  () => {
    const error = cleanupFailure(
      new Error("launch deadline"),
      new Error("retirement unconfirmed"),
      "/owned-case/Rushes.app",
    );
    assertions.equal(error.cleanupFailed, true);
    assertions.match(
      error.message,
      /launch deadline.*CLEANUP.*retirement unconfirmed/,
    );
    assertions.equal(error.ownedApp, "/owned-case/Rushes.app");
  },
);
acceptanceCases.test(
  "ignored build output aliases refuse before the source gate can write outside",
  async (t) => {
    const root = await sampleDisk.mkdtemp(
      samplePaths.join(sampleHost.tmpdir(), "build-roots-"),
    );
    t.after(() => sampleDisk.rm(root, { recursive: true, force: true }));
    const repo = samplePaths.join(root, "repo"),
      outside = samplePaths.join(root, "outside");
    await sampleDisk.mkdir(repo);
    await sampleDisk.mkdir(outside);
    await sampleDisk.symlink(outside, samplePaths.join(repo, ".build"));
    await assertions.rejects(
      validateBuildRoots(repo, process.getuid()),
      /symlink|escapes/,
    );
    assertions.deepEqual(await sampleDisk.readdir(outside), []);
  },
);
