import { createReadStream } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { basename, join } from "node:path";
import { requireValue } from "./policy.mjs";

// The operator exposes this handler through an already reviewed HTTPS endpoint.
// It deliberately corrupts/cuts only acceptance ZIP responses, never signed bytes
// on disk. Running this generated service is not production/update proof.
export function acceptanceFeed({ manifest, directory, token, prefix = "/" }) {
  requireValue(
    typeof token === "string" && token.length >= 32,
    "Acceptance control token is too short.",
  );
  requireValue(
    prefix.startsWith("/") && prefix.endsWith("/") && !prefix.includes(".."),
    "Invalid acceptance path prefix.",
  );
  let scenario, runId;
  const requests = [];
  const authorized = (request) => {
    const supplied = Buffer.from(request.headers.authorization ?? ""),
      expected = Buffer.from("Bearer " + token);
    return (
      supplied.length === expected.length && timingSafeEqual(supplied, expected)
    );
  };
  const json = (response, status, value) => {
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(value));
  };
  const handler = async (request, response) => {
    try {
      const url = new URL(request.url, "http://acceptance.invalid");
      if (url.search || url.hash)
        return json(response, 400, { error: "Unexpected query" });
      if (url.pathname === prefix + "__acceptance__/scenario") {
        if (request.method !== "POST" || !authorized(request))
          return json(response, 403, { error: "Forbidden" });
        let bytes = 0,
          body = "";
        for await (const part of request) {
          bytes += part.length;
          if (bytes > 4096) {
            response.destroy();
            return;
          }
          body += part;
        }
        const value = JSON.parse(body);
        if (
          !["bad-digest", "interrupted", "busy", "good"].includes(
            value.scenario,
          ) ||
          !/^[0-9a-f-]{36}$/.test(value.runId)
        )
          return json(response, 400, { error: "Invalid scenario" });
        scenario = value.scenario;
        runId = value.runId;
        requests.length = 0;
        return json(response, 200, { scenario, runId });
      }
      if (request.method !== "GET" || !scenario)
        return json(response, 503, {
          error: "Acceptance scenario not selected",
        });
      if (url.pathname === prefix + "latest-mac.json")
        return json(response, 200, manifest);
      const selected = manifest.files.find(
        (member) => url.pathname === prefix + member.url,
      );
      if (!selected || basename(selected.url) !== selected.url)
        return json(response, 404, { error: "Unknown artifact" });
      requests.push({
        at: Date.now(),
        runId,
        scenario,
        artifact: selected.url,
      });
      response.writeHead(200, {
        "content-type": selected.url.endsWith(".zip")
          ? "application/zip"
          : "application/x-apple-diskimage",
        "content-length": selected.size,
        "cache-control": "no-store",
      });
      const stream = createReadStream(join(directory, selected.url));
      stream.on("error", () => response.destroy());
      response.on("close", () => stream.destroy());
      if (
        !selected.url.endsWith(".zip") ||
        scenario === "good" ||
        scenario === "busy"
      ) {
        stream.pipe(response);
        return;
      }
      let sent = 0;
      for await (let block of stream) {
        if (scenario === "bad-digest" && sent === 0) {
          block = Buffer.from(block);
          block[0] ^= 1;
        }
        if (
          scenario === "interrupted" &&
          sent + block.length >= Math.max(1, Math.floor(selected.size / 2))
        ) {
          response.write(
            block.subarray(
              0,
              Math.max(1, Math.floor(selected.size / 2) - sent),
            ),
          );
          response.destroy();
          stream.destroy();
          return;
        }
        sent += block.length;
        response.write(block);
      }
      response.end();
    } catch {
      if (!response.headersSent)
        json(response, 400, { error: "Invalid acceptance request" });
      else response.destroy();
    }
  };
  return { handler, observations: () => structuredClone(requests) };
}
