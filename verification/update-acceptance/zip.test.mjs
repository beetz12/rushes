import * as archiveCases from "node:test";
import checks from "node:assert/strict";
import * as archiveDisk from "node:fs/promises";
import * as archiveHost from "node:os";
import * as archivePaths from "node:path";
import * as archiveChildren from "node:child_process";
import { fileURLToPath } from "node:url";
archiveCases.test(
  "ZIP preflight rejects escaping links before any extraction while accepting internal framework links",
  async (t) => {
    const root = await archiveDisk.mkdtemp(
      archivePaths.join(archiveHost.tmpdir(), "archive-guard-"),
    );
    t.after(() => archiveDisk.rm(root, { recursive: true, force: true }));
    const script = fileURLToPath(new URL("./zip_inspect.py", import.meta.url));
    const create = `import sys,zipfile,stat\np,target=sys.argv[1:]\nwith zipfile.ZipFile(p,'w') as z:\n z.writestr('Rushes.app/Contents/Info.plist','generated metadata')\n link=zipfile.ZipInfo('Rushes.app/Contents/Frameworks/Current');link.create_system=3;link.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(link,target)\n`;
    for (const [target, success] of [
      ["Versions/A", true],
      ["../../../../outside", false],
      ["/Applications/Rushes.app", false],
    ]) {
      const zip = archivePaths.join(
        root,
        `fixture-${success ? "good" : Math.random()}.zip`,
      );
      const made = archiveChildren.spawnSync(
        "python3",
        ["-c", create, zip, target],
        { encoding: "utf8" },
      );
      checks.equal(made.status, 0, made.stderr);
      const measured = archiveChildren.spawnSync("python3", [script, zip], {
        encoding: "utf8",
      });
      checks.equal(measured.status, success ? 0 : 1, measured.stdout);
      checks.equal(JSON.parse(measured.stdout).productionAccepted, false);
    }
    checks.equal((await archiveDisk.readdir(root)).length, 3);
  },
);

archiveCases.test(
  "ZIP chains cannot escape the app via internal links followed by dot-dot",
  async (t) => {
    const root = await archiveDisk.mkdtemp(
      archivePaths.join(archiveHost.tmpdir(), "archive-chain-"),
    );
    t.after(() => archiveDisk.rm(root, { recursive: true, force: true }));
    const zip = archivePaths.join(root, "chain.zip");
    const create = `import zipfile,stat,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('Rushes.app/Contents/Info.plist','generated')\n for name,target in [('Rushes.app/A/B','../dir'),('Rushes.app/link','A/B/../../outside')]:\n  link=zipfile.ZipInfo(name);link.create_system=3;link.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(link,target)\n`;
    const made = archiveChildren.spawnSync("python3", ["-c", create, zip], {
      encoding: "utf8",
    });
    checks.equal(made.status, 0, made.stderr);
    const inspected = archiveChildren.spawnSync(
      "python3",
      [fileURLToPath(new URL("./zip_inspect.py", import.meta.url)), zip],
      { encoding: "utf8" },
    );
    checks.equal(inspected.status, 1);
    checks.match(inspected.stdout, /chained link/);
  },
);
