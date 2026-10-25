import * as disk from "node:fs/promises";
import { constants as fileAccess } from "node:fs";
import * as locations from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  publicReleaseURL,
  validateRelease,
  releaseVersion,
} from "../../shell/scripts/release-policy.mjs";

export const PRODUCT = "com.nexai.rushes";
export const NODE = "22.22.0";
export const CASES = ["bad-digest", "interrupted", "busy", "good"];
export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
export function contained(root, path) {
  const relative = locations.relative(
    locations.resolve(root),
    locations.resolve(path),
  );
  return (
    relative !== "" &&
    !relative.startsWith(".." + locations.sep) &&
    relative !== ".." &&
    !locations.isAbsolute(relative)
  );
}
export function compareVersions(a, b) {
  releaseVersion(a);
  releaseVersion(b);
  const left = a.split(".").map(Number),
    right = b.split(".").map(Number);
  const differing = left.findIndex((part, index) => part !== right[index]);
  return differing < 0 ? 0 : Math.sign(left[differing] - right[differing]);
}
export async function boundedBytes(path, maximum = 65536) {
  const handle = await disk.open(
    path,
    fileAccess.O_RDONLY | fileAccess.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    requireValue(
      before.isFile() && before.size <= maximum,
      "Metadata exceeds its bound.",
    );
    const bytes = Buffer.alloc(maximum + 1);
    let count = 0;
    for (;;) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      count += read.bytesRead;
      requireValue(count <= maximum, "Metadata grew beyond its bound.");
      if (!read.bytesRead) break;
    }
    const after = await handle.stat();
    requireValue(
      before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs,
      "Metadata changed while reading.",
    );
    return bytes.subarray(0, count);
  } finally {
    await handle.close();
  }
}
export async function boundedJSON(path, maximum = 65536) {
  const bytes = await boundedBytes(path, maximum);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Metadata JSON is invalid.");
  }
}

export function inputs(value) {
  requireValue(
    value?.schema === "rushes.installed-update-inputs/1",
    "Unsupported update acceptance inputs.",
  );
  const allowed = [
    "schema",
    "account",
    "expectedTeam",
    "baseline",
    "candidate",
    "seed",
    "feed",
    "busyCapture",
  ];
  requireValue(
    Object.keys(value).every((key) => allowed.includes(key)),
    "Unknown update acceptance input field.",
  );
  requireValue(
    /^[A-Z0-9]{10}$/.test(value.expectedTeam),
    "Exact Developer ID team required.",
  );
  requireValue(
    value.account &&
      /^[a-z][a-z0-9_-]{2,30}$/.test(value.account.username) &&
      locations.isAbsolute(value.account.home),
    "Dedicated acceptance account identity required.",
  );
  for (const side of ["baseline", "candidate"]) {
    const release = value[side];
    requireValue(
      release &&
        locations.isAbsolute(release.directory) &&
        /^[a-f0-9]{40}$/.test(release.sourceRevision),
      "Exact release directory and source revision required.",
    );
  }
  requireValue(
    value.seed &&
      locations.isAbsolute(value.seed.settings) &&
      locations.isAbsolute(value.seed.recordings),
    "Owned seed settings and recordings directories required.",
  );
  requireValue(
    contained(value.account.home, value.seed.settings) &&
      contained(value.account.home, value.seed.recordings),
    "Seeds must belong to the dedicated acceptance account.",
  );
  const feed = publicReleaseURL(value.feed?.url),
    control = new URL(value.feed?.controlURL);
  requireValue(
    control.protocol === "https:" &&
      control.origin === new URL(feed).origin &&
      !control.username &&
      !control.password &&
      !control.search &&
      !control.hash &&
      control.toString() ===
        new URL("__acceptance__/scenario", feed).toString(),
    "A same-origin HTTPS acceptance-only control endpoint is required.",
  );
  requireValue(
    value.feed.controlTokenEnvironment ===
      "RUSHES_UPDATE_ACCEPTANCE_CONTROL_TOKEN",
    "Use the named acceptance control token environment variable.",
  );
  const capture = value.busyCapture;
  requireValue(
    capture &&
      ["display", "window"].includes(capture.mode) &&
      typeof capture.source === "string" &&
      capture.source.length > 0 &&
      capture.source.length <= 300,
    "Explicit bounded screen/window source for real busy control required.",
  );
  return structuredClone({ ...value, feed: { ...value.feed, url: feed } });
}
export function releasePair(baseline, candidate) {
  validateRelease(baseline);
  validateRelease(candidate);
  requireValue(
    compareVersions(baseline.version, candidate.version) < 0,
    "Candidate must be strictly newer than baseline.",
  );
}
export function signature(details, team, identifier) {
  const lines = details.split(/\r?\n/),
    fields = new Map();
  for (const line of lines)
    if (line.includes("=")) {
      const i = line.indexOf("="),
        key = line.slice(0, i);
      fields.set(key, [...(fields.get(key) ?? []), line.slice(i + 1)]);
    }
  requireValue(
    fields.get("TeamIdentifier")?.length === 1 &&
      fields.get("TeamIdentifier")[0] === team,
    "Signing team differs.",
  );
  if (identifier)
    requireValue(
      fields.get("Identifier")?.length === 1 &&
        fields.get("Identifier")[0] === identifier,
      "Signing identifier differs.",
    );
  requireValue(
    lines.some((line) =>
      line.startsWith("Authority=Developer ID Application:"),
    ) &&
      !lines.some((line) => line.startsWith("Authority=Apple Development:")) &&
      !lines.includes("Signature=adhoc"),
    "Actual Developer ID Application signature required.",
  );
  const directories = lines.filter((line) => line.startsWith("CodeDirectory "));
  requireValue(directories.length === 1, "One real CodeDirectory required.");
  const runtime =
    /^CodeDirectory\s+v=\d+\s.*\bflags=(0x[a-f0-9]+)(?:\(([^)]*)\))?(?:\s|$)/i.exec(
      directories[0],
    );
  requireValue(
    runtime &&
      (BigInt(runtime[1]) & 0x10000n) !== 0n &&
      runtime[2]
        ?.split(",")
        .map((flag) => flag.trim())
        .includes("runtime"),
    "Hardened runtime CodeDirectory signature required.",
  );
  requireValue(
    lines.some(
      (line) =>
        line.startsWith("Timestamp=") &&
        !["", "none"].includes(line.slice(10).trim().toLowerCase()),
    ),
    "Trusted signing timestamp required.",
  );
}
export async function fileDigest(path, algorithm = "sha256") {
  const hash = createHash(algorithm),
    file = await disk.open(path, "r");
  try {
    const before = await file.stat();
    requireValue(
      before.isFile() && before.size <= 2 * 1024 ** 3,
      "File is missing or exceeds its bound.",
    );
    for await (const block of file.createReadStream({ autoClose: false }))
      hash.update(block);
    const after = await file.stat();
    requireValue(
      before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs,
      "File changed while hashing.",
    );
    return hash.digest(algorithm === "sha512" ? "base64" : "hex");
  } finally {
    await file.close();
  }
}
export async function tree(root) {
  const base = await disk.realpath(root),
    result = Object.create(null);
  let count = 0,
    total = 0;
  requireValue(
    !(await disk.lstat(root)).isSymbolicLink(),
    "Root must not be a symlink.",
  );
  async function visit(directory) {
    const names = (await disk.readdir(directory)).sort();
    for (const name of names) {
      const path = locations.join(directory, name),
        relative = locations.relative(base, path),
        stat = await disk.lstat(path);
      requireValue(++count <= 50000, "Tree file-count bound exceeded.");
      if (stat.isSymbolicLink()) {
        const target = await disk.readlink(path);
        const resolved = locations.resolve(locations.dirname(path), target);
        requireValue(
          contained(base, resolved),
          "A tree symlink escapes its root.",
        );
        result[relative] = { kind: "link", target };
      } else if (stat.isDirectory()) {
        result[relative] = {
          kind: "directory",
          executable: !!(stat.mode & 0o111),
        };
        await visit(path);
      } else {
        requireValue(stat.isFile(), "Special filesystem nodes are refused.");
        total += stat.size;
        requireValue(total <= 8 * 1024 ** 3, "Tree size bound exceeded.");
        result[relative] = {
          kind: "file",
          size: stat.size,
          executable: !!(stat.mode & 0o111),
          sha256: await fileDigest(path),
        };
      }
    }
  }
  await visit(base);
  validateSnapshotLinks(result);
  requireValue(Object.keys(result).length > 0, "An empty tree cannot qualify.");
  return result;
}
export function validateSnapshotLinks(inventory) {
  const key = (path) => path.normalize("NFC").toLowerCase();
  const links = new Map(),
    names = new Set();
  for (const [relative, entry] of Object.entries(inventory)) {
    const normalized = relative.split(locations.sep).join("/");
    requireValue(
      !names.has(key(normalized)),
      "Filesystem case/normalization aliases are refused.",
    );
    names.add(key(normalized));
    if (entry.kind === "link")
      links.set(key(normalized), entry.target.split(locations.sep).join("/"));
  }
  let operations = 0;
  for (const relative of links.keys()) {
    const pending = relative.split("/"),
      resolved = [];
    let hops = 0;
    while (pending.length) {
      requireValue(
        ++operations <= 1000000 && pending.length <= 8192,
        "Symlink resolution bound exceeded.",
      );
      const part = pending.shift();
      if (!part || part === ".") continue;
      if (part === "..") {
        requireValue(
          resolved.length > 0,
          "A chained symlink escapes its root.",
        );
        resolved.pop();
        continue;
      }
      const selected = key([...resolved, part].join("/"));
      if (links.has(selected)) {
        const target = links.get(selected);
        requireValue(
          !target.startsWith("/") && ++hops <= 40,
          "Absolute/cyclic symlink refused.",
        );
        pending.unshift(...target.split("/"));
      } else resolved.push(part);
    }
    requireValue(
      resolved.length > 0,
      "Symlink resolves outside the measured tree.",
    );
  }
}
export function sameTree(expected, observed) {
  requireValue(
    JSON.stringify(expected) === JSON.stringify(observed),
    "Payload/data bytes or file identities differ.",
  );
}
export function zipEntries(text) {
  const entries = text.split(/\r?\n/).filter(Boolean);
  requireValue(
    entries.length > 0 && entries.length <= 50000,
    "Archive inventory bound failed.",
  );
  for (const entry of entries) {
    const components = entry.split("/");
    requireValue(
      !entry.startsWith("/") &&
        !entry.includes("\\") &&
        !components.includes("..") &&
        !components.includes(".") &&
        (entry.startsWith("Rushes.app/") ||
          entry.startsWith("__MACOSX/Rushes.app/") ||
          entry === "__MACOSX/"),
      "Archive path escapes the expected app.",
    );
  }
  return entries;
}
export function verifyObserver(bytes, signatureBytes, keyBytes) {
  requireValue(
    verify(null, bytes, createPublicKey(keyBytes), signatureBytes),
    "The observed-run seal is missing or invalid.",
  );
  const run = JSON.parse(bytes.toString("utf8"));
  requireValue(
    run.schema === "rushes.observed-update/1" &&
      run.provenance === "real-macos-observer",
    "Generated or arbitrary receipt evidence cannot qualify.",
  );
  requireValue(
    run.cases?.length === CASES.length &&
      CASES.every((name, index) => run.cases[index]?.name === name),
    "All independently observed cases are required.",
  );
  for (const item of run.cases)
    requireValue(
      item.events?.length >= 3 &&
        item.events.every(
          (event, index) =>
            Number.isSafeInteger(event.at) &&
            (!index || event.at >= item.events[index - 1].at),
        ),
      "Ordered raw observations required.",
    );
  return run;
}

// Signing replaces LC_CODE_SIGNATURE and __LINKEDIT signature storage. Compare
// compiled sections and loader commands, while verifying each signature separately.
export async function executableContent(path, { ignoreUUID = false } = {}) {
  const data = await disk.readFile(path);
  requireValue(
    data.length >= 32 &&
      data.readUInt32LE(0) === 0xfeedfacf &&
      data.readUInt32LE(4) === 0x100000c,
    "Expected thin ARM64 Mach-O executable.",
  );
  const count = data.readUInt32LE(16),
    commandBytes = data.readUInt32LE(20);
  requireValue(
    count <= 1024 && 32 + commandBytes <= data.length,
    "Invalid Mach-O commands.",
  );
  const pieces = [
    [
      "architecture",
      data.readUInt32LE(4),
      data.readUInt32LE(8),
      data.readUInt32LE(12),
      data.readUInt32LE(24),
    ],
  ];
  let cursor = 32,
    sections = 0,
    firstData = data.length,
    signatureOffset = data.length;
  const text = (offset) =>
    data
      .subarray(offset, offset + 16)
      .toString("utf8")
      .split("\0")[0];
  for (let index = 0; index < count; index++) {
    requireValue(cursor + 8 <= 32 + commandBytes, "Truncated Mach-O command.");
    const cmd = data.readUInt32LE(cursor),
      size = data.readUInt32LE(cursor + 4);
    requireValue(
      size >= 8 && cursor + size <= 32 + commandBytes,
      "Mach-O command escapes table.",
    );
    if (cmd === 0x19) {
      requireValue(size >= 72, "Invalid segment.");
      const segment = text(cursor + 8),
        n = data.readUInt32LE(cursor + 64);
      requireValue(72 + n * 80 <= size, "Truncated sections.");
      for (let part = 0; part < n; part++) {
        const at = cursor + 72 + part * 80,
          length = Number(data.readBigUInt64LE(at + 40)),
          offset = data.readUInt32LE(at + 48),
          flags = data.readUInt32LE(at + 64),
          zeroFill = [1, 12, 18].includes(flags & 255);
        requireValue(
          Number.isSafeInteger(length) &&
            length <= 2 * 1024 ** 3 &&
            (zeroFill || offset + length <= data.length),
          "Section escapes executable.",
        );
        if (!zeroFill && length) firstData = Math.min(firstData, offset);
        pieces.push([
          segment,
          text(at),
          data.readBigUInt64LE(at + 32).toString(),
          length,
          flags,
          zeroFill
            ? "zero-fill"
            : createHash("sha256")
                .update(data.subarray(offset, offset + length))
                .digest("hex"),
        ]);
        sections++;
      }
    } else if (cmd === 0x1d) {
      requireValue(size === 16, "Invalid signature command.");
      signatureOffset = data.readUInt32LE(cursor + 8);
      requireValue(
        signatureOffset <= data.length,
        "Signature storage escapes executable.",
      );
    } else if (!(ignoreUUID && cmd === 0x1b))
      pieces.push([
        "loader",
        cmd,
        data.subarray(cursor, cursor + size).toString("base64"),
      ]);
    cursor += size;
  }
  requireValue(
    cursor === 32 + commandBytes &&
      sections > 0 &&
      firstData >= 32 + commandBytes &&
      signatureOffset >= firstData,
    "Executable has no measured sections.",
  );
  pieces.push([
    "compiled-image-and-linker-data",
    firstData,
    signatureOffset - firstData,
    createHash("sha256")
      .update(data.subarray(firstData, signatureOffset))
      .digest("hex"),
  ]);
  return createHash("sha256").update(JSON.stringify(pieces)).digest("hex");
}

export function authoritativeAccount(
  info,
  expected,
  canonicalHome,
  environmentHome,
) {
  requireValue(
    /^rushes-qa-[a-z0-9]{3,12}$/.test(info.username) &&
      info.username === expected.username &&
      info.homedir === canonicalHome &&
      expected.home === canonicalHome &&
      (!environmentHome || environmentHome === info.homedir),
    "Dedicated identity must use the real OS account home, never an environment override.",
  );
}
