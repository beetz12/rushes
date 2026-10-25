#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runCLI } from "./update-acceptance/observer.mjs";
try {
  console.log(
    JSON.stringify(
      await runCLI(
        process.argv.slice(2),
        resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      ),
    ),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      status: "unverified",
      productionAccepted: false,
      updateTransitionQualified: false,
      reason: error.message,
    }),
  );
  process.exitCode = 1;
}
