import * as cases from "node:test";
import assertions from "node:assert/strict";
import * as fixtureDisk from "node:fs/promises";
import * as fixtureHost from "node:os";
import * as fixturePaths from "node:path";
import * as localHTTP from "node:http";
import * as fixtureCrypto from "node:crypto";
import { acceptanceFeed } from "./feed.mjs";
cases.test(
  "generated acceptance transport serves good, corrupt and interrupted bytes without changing artifacts",
  async (t) => {
    const root = await fixtureDisk.mkdtemp(
      fixturePaths.join(fixtureHost.tmpdir(), "acceptance-feed-"),
    );
    t.after(() => fixtureDisk.rm(root, { recursive: true, force: true }));
    const bytes = Buffer.alloc(65536, 42),
      name = "Rushes-0.1.3-arm64.zip";
    await fixtureDisk.writeFile(fixturePaths.join(root, name), bytes);
    const feed = acceptanceFeed({
        manifest: { files: [{ url: name, size: bytes.length }] },
        directory: root,
        token: "generated-control-token-".repeat(3),
      }),
      server = localHTTP.createServer(feed.handler);
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => new Promise((done) => server.close(done)));
    const base = `http://127.0.0.1:${server.address().port}`;
    assertions.equal((await fetch(base + "/latest-mac.json")).status, 503);
    assertions.equal(
      (
        await fetch(base + "/__acceptance__/scenario", {
          method: "POST",
          body: "{}",
        })
      ).status,
      403,
    );
    const select = async (scenario) => {
      const response = await fetch(base + "/__acceptance__/scenario", {
        method: "POST",
        headers: {
          authorization: "Bearer " + "generated-control-token-".repeat(3),
        },
        body: JSON.stringify({ scenario, runId: fixtureCrypto.randomUUID() }),
      });
      assertions.equal(response.status, 200);
    };
    await select("good");
    assertions.deepEqual(
      Buffer.from(await (await fetch(base + "/" + name)).arrayBuffer()),
      bytes,
    );
    await select("bad-digest");
    const altered = Buffer.from(
      await (await fetch(base + "/" + name)).arrayBuffer(),
    );
    assertions.notDeepEqual(altered, bytes);
    assertions.equal(altered.length, bytes.length);
    await select("interrupted");
    await assertions.rejects(async () => {
      const response = await fetch(base + "/" + name);
      await response.arrayBuffer();
    });
    assertions.deepEqual(
      await fixtureDisk.readFile(fixturePaths.join(root, name)),
      bytes,
    );
    assertions.equal((await fetch(base + "/../outside")).status, 404);
  },
);
