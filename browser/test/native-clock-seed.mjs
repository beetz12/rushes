// Test-only scalar source. Timestamp is Chromium TimeTicks::Now in seconds;
// it is not a media phase estimate or a callback-arrival correction.
import { randomUUID } from 'node:crypto';

export function timestampSeed(metrics) {
  const rows = Array.isArray(metrics) ? metrics.filter(row => row?.name === 'Timestamp') : [];
  const seconds = rows?.length === 1 ? rows[0].value : undefined;
  const timestampUs = Math.round(seconds * 1e6);
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 60
    || !Number.isSafeInteger(timestampUs) || !Number.isSafeInteger(timestampUs + 1000000))
    throw new Error('Expected one finite native Timestamp with safe microsecond headroom');
  return timestampUs;
}

export async function nativeClockSeed(page) {
  const token = randomUUID(), begun = performance.now(), errors = [];
  let session, seed, retiring = false;
  const step = async (operation, label) => {
    let timer;
    try { return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Native clock ${label} timed out`)), Math.max(1, 1500 - (performance.now() - begun)));
    })]); } finally { clearTimeout(timer); }
  };
  try {
    const before = await step(page.evaluate(token => {
      globalThis.__rushesNativeClockOwner = token;
      return { token, timeOrigin: performance.timeOrigin, pageMs: performance.now() };
    }, token), 'document identity');
    const opening = page.context().newCDPSession(page).then(async candidate => {
      if (retiring) { await candidate.detach(); return undefined; }
      session = candidate; return candidate;
    });
    // A late-created session belongs to this failed attempt too. The caller
    // closes its owned browser on failure; this handler also retires the session.
    opening.catch(error => errors.push(error));
    await step(opening, 'page session');
    await step(session.send('Performance.enable', { timeDomain: 'timeTicks' }), 'enable');
    const response = await step(session.send('Performance.getMetrics'), 'metrics');
    const timestampUs = timestampSeed(response.metrics);
    const after = await step(page.evaluate(() => ({ token: globalThis.__rushesNativeClockOwner,
      timeOrigin: performance.timeOrigin, pageMs: performance.now() })), 'document read-back');
    if (before.token !== after.token || before.timeOrigin !== after.timeOrigin
      || !Number.isFinite(after.pageMs) || after.pageMs < before.pageMs || after.pageMs - before.pageMs > 1500)
      throw new Error('Native clock document changed or sampling exceeded1500ms');
    seed = { kind: 'chromium-cdp-timeticks', timestampUs, token, timeOrigin: after.timeOrigin,
      beforePageMs: before.pageMs, afterPageMs: after.pageMs };
  } catch (error) { errors.push(error); }
  finally {
    retiring = true;
    // Each retirement is attempted independently even when the sampling budget
    // expired. No test recording begins until both acknowledgments arrive.
    if (session) {
      for (const [operation, label] of [[() => session.send('Performance.disable'), 'disable'], [() => session.detach(), 'detach']]) {
        let timer;
        try { await Promise.race([operation(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Native clock ${label} timed out`)), 1500);
        })]); } catch (error) { errors.push(error); } finally { clearTimeout(timer); }
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Native clock seed acquisition failed');
  return seed;
}
