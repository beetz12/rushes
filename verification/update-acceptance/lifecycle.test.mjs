import * as lifecycleCases from "node:test";
import checks from "node:assert/strict";
import { retireCreatedApplication } from "./lifecycle.mjs";
lifecycleCases.test(
  "clean owned app Quit joins retirement without signals",
  async () => {
    const signals = [];
    const result = await retireCreatedApplication(
      { close: async () => {} },
      { members: async () => [], signal: async (m) => signals.push(m) },
    );
    checks.deepEqual(result, { retired: true });
    checks.deepEqual(signals, []);
  },
);
lifecycleCases.test(
  "rejected launch/close still retires only returned owned members and stays failed",
  async () => {
    let live = [{ pid: 12345, uid: 42, command: "owned-fixture" }];
    const signals = [];
    await checks.rejects(
      retireCreatedApplication(
        {
          close: async () => {
            throw new Error("injected launch failure");
          },
        },
        {
          members: async () => live,
          signal: async (member, signal) => {
            signals.push({ member, signal });
            live = [];
          },
        },
      ),
      /injected/,
    );
    checks.equal(signals.length, 1);
    checks.equal(signals[0].signal, "SIGTERM");
  },
);
lifecycleCases.test(
  "a hanging close is bounded and an unretired fixture cannot report success",
  async () => {
    await checks.rejects(
      retireCreatedApplication(
        { close: () => new Promise(() => {}) },
        { members: async () => [{ pid: 12345 }], signal: async () => {} },
        { close: 1, term: 1, kill: 1 },
      ),
      /unconfirmed/,
    );
  },
);
