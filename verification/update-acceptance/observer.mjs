import * as disk from "node:fs/promises";
import * as locations from "node:path";
import { homedir } from "node:os";
import { createHash, generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  CASES,
  NODE,
  inputs,
  requireValue,
  contained,
  boundedJSON,
  boundedBytes,
  releasePair,
  tree,
  sameTree,
  fileDigest,
  verifyObserver,
} from "./policy.mjs";
import { MacObserver, dedicatedAccount } from "./mac.mjs";
import { retireCreatedApplication } from "./lifecycle.mjs";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
export async function boundedOperation(operation, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Deadline exceeded: " + label)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function until(read, label, timeout = 30000) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) {
    const value = await read();
    if (value) return value;
    await pause(100);
  }
  throw new Error("Deadline exceeded: " + label);
}
export function argumentsFor(argv) {
  let mode, evidenceRoot;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--exercise" || arg === "--recheck") {
      requireValue(!mode, "Select exactly one mode.");
      mode = arg.slice(2);
    } else if (arg === "--evidence-root") {
      requireValue(
        !evidenceRoot && argv[index + 1] && !argv[index + 1].startsWith("--"),
        "Exact evidence root required.",
      );
      evidenceRoot = locations.resolve(argv[++index]);
    } else throw new Error("Unknown argument: " + arg);
  }
  requireValue(
    mode && evidenceRoot,
    "Use --exercise OR --recheck with --evidence-root. No action is implicit.",
  );
  return { mode, evidenceRoot };
}
export async function safeDirectory(root, path) {
  requireValue(contained(root, path), "Path is outside owned root.");
  let cursor = root;
  for (const part of locations.relative(root, path).split(locations.sep)) {
    cursor = locations.join(cursor, part);
    try {
      requireValue(
        !(await disk.lstat(cursor)).isSymbolicLink(),
        "Owned path contains a symlink.",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
export async function atomicPrivate(root, path, bytes) {
  await safeDirectory(root, path);
  const stage = path + "." + randomUUID() + ".stage";
  await disk.writeFile(stage, bytes, { flag: "wx", mode: 0o600 });
  try {
    await disk.rename(stage, path);
  } finally {
    await disk.unlink(stage).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
function defaultRoots(home) {
  return {
    settings: locations.join(home, "Library/Application Support/Rushes"),
    recordings: locations.join(home, "Movies/Rushes"),
  };
}
async function absent(path) {
  try {
    await disk.lstat(path);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}
async function assertFresh(home, roots) {
  for (const path of [
    ...Object.values(roots),
    locations.join(home, "Library/Application Support/rushes-desktop"),
  ]) {
    await safeDirectory(home, path);
    requireValue(
      await absent(path),
      "Dedicated account already has Rushes state; refuse to move or overwrite it.",
    );
  }
}
async function control(config, scenario, runId) {
  const token = process.env[config.feed.controlTokenEnvironment];
  requireValue(
    typeof token === "string" && token.length >= 32,
    "Acceptance feed control authority is missing.",
  );
  const result = await fetch(config.feed.controlURL, {
    method: "POST",
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(10000),
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
    },
    body: JSON.stringify({ scenario, runId }),
  });
  requireValue(
    result.status === 200,
    "Acceptance feed control refused the scenario.",
  );
  requireValue(result.body, "Feed control response body is absent.");
  const reader = result.body.getReader();
  let size = 0;
  const blocks = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      requireValue(size <= 8192, "Feed control reply exceeds bound.");
      blocks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const value = JSON.parse(Buffer.concat(blocks).toString("utf8"));
  requireValue(
    value.scenario === scenario && value.runId === runId,
    "Acceptance feed control read-back differs.",
  );
  return { scenario, runId, status: 200 };
}
export async function protectedFiles(seed, live, copyTo, jsonSettings = false) {
  const inventory = await tree(seed),
    result = Object.create(null);
  if (copyTo) await disk.mkdir(copyTo, { recursive: true, mode: 0o700 });
  for (const [relative, entry] of Object.entries(inventory)) {
    if (entry.kind === "directory") continue;
    requireValue(entry.kind === "file", "Seed symlinks are not accepted.");
    const current = locations.join(live, relative);
    await safeDirectory(live, current);
    requireValue(
      !(await disk.lstat(current)).isSymbolicLink(),
      "Protected data was replaced by a symlink.",
    );
    const json = jsonSettings && relative.endsWith(".json");
    result[relative] = {
      format: json ? "json" : "bytes",
      sha256: json
        ? digest(canonical(await boundedJSON(current)))
        : await fileDigest(current),
    };
    if (copyTo) {
      const output = locations.join(copyTo, relative);
      await disk.mkdir(locations.dirname(output), {
        recursive: true,
        mode: 0o700,
      });
      await disk.copyFile(current, output, 1);
      await disk.chmod(output, 0o600);
    }
  }
  return result;
}
export async function remeasureProtected(root, inventory) {
  const actual = Object.create(null);
  for (const [relative, expected] of Object.entries(inventory)) {
    requireValue(
      contained(root, locations.join(root, relative)),
      "Protected data path escapes its root.",
    );
    await safeDirectory(root, locations.join(root, relative));
    const path = locations.join(root, relative);
    requireValue(
      ["json", "bytes"].includes(expected.format),
      "Unknown preservation measurement.",
    );
    actual[relative] = {
      format: expected.format,
      sha256:
        expected.format === "json"
          ? digest(canonical(await boundedJSON(path)))
          : await fileDigest(path),
    };
  }
  requireValue(
    canonical(actual) === canonical(inventory),
    "Protected recordings, settings or account bytes changed.",
  );
  return actual;
}
export async function remeasurePayload(boundary, snapshot, installed) {
  await safeDirectory(boundary, snapshot.payload);
  sameTree(snapshot.inventory, await tree(snapshot.payload));
  if (installed) {
    await safeDirectory(boundary, installed);
    sameTree(snapshot.inventory, await tree(installed));
  }
}
async function nativeStatus(path) {
  return new Promise((resolve, reject) => {
    const id = randomUUID(),
      socket = createConnection(path);
    let text = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Native idle probe timed out."));
    }, 4000);
    const fail = (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.on("error", fail);
    socket.on("connect", () =>
      socket.write(JSON.stringify({ id, cmd: "status", args: {} }) + "\n"),
    );
    socket.on("data", (data) => {
      text += data;
      if (text.length > 2 * 1024 ** 2)
        return fail(new Error("Native status exceeds bound."));
      for (;;) {
        const end = text.indexOf("\n");
        if (end < 0) return;
        const line = text.slice(0, end);
        text = text.slice(end + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return fail(new Error("Invalid native reply."));
        }
        if (message.id === id && "ok" in message) {
          if (!message.ok) return fail(new Error("Native idle probe refused."));
          clearTimeout(timer);
          socket.destroy();
          resolve(message.result);
          return;
        }
      }
    });
  });
}
async function retireOwned(application, observer, app, uid) {
  const members = async () => {
    const owned = await observer.processes(app);
    requireValue(
      owned.every((member) => member.uid === uid),
      "Refuse to signal a foreign UID; retirement remains unconfirmed.",
    );
    return owned;
  };
  return retireCreatedApplication(application, {
    members,
    signal: async (member, signal) => {
      const fresh = (await members()).find(
        (item) => item.pid === member.pid && item.command === member.command,
      );
      if (fresh) process.kill(fresh.pid, signal);
    },
  });
}
async function launch(appPath, home, repo, observer, uid) {
  const playwright = await import(
    pathToFileURL(
      locations.join(repo, "viewer/node_modules/playwright/index.mjs"),
    ).toString()
  );
  const env = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "SHELL",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "DISPLAY",
    ]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  requireValue(
    env.HOME === undefined || (await disk.realpath(env.HOME)) === home,
    "Inherited HOME differs from the real dedicated account.",
  );
  const application = await playwright._electron.launch({
    executablePath: locations.join(appPath, "Contents/MacOS/Rushes"),
    args: [],
    env,
    timeout: 30000,
    chromiumSandbox: true,
  });
  try {
    const details = await boundedOperation(
      application.evaluate(({ app }) => ({
        pid: process.pid,
        executable: process.execPath,
        version: app.getVersion(),
        packaged: app.isPackaged,
        userData: app.getPath("userData"),
        home: app.getPath("home"),
        electron: process.versions.electron,
      })),
      10000,
      "installed process identity",
    );
    const selectedRuntime = await boundedJSON(
      locations.join(repo, "shell/package.json"),
    );
    requireValue(
      details.electron === selectedRuntime.devDependencies.electron,
      "Installed Electron runtime differs from the gated pin.",
    );
    requireValue(
      details.packaged &&
        contained(appPath, details.executable) &&
        details.home === home &&
        [
          defaultRoots(home).settings,
          locations.join(home, "Library/Application Support/rushes-desktop"),
        ].includes(details.userData),
      "Launched process is not the owned packaged app/account.",
    );
    const page = await application.firstWindow({ timeout: 30000 });
    await page.waitForFunction(
      () => window.rushes?.updates && window.rushes?.request,
    );
    await page.evaluate(() => {
      window.__updateAcceptance = [];
      window.rushes.onEvent((event) => {
        if (["app-update", "app-update-preparing"].includes(event.event))
          window.__updateAcceptance.push({ at: Date.now(), ...event });
      });
    });
    const api = async (name, ...args) => {
      const reply = await boundedOperation(
        page.evaluate(({ name, args }) => window.rushes[name](...args), {
          name,
          args,
        }),
        name === "updates" && args[0] === "check" ? 120000 : 20000,
        "installed IPC " + name,
      );
      if (reply?.__rushesError)
        throw Object.assign(new Error(reply.__rushesError.message), {
          code: reply.__rushesError.code,
        });
      return reply;
    };
    await until(async () => {
      const status = await api("request", "status");
      return status.state === "idle";
    }, "initial native idle");
    await until(
      async () => {
        const state = await api("updates", "status");
        return state.status !== "disabled" && state;
      },
      "packaged updater initialization",
      20000,
    );
    const bootstrap = await api("bootstrap");
    await api("saveOptions", {
      ...bootstrap.options,
      camera: "none",
      mic: "none",
      systemAudio: false,
      autoShare: false,
    });
    return {
      application,
      page,
      api,
      details,
      events: () =>
        boundedOperation(
          page.evaluate(() => window.__updateAcceptance),
          10000,
          "updater observations",
        ),
      close: () => retireOwned(application, observer, appPath, uid),
    };
  } catch (error) {
    try {
      await retireOwned(application, observer, appPath, uid);
    } catch (cleanup) {
      error.cleanup = cleanup.message;
    }
    throw error;
  }
}
async function accountIdentity(api) {
  const state = await api("hostedAccount", { action: "status" });
  requireValue(
    state.connected === true && !state.pending,
    "A real linked TEST cloud account is required in the isolated seed.",
  );
  return {
    connected: true,
    identitySHA256: digest(
      JSON.stringify({ email: state.email, serviceURL: state.serviceURL }),
    ),
  };
}
async function verifyRuntime(observer, app, roots, guiPID, uid) {
  const status = await nativeStatus(
    locations.join(roots.settings, "control.sock"),
  );
  requireValue(
    status.state === "idle" && Number.isSafeInteger(status.pid),
    "Fresh native idle identity is unavailable.",
  );
  const processes = await observer.processes(app),
    native = processes.find(
      (item) =>
        item.pid === status.pid &&
        item.parent === guiPID &&
        item.uid === uid &&
        item.command.startsWith(
          app + "/Contents/Resources/bin/rushcore-engine",
        ),
    );
  const helper = processes.find(
    (item) =>
      item.parent === guiPID &&
      item.uid === uid &&
      item.command.startsWith(
        app +
          "/Contents/Helpers/RushesAutomation.app/Contents/MacOS/RushesAutomation",
      ),
  );
  requireValue(
    native && helper,
    "Same installed GUI/native/helper process ownership was not observed.",
  );
  return {
    guiPID,
    nativePID: native.pid,
    helperPID: helper.pid,
    state: "idle",
  };
}
export async function checkDownload(session, expected) {
  const expires = Date.now() + 120000;
  const checking = session.api("updates", "check").then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  const samples = [];
  const reply = await until(
    async () => {
      const state = await session.api("updates", "status");
      samples.push({ at: Date.now(), ...state });
      return state.status === expected && state;
    },
    "real updater terminal state",
    120000,
  );
  // An already-active automatic check can make check() return its current
  // snapshot. The observed terminal status, not that immediate reply, owns this gate.
  let timer;
  try {
    const outcome = await Promise.race([
      checking,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Update request did not settle within its shared budget.",
              ),
            ),
          Math.max(1, expires - Date.now()),
        );
      }),
    ]);
    if (!outcome.ok) throw outcome.error;
  } finally {
    clearTimeout(timer);
  }
  const events = await session.events();
  requireValue(
    [...events, ...samples].some((event) => event.status === "downloading"),
    "The real updater never began artifact downloading.",
  );
  return { reply, events, samples };
}

async function archive(home, roots, userData, cache, caseRoot) {
  const moved = {};
  const candidates = { settings: roots.settings, recordings: roots.recordings };
  if (!Object.values(candidates).includes(userData))
    candidates.electron = userData;
  if (cache) candidates.cache = cache;
  for (const [name, path] of Object.entries(candidates)) {
    await safeDirectory(home, path);
    if (await absent(path)) continue;
    const target = locations.join(caseRoot, "after-" + name);
    requireValue(await absent(target), "Archive destination already exists.");
    await disk.rename(path, target);
    moved[name] = target;
  }
  return moved;
}
async function cachePath(app, home) {
  const text = await disk.readFile(
      locations.join(app, "Contents/Resources/app-update.yml"),
      "utf8",
    ),
    match = /^updaterCacheDirName:\s*['"]?([a-zA-Z0-9_-]+)['"]?\s*$/m.exec(
      text,
    );
  requireValue(match, "Exact packaged updater cache directory required.");
  return locations.join(home, "Library/Caches", match[1]);
}
export async function exercise(config, evidence, repo) {
  requireValue(
    process.versions.node === NODE &&
      !process.execArgv.length &&
      !process.env.NODE_OPTIONS &&
      process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
    "Pinned unmodified Node runtime required.",
  );
  const account = await dedicatedAccount(config, evidence, {
    requireGUI: true,
  });
  requireValue(
    contained(account.home, await disk.realpath(repo)) &&
      (await disk.stat(repo)).uid === account.uid,
    "Exercise source checkout must be owned by the dedicated account.",
  );
  const keyRoot = locations.join(
    account.home,
    ".rushes-update-observer.noindex",
  );
  await safeDirectory(account.home, keyRoot);
  await disk.mkdir(keyRoot, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const owner = await disk.lstat(keyRoot);
  requireValue(
    owner.isDirectory() &&
      !owner.isSymbolicLink() &&
      owner.uid === account.uid &&
      (owner.mode & 0o077) === 0,
    "Observer directory must be private and owned.",
  );
  const lock = locations.join(keyRoot, "exercise.lock"),
    nonce = randomUUID();
  await disk.writeFile(
    lock,
    JSON.stringify({
      schema: "rushes.acceptance-lock/1",
      pid: process.pid,
      nonce,
    }),
    { flag: "wx", mode: 0o600 },
  );
  try {
    return await exerciseOwned(config, evidence, repo);
  } finally {
    requireValue(
      (await boundedJSON(lock)).nonce === nonce,
      "Acceptance lock changed; preserve state for review.",
    );
    await disk.unlink(lock);
  }
}
async function exerciseOwned(config, evidence, repo) {
  requireValue(
    process.versions.node === NODE,
    "Run acceptance with pinned Node " + NODE + ".",
  );
  requireValue(
    !process.execArgv.length &&
      !process.env.NODE_OPTIONS &&
      process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
    "Injected Node loaders or TLS bypass cannot qualify acceptance.",
  );
  const account = await dedicatedAccount(config, evidence, {
      requireGUI: true,
    }),
    roots = defaultRoots(account.home);
  await assertFresh(account.home, roots);
  for (const role of ["settings", "recordings"]) {
    await safeDirectory(account.home, config.seed[role]);
    const files = await tree(config.seed[role]);
    requireValue(
      Object.values(files).every((file) => file.kind !== "link"),
      "Acceptance seeds cannot contain symlinks.",
    );
  }
  const seedOptions = await boundedJSON(
    locations.join(config.seed.settings, "settings.json"),
  );
  requireValue(
    seedOptions.camera === "none" &&
      seedOptions.mic === "none" &&
      seedOptions.systemAudio === false &&
      seedOptions.autoShare === false,
    "Seed input preview/auto-share must be disabled before launching an installed app.",
  );
  const runs = locations.join(evidence, "runs");
  await safeDirectory(account.home, evidence);
  await safeDirectory(evidence, runs);
  await disk.mkdir(runs, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const runRoot = locations.join(runs, randomUUID());
  await disk.mkdir(runRoot, { mode: 0o700 });
  await atomicPrivate(
    evidence,
    locations.join(evidence, "latest-attempt.json"),
    JSON.stringify({ runRoot, startedAt: new Date().toISOString() }) + "\n",
  );
  const commandFile = locations.join(runRoot, "commands.jsonl"),
    observer = new MacObserver(
      (value) =>
        disk.appendFile(commandFile, JSON.stringify(value) + "\n", {
          mode: 0o600,
        }),
      repo,
    );
  const candidateRevision = (
    await observer.command("/usr/bin/git", ["-C", repo, "rev-parse", "HEAD"])
  ).trim();
  requireValue(
    candidateRevision === config.candidate.sourceRevision,
    "Candidate source commit mismatch.",
  );
  requireValue(
    !(
      await observer.command("/usr/bin/git", [
        "-C",
        repo,
        "status",
        "--porcelain",
      ])
    ).trim(),
    "Source acceptance requires a clean committed checkout.",
  );
  await observer.build(
    "/bin/bash",
    [locations.join(repo, "scripts/check-mac-web.sh")],
    45 * 60000,
  );
  await observer.build(
    "/usr/bin/xcrun",
    ["swift", "build", "-c", "release"],
    10 * 60000,
  );
  const baseline = await boundedJSON(
      locations.join(config.baseline.directory, "latest-mac.json"),
    ),
    candidate = await boundedJSON(
      locations.join(config.candidate.directory, "latest-mac.json"),
    );
  releasePair(baseline, candidate);
  const base = await observer.artifacts(
    config.baseline.directory,
    baseline,
    config.expectedTeam,
    locations.join(runRoot, "baseline"),
  );
  const next = await observer.artifacts(
    config.candidate.directory,
    candidate,
    config.expectedTeam,
    locations.join(runRoot, "candidate"),
  );
  const helperPath = locations.join(
    runRoot,
    "helper-build.noindex",
    "RushesAutomation.app",
  );
  await disk.mkdir(locations.dirname(helperPath), { mode: 0o700 });
  const candidateInfo = await observer.plist(
    locations.join(next.payload, "Contents/Info.plist"),
  );
  await observer.build("python3", [
    locations.join(repo, "scripts/app-intents/host-package.py"),
    "--output",
    helperPath,
    "--configuration",
    "release",
    "--sign-identity",
    "-",
    "--version",
    candidateInfo.CFBundleShortVersionString,
    "--build-version",
    String(candidateInfo.CFBundleVersion),
  ]);
  const helperBuild = {
    path: helperPath,
    inventory: await tree(helperPath),
    comparison: await observer.prepareHelperComparison(
      next.payload,
      helperPath,
      locations.join(runRoot, "helper-comparison.noindex"),
    ),
  };
  const binding = await observer.sourceBinding(
    repo,
    next.payload,
    config.candidate.sourceRevision,
    helperBuild,
  );
  for (const app of [base.payload, next.payload]) {
    const policy = await boundedJSON(
      locations.join(app, "Contents/Resources/RushesUpdates.json"),
    );
    requireValue(
      policy.enabled === true && policy.feedURL === config.feed.url,
      "Signed app feed differs from the acceptance feed.",
    );
  }
  const run = {
    schema: "rushes.observed-update/1",
    provenance: "real-macos-observer",
    at: new Date().toISOString(),
    sourceRevision: candidateRevision,
    sourceBinding: binding,
    helperBuild,
    account,
    runRoot,
    inputsSHA256: digest(JSON.stringify(config)),
    baseline: {
      manifest: baseline,
      payload: base.payload,
      inventory: base.inventory,
    },
    candidate: {
      manifest: candidate,
      payload: next.payload,
      inventory: next.inventory,
    },
    cases: [],
  };
  for (const name of CASES) {
    await assertFresh(account.home, roots);
    const caseRoot = locations.join(runRoot, name);
    await disk.mkdir(caseRoot, { mode: 0o700 });
    const app = locations.join(caseRoot, "install.noindex", "Rushes.app");
    await disk.mkdir(locations.dirname(app));
    await observer.command("/usr/bin/ditto", [
      "--rsrc",
      "--extattr",
      base.payload,
      app,
    ]);
    sameTree(base.inventory, await tree(app));
    await observer.application(app, config.expectedTeam, baseline.version, {
      quarantine: true,
    });
    const cache = await cachePath(app, account.home);
    await safeDirectory(account.home, cache);
    requireValue(await absent(cache), "Dedicated updater cache is not fresh.");
    for (const role of ["settings", "recordings"]) {
      await disk.mkdir(locations.dirname(roots[role]), { recursive: true });
      await disk.cp(config.seed[role], roots[role], {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
    const events = [],
      record = (kind, value = {}) =>
        events.push({ at: Date.now(), kind, ...value });
    record("scenario-selected", await control(config, name, randomUUID()));
    let session;
    try {
      session = await launch(app, account.home, repo, observer, account.uid);
      requireValue(
        session.details.version === baseline.version,
        "Baseline runtime version differs.",
      );
      const beforeRuntime = await verifyRuntime(
          observer,
          app,
          roots,
          session.details.pid,
          account.uid,
        ),
        beforeAccount = await accountIdentity(session.api);
      const protectedData = {};
      for (const role of ["settings", "recordings"])
        protectedData[role] = await protectedFiles(
          config.seed[role],
          roots[role],
          locations.join(caseRoot, "before", role),
          role === "settings",
        );
      record("baseline-observed", {
        runtime: beforeRuntime,
        account: beforeAccount,
      });
      if (name === "bad-digest" || name === "interrupted") {
        const observed = await checkDownload(session, "error");
        record("download-refused", observed);
        sameTree(base.inventory, await tree(app));
      } else {
        record("download-ready", await checkDownload(session, "downloaded"));
        if (name === "busy") {
          const source =
            config.busyCapture.mode === "window"
              ? { window: config.busyCapture.source }
              : { display: config.busyCapture.source };
          requireValue(
            (await disk.stat("/dev/console")).uid === account.uid,
            "QA console ownership changed before explicit busy capture.",
          );
          await session.api("request", "record.start", {
            ...source,
            camera: "none",
            mic: "none",
            systemAudio: false,
            countdownSeconds: 0,
            duration: 5,
            title: "Isolated update busy control",
          });
          requireValue(
            (await session.api("request", "status")).state === "recording",
            "Busy control did not acquire real capture.",
          );
          let refused = false;
          try {
            await session.api("updates", "restart");
          } catch {
            refused = true;
          }
          requireValue(
            refused &&
              (await session.api("request", "status")).state === "recording",
            "Update did not refuse while preserving active capture.",
          );
          await session.api("request", "record.stop");
          await until(
            async () =>
              (await session.api("request", "status")).state === "idle",
            "busy control Stop",
          );
          record("busy-refused");
          sameTree(base.inventory, await tree(app));
        } else {
          record("restart-requested");
          const oldPID = session.details.pid;
          await session.api("updates", "restart").catch((error) => {
            if (!String(error.message).includes("closed")) throw error;
          });
          await until(
            () => session.application.process().exitCode !== null,
            "old GUI exit",
            90000,
          );
          record("old-gui-exited", { pid: oldPID });
          const auto = await until(
            async () => {
              const list = await observer.processes(app);
              return list.find(
                (item) =>
                  item.uid === account.uid &&
                  item.pid !== oldPID &&
                  (item.command === app + "/Contents/MacOS/Rushes" ||
                    item.command.startsWith(app + "/Contents/MacOS/Rushes ")),
              );
            },
            "Squirrel automatic relaunch",
            90000,
          );
          requireValue(
            (await observer.plist(locations.join(app, "Contents/Info.plist")))
              .CFBundleShortVersionString === candidate.version,
            "Automatic launch did not install N+1.",
          );
          sameTree(next.inventory, await tree(app));
          const autoRuntime = await until(async () => {
            try {
              return await verifyRuntime(
                observer,
                app,
                roots,
                auto.pid,
                account.uid,
              );
            } catch {
              return false;
            }
          }, "new GUI/native/helper ownership");
          requireValue(
            autoRuntime.nativePID !== beforeRuntime.nativePID,
            "New app adopted the old engine.",
          );
          record("automatic-relaunch-observed", { runtime: autoRuntime });
          // Observe the automatic launch FIRST. This later explicit Quit/reopen
          // only permits inspection; it never installs/copies the candidate.
          await observer.command("/usr/bin/osascript", [
            "-e",
            "tell application " + JSON.stringify(app) + " to quit",
          ]);
          await until(
            async () => !(await observer.processes(app)).length,
            "updated app clean Quit",
          );
          session = await launch(
            app,
            account.home,
            repo,
            observer,
            account.uid,
          );
          requireValue(
            session.details.version === candidate.version,
            "Installed N+1 inspection version differs.",
          );
          const afterAccount = await accountIdentity(session.api);
          requireValue(
            canonical(beforeAccount) === canonical(afterAccount),
            "Linked cloud account changed across signed update.",
          );
          record("updated-app-inspected", {
            runtime: await verifyRuntime(
              observer,
              app,
              roots,
              session.details.pid,
              account.uid,
            ),
            account: afterAccount,
          });
          await observer.application(
            app,
            config.expectedTeam,
            candidate.version,
          );
        }
      }
      for (const role of ["settings", "recordings"])
        await remeasureProtected(roots[role], protectedData[role]);
      const userData = session.details.userData;
      await session.close();
      session = undefined;
      await until(
        async () => !(await observer.processes(app)).length,
        "owned processes exit after Quit",
      );
      const after = await archive(
        account.home,
        roots,
        userData,
        cache,
        caseRoot,
      );
      for (const role of ["settings", "recordings"])
        await remeasureProtected(after[role], protectedData[role]);
      const decoded = [];
      for (const relative of Object.keys(protectedData.recordings))
        if (/\.(mov|mp4|wav)$/i.test(relative)) {
          const file = locations.join(after.recordings, relative);
          const measurement = await observer.decode(file);
          decoded.push({
            path: file,
            sha256: await fileDigest(file),
            measurement,
          });
        }
      requireValue(
        decoded.length > 0,
        "No actual preserved media was decoded.",
      );
      record("preservation-decoded", { files: decoded });
      run.cases.push({
        name,
        app,
        caseRoot,
        version: name === "good" ? candidate.version : baseline.version,
        beforeRoot: locations.join(caseRoot, "before"),
        after,
        protectedData,
        decoded,
        events,
      });
    } finally {
      if (session) await session.close().catch(() => {});
    }
  }
  run.commandLog = { path: commandFile, sha256: await fileDigest(commandFile) };
  const keyRoot = locations.join(
    account.home,
    ".rushes-update-observer.noindex",
  );
  await safeDirectory(account.home, keyRoot);
  await disk.mkdir(keyRoot, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const privatePath = locations.join(keyRoot, "observer-private.pem"),
    publicPath = locations.join(keyRoot, "observer-public.pem");
  if (await absent(privatePath)) {
    const pair = generateKeyPairSync("ed25519");
    await disk.writeFile(
      privatePath,
      pair.privateKey.export({ type: "pkcs8", format: "pem" }),
      { flag: "wx", mode: 0o600 },
    );
    await disk.writeFile(
      publicPath,
      pair.publicKey.export({ type: "spki", format: "pem" }),
      { flag: "wx", mode: 0o600 },
    );
  }
  const keyStat = await disk.lstat(privatePath);
  requireValue(
    !keyStat.isSymbolicLink() &&
      keyStat.uid === account.uid &&
      (keyStat.mode & 0o077) === 0,
    "Observer key is not private/owned.",
  );
  const bytes = Buffer.from(JSON.stringify(run, null, 2) + "\n");
  await atomicPrivate(
    evidence,
    locations.join(evidence, "observed-run.json"),
    bytes,
  );
  await atomicPrivate(
    evidence,
    locations.join(evidence, "observed-run.sig"),
    sign(null, bytes, await disk.readFile(privatePath)),
  );
  return recheck(config, evidence, repo);
}
export async function recheck(config, evidence, repo) {
  requireValue(
    !process.execArgv.length &&
      !process.env.NODE_OPTIONS &&
      process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
    "Injected loaders/TLS bypass cannot qualify recheck.",
  );
  const account = await dedicatedAccount(config, evidence);
  for (const name of [
    "observed-run.json",
    "observed-run.sig",
    "latest-attempt.json",
  ])
    await safeDirectory(evidence, locations.join(evidence, name));
  const bytes = await disk.readFile(
    locations.join(evidence, "observed-run.json"),
  );
  requireValue(bytes.length <= 16 * 1024 ** 2, "Observed run exceeds bound.");
  await safeDirectory(
    account.home,
    locations.join(account.home, ".rushes-update-observer.noindex"),
  );
  const key = locations.join(
      account.home,
      ".rushes-update-observer.noindex/observer-public.pem",
    ),
    stat = await disk.lstat(key);
  requireValue(
    !stat.isSymbolicLink() &&
      stat.uid === account.uid &&
      (stat.mode & 0o077) === 0,
    "Independent account observer anchor is unavailable.",
  );
  const run = verifyObserver(
    bytes,
    await boundedBytes(locations.join(evidence, "observed-run.sig"), 64),
    await boundedBytes(key, 8192),
  );
  requireValue(
    run.inputsSHA256 === digest(JSON.stringify(config)) &&
      contained(evidence, run.runRoot),
    "Observed run belongs to other inputs/root.",
  );
  requireValue(
    (await boundedJSON(locations.join(evidence, "latest-attempt.json")))
      .runRoot === run.runRoot,
    "Latest attempt is incomplete; an older receipt cannot hide it.",
  );
  requireValue(
    contained(run.runRoot, run.commandLog.path) &&
      contained(run.runRoot, run.baseline.payload) &&
      contained(run.runRoot, run.candidate.payload),
    "Observed artifacts/journal escape the owned run.",
  );
  await safeDirectory(evidence, run.runRoot);
  for (const copy of Object.values(run.helperBuild.comparison.copies))
    await safeDirectory(run.runRoot, copy.path);
  for (const path of [
    run.commandLog.path,
    run.baseline.payload,
    run.candidate.payload,
    run.helperBuild.path,
  ])
    await safeDirectory(run.runRoot, path);
  const observer = new MacObserver(async () => {}, repo);
  requireValue(
    (
      await observer.command("/usr/bin/git", ["-C", repo, "rev-parse", "HEAD"])
    ).trim() === run.sourceRevision,
    "Current source changed after observed acceptance.",
  );
  requireValue(
    (await fileDigest(run.commandLog.path)) === run.commandLog.sha256,
    "Raw command/source-gate journal changed.",
  );
  releasePair(run.baseline.manifest, run.candidate.manifest);
  for (const side of ["baseline", "candidate"])
    for (const file of run[side].manifest.files)
      requireValue(
        (await fileDigest(
          locations.join(config[side].directory, file.url),
          "sha512",
        )) === file.sha512,
        "Release bytes changed after acceptance.",
      );
  for (const side of ["baseline", "candidate"]) {
    const dmg = run[side].manifest.files.find((file) =>
      file.url.endsWith(".dmg"),
    );
    const path = locations.join(config[side].directory, dmg.url);
    await observer.command("/usr/bin/hdiutil", ["verify", path]);
    await observer.command("/usr/bin/xcrun", ["stapler", "validate", path]);
    requireValue(
      (
        await observer.command("/usr/bin/xattr", [
          "-p",
          "com.apple.quarantine",
          path,
        ])
      ).trim(),
      "Downloaded DMG quarantine disappeared.",
    );
  }
  requireValue(
    canonical(
      await observer.sourceBinding(
        repo,
        run.candidate.payload,
        config.candidate.sourceRevision,
        run.helperBuild,
      ),
    ) === canonical(run.sourceBinding),
    "Gated build binding changed after observation.",
  );
  requireValue(
    contained(run.runRoot, run.helperBuild.path),
    "Helper build escaped owned run.",
  );
  sameTree(run.helperBuild.inventory, await tree(run.helperBuild.path));
  for (const side of ["baseline", "candidate"])
    await remeasurePayload(run.runRoot, run[side]);
  for (const item of run.cases) {
    requireValue(
      contained(run.runRoot, item.app) &&
        contained(run.runRoot, item.beforeRoot) &&
        Object.values(item.after).every((path) => contained(run.runRoot, path)),
      "Observed path escapes owned run.",
    );
    const kinds = item.events.map((event) => event.kind),
      needed =
        item.name === "good"
          ? [
              "restart-requested",
              "old-gui-exited",
              "automatic-relaunch-observed",
              "updated-app-inspected",
            ]
          : item.name === "busy"
            ? ["download-ready", "busy-refused"]
            : ["download-refused"];
    requireValue(
      needed.every((kind) => kinds.includes(kind)),
      "Required real transition observations are incomplete.",
    );
    const signed = await observer.application(
      item.app,
      config.expectedTeam,
      item.version,
    );
    await remeasurePayload(
      run.runRoot,
      item.name === "good" ? run.candidate : run.baseline,
      item.app,
    );
    for (const role of ["settings", "recordings"]) {
      await safeDirectory(run.runRoot, locations.join(item.beforeRoot, role));
      await safeDirectory(run.runRoot, item.after[role]);
      await remeasureProtected(
        locations.join(item.beforeRoot, role),
        item.protectedData[role],
      );
      await remeasureProtected(item.after[role], item.protectedData[role]);
    }
    requireValue(
      item.decoded.length > 0,
      "Missing independently decoded preserved originals.",
    );
    for (const media of item.decoded) {
      requireValue(
        contained(item.after.recordings, media.path) &&
          (await fileDigest(media.path)) === media.sha256,
        "Preserved media identity changed.",
      );
      await observer.decode(media.path);
    }
  }
  return {
    status: "verified",
    level: "observed-signed-installed-update",
    productionAccepted: false,
    updateTransitionQualified: true,
    archivePayloadMatchQualified: true,
    version: run.candidate.manifest.version,
    runRoot: run.runRoot,
    recheckReadOnly: true,
    remaining:
      "Whole-product physical capture, authentic provider/billing and exact audience/release gates remain independent.",
  };
}
export async function runCLI(argv, repo) {
  requireValue(
    process.versions.node === NODE,
    "Run this verifier with pinned Node " + NODE + ".",
  );
  const selected = argumentsFor(argv),
    config = inputs(
      await boundedJSON(locations.join(selected.evidenceRoot, "inputs.json")),
    );
  const result =
    selected.mode === "exercise"
      ? await exercise(config, selected.evidenceRoot, repo)
      : await recheck(config, selected.evidenceRoot, repo);
  return {
    ...result,
    mode: selected.mode,
    consequentialTransitionPerformed: selected.mode === "exercise",
  };
}
