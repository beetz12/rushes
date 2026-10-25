import * as harnessCases from "node:test";
import assertions from "node:assert/strict";
import * as disk from "node:fs/promises";
import * as testHost from "node:os";
import * as testPaths from "node:path";
import * as fixtureCrypto from "node:crypto";
import {
  compareVersions,
  signature,
  zipEntries,
  tree,
  sameTree,
  verifyObserver,
  inputs,
  executableContent,
  authoritativeAccount,
  boundedJSON,
} from "./policy.mjs";
const good =
  "Identifier=com.nexai.rushes\nTeamIdentifier=ABCDEFGHIJ\nAuthority=Developer ID Application: Generated only\nCodeDirectory v=20500 size=444 flags=0x10000(runtime) hashes=3+7 location=embedded\nTimestamp=Oct 24, 2026\n";
harnessCases.test(
  "strict monotonic releases reject downgrade, equal, invalid and unsafe versions",
  () => {
    assertions.equal(compareVersions("0.1.2", "0.1.3"), -1);
    assertions.equal(compareVersions("2.0.0", "1.9.9"), 1);
    for (const value of ["01.2.3", "1.2.3-beta", "1.2.9007199254740992", "1.2"])
      assertions.throws(() => compareVersions(value, "1.2.3"));
  },
);
harnessCases.test(
  "signing predicate rejects development, wrong team/identifier, missing runtime and timestamp",
  () => {
    signature(good, "ABCDEFGHIJ", "com.nexai.rushes");
    for (const [a, b] of [
      ["Identifier=com.nexai.rushes", "Identifier=com.nexai.rushes.other"],
      ["TeamIdentifier=ABCDEFGHIJ", "TeamIdentifier=ABCDEFGHIJMORE"],
      ["Developer ID Application:", "Apple Development:"],
      ["flags=0x10000(runtime)", "flags=0"],
      ["Timestamp=Oct 24, 2026", "Timestamp=none"],
    ])
      assertions.throws(() =>
        signature(good.replace(a, b), "ABCDEFGHIJ", "com.nexai.rushes"),
      );
  },
);
harnessCases.test("ZIP paths refuse traversal and foreign bundles", () => {
  assertions.equal(zipEntries("Rushes.app/Contents/Info.plist\n").length, 1);
  for (const entry of [
    "/Rushes.app/a",
    "Rushes.app/../outside",
    "Other.app/a",
    "Rushes.app\\outside",
    "Rushes.app/./a",
  ])
    assertions.throws(() => zipEntries(entry));
});
harnessCases.test(
  "payload comparison uses real bytes and refuses escaping links",
  async (t) => {
    const base = await disk.mkdtemp(
      testPaths.join(testHost.tmpdir(), "update-policy-"),
    );
    t.after(() => disk.rm(base, { recursive: true, force: true }));
    const a = testPaths.join(base, "a"),
      b = testPaths.join(base, "b");
    await disk.mkdir(a);
    await disk.mkdir(b);
    await disk.writeFile(testPaths.join(a, "state"), "original");
    await disk.writeFile(testPaths.join(b, "state"), "original");
    sameTree(await tree(a), await tree(b));
    await disk.writeFile(testPaths.join(b, "state"), "changed");
    const expected = await tree(a),
      observed = await tree(b);
    assertions.throws(() => sameTree(expected, observed));
    await disk.symlink("/etc/passwd", testPaths.join(a, "escape"));
    await assertions.rejects(tree(a), /escapes/);
  },
);
harnessCases.test(
  "arbitrary/generated receipt cannot become a real transition even with a syntactically valid signature",
  () => {
    const keys = fixtureCrypto.generateKeyPairSync("ed25519"),
      bytes = Buffer.from(
        JSON.stringify({
          schema: "rushes.observed-update/1",
          provenance: "generated",
          cases: [],
        }),
      );
    assertions.throws(
      () =>
        verifyObserver(
          bytes,
          fixtureCrypto.sign(null, bytes, keys.privateKey),
          keys.publicKey.export({ type: "spki", format: "pem" }),
        ),
      /Generated/,
    );
    assertions.throws(
      () =>
        verifyObserver(
          Buffer.from("{}"),
          Buffer.alloc(64),
          keys.publicKey.export({ type: "spki", format: "pem" }),
        ),
      /seal/,
    );
  },
);
harnessCases.test(
  "missing metadata never silently selects a real user/data root",
  () => {
    assertions.throws(() =>
      inputs({ schema: "rushes.installed-update-inputs/1" }),
    );
    assertions.throws(() =>
      inputs({
        schema: "rushes.installed-update-inputs/1",
        expectedTeam: "ABCDEFGHIJ",
        account: { username: "qa", home: "/Users/qa" },
      }),
    );
  },
);

harnessCases.test(
  "compiled executable identity ignores signature replacement but detects code corruption",
  async (t) => {
    const directory = await disk.mkdtemp(
      testPaths.join(testHost.tmpdir(), "macho-policy-"),
    );
    t.after(() => disk.rm(directory, { recursive: true, force: true }));
    const bytes = Buffer.alloc(224);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x100000c, 4);
    bytes.writeUInt32LE(2, 12);
    bytes.writeUInt32LE(2, 16);
    bytes.writeUInt32LE(168, 20);
    bytes.writeUInt32LE(0x19, 32);
    bytes.writeUInt32LE(152, 36);
    bytes.write("__TEXT", 40);
    bytes.writeUInt32LE(1, 96);
    bytes.write("__text", 104);
    bytes.write("__TEXT", 120);
    bytes.writeBigUInt64LE(8n, 144);
    bytes.writeUInt32LE(200, 152);
    bytes.writeUInt32LE(0x1d, 184);
    bytes.writeUInt32LE(16, 188);
    bytes.writeUInt32LE(208, 192);
    bytes.writeUInt32LE(16, 196);
    bytes.write("REALCODE", 200);
    const a = testPaths.join(directory, "a"),
      b = testPaths.join(directory, "b");
    await disk.writeFile(a, bytes);
    bytes[208] = 42;
    await disk.writeFile(b, bytes);
    assertions.equal(await executableContent(a), await executableContent(b));
    bytes[200] ^= 1;
    await disk.writeFile(b, bytes);
    assertions.notEqual(await executableContent(a), await executableContent(b));
  },
);

harnessCases.test(
  "dedicated account identity cannot be redirected by HOME",
  () => {
    const info = { username: "rushes-qa-abc", homedir: "/Users/rushes-qa-abc" },
      expected = { username: info.username, home: info.homedir };
    authoritativeAccount(info, expected, info.homedir, info.homedir);
    assertions.throws(() =>
      authoritativeAccount(
        info,
        { ...expected, home: info.homedir + "/Shadow.noindex" },
        info.homedir,
        info.homedir + "/Shadow.noindex",
      ),
    );
  },
);

harnessCases.test(
  "runtime qualification needs the numeric bit and exact real CodeDirectory marker",
  () => {
    for (const value of [
      good.replace("0x10000(runtime)", "0x0(runtime)"),
      good.replace("0x10000(runtime)", "0x10000(runtime-ish)"),
      good +
        "CodeDirectory v=20500 size=444 flags=0x10000(runtime) hashes=3+7\n",
    ])
      assertions.throws(() =>
        signature(value, "ABCDEFGHIJ", "com.nexai.rushes"),
      );
  },
);

harnessCases.test(
  "bounded metadata rejects linked/oversized input and never echoes invalid content",
  async (t) => {
    const root = await disk.mkdtemp(
      testPaths.join(testHost.tmpdir(), "metadata-policy-"),
    );
    t.after(() => disk.rm(root, { recursive: true, force: true }));
    const actual = testPaths.join(root, "input.json");
    await disk.writeFile(actual, "GENERATED_PRIVATE_INPUT_MARKER");
    await assertions.rejects(
      boundedJSON(actual),
      (error) => !error.message.includes("GENERATED_PRIVATE_INPUT_MARKER"),
    );
    await disk.writeFile(actual, " ".repeat(100));
    await assertions.rejects(boundedJSON(actual, 10), /bound/);
    await disk.symlink(actual, testPaths.join(root, "linked.json"));
    await assertions.rejects(boundedJSON(testPaths.join(root, "linked.json")));
  },
);
harnessCases.test(
  "helper comparison excludes only UUID while retaining compiled and linker bytes",
  async (t) => {
    const root = await disk.mkdtemp(
      testPaths.join(testHost.tmpdir(), "helper-content-"),
    );
    t.after(() => disk.rm(root, { recursive: true, force: true }));
    const bytes = Buffer.alloc(256);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x100000c, 4);
    bytes.writeUInt32LE(2, 12);
    bytes.writeUInt32LE(3, 16);
    bytes.writeUInt32LE(192, 20);
    bytes.writeUInt32LE(0x19, 32);
    bytes.writeUInt32LE(152, 36);
    bytes.write("__TEXT", 40);
    bytes.writeUInt32LE(1, 96);
    bytes.write("__text", 104);
    bytes.write("__TEXT", 120);
    bytes.writeBigUInt64LE(8n, 144);
    bytes.writeUInt32LE(224, 152);
    bytes.writeUInt32LE(0x1b, 184);
    bytes.writeUInt32LE(24, 188);
    bytes.writeUInt32LE(0x1d, 208);
    bytes.writeUInt32LE(16, 212);
    bytes.writeUInt32LE(240, 216);
    bytes.writeUInt32LE(16, 220);
    bytes.write("CODETESTLINKMETA", 224);
    const a = testPaths.join(root, "a"),
      b = testPaths.join(root, "b");
    await disk.writeFile(a, bytes);
    bytes[192] = 42;
    await disk.writeFile(b, bytes);
    assertions.notEqual(await executableContent(a), await executableContent(b));
    assertions.equal(
      await executableContent(a, { ignoreUUID: true }),
      await executableContent(b, { ignoreUUID: true }),
    );
    bytes[236] ^= 1;
    await disk.writeFile(b, bytes);
    assertions.notEqual(
      await executableContent(a, { ignoreUUID: true }),
      await executableContent(b, { ignoreUUID: true }),
    );
  },
);

harnessCases.test(
  "payload dictionaries retain special filenames, empty directories and chained link safety",
  async (t) => {
    const root = await disk.mkdtemp(
      testPaths.join(testHost.tmpdir(), "payload-links-"),
    );
    t.after(() => disk.rm(root, { recursive: true, force: true }));
    await disk.writeFile(testPaths.join(root, "__proto__"), "original");
    await disk.mkdir(testPaths.join(root, "empty"));
    const before = await tree(root);
    assertions.equal(before["__proto__"].kind, "file");
    assertions.equal(before.empty.kind, "directory");
    await disk.mkdir(testPaths.join(root, "A"));
    await disk.mkdir(testPaths.join(root, "dir"));
    await disk.symlink("../dir", testPaths.join(root, "A/B"));
    await disk.symlink("A/B/../../outside", testPaths.join(root, "escape"));
    await assertions.rejects(tree(root), /escape/);
  },
);
