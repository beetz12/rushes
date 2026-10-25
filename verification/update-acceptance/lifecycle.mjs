import { setTimeout as wait } from "node:timers/promises";
import { requireValue } from "./policy.mjs";

// The caller supplies only its freshly rechecked owned app-path/UID members.
// This helper cannot qualify an installer or transition; it only retires them.
export async function retireCreatedApplication(
  application,
  ports,
  budgets = { close: 15000, term: 10000, kill: 5000 },
) {
  requireValue(
    Object.values(budgets).every(
      (value) => Number.isFinite(value) && value > 0 && value <= 30000,
    ),
    "Finite application retirement budgets required.",
  );
  let closeError, timer;
  try {
    await Promise.race([
      application?.close(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Owned app Quit deadline exceeded.")),
          budgets.close,
        );
      }),
    ]);
  } catch (error) {
    closeError = error;
  } finally {
    clearTimeout(timer);
  }
  const empty = async (budget) => {
    const end = Date.now() + budget;
    do {
      if (!(await ports.members()).length) return true;
      await wait(Math.min(100, Math.max(1, end - Date.now())));
    } while (Date.now() < end);
    return false;
  };
  if (!closeError && (await empty(budgets.term))) return { retired: true };
  let members = await ports.members();
  if (members.length) {
    closeError ??= new Error("Owned app Quit retained processes.");
    for (const member of members) await ports.signal(member, "SIGTERM");
    if (!(await empty(budgets.term))) {
      members = await ports.members();
      for (const member of members) await ports.signal(member, "SIGKILL");
      requireValue(
        await empty(budgets.kill),
        "Owned process retirement is unconfirmed; preserve the case and stop.",
      );
    }
  }
  if (closeError) throw closeError;
  return { retired: true };
}
