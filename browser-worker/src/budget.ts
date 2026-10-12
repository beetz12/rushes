import { Config, Env, needDB, month, quotaFailure } from './platform';

export async function prepareBudget(c: Config, env: Env, now: number) {
  const db = needDB(env),
    period = month(now).start;
  await db.batch([
    db
      .prepare(
        'INSERT INTO budget_months(month_start,raw_peak_bytes) SELECT ?,COALESCE(SUM(raw_bytes+reserved_raw_bytes),0) FROM tenants WHERE 1 ON CONFLICT DO NOTHING',
      )
      .bind(period),
    db
      .prepare(
        'INSERT INTO budget_settings(id,cap_cents,warning_cents,month_start) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET cap_cents=excluded.cap_cents,warning_cents=excluded.warning_cents,month_start=MAX(budget_settings.month_start,excluded.month_start)',
      )
      .bind(Math.round(c.PILOT_BUDGET_USD * 100), Math.round(c.PILOT_WARNING_USD * 100), period),
  ]);
}
export async function reserveOperation(c: Config, env: Env, now: number) {
  await prepareBudget(c, env, now);
  try {
    await needDB(env)
      .prepare('UPDATE budget_months SET operation_units=operation_units+1 WHERE month_start=?')
      .bind(month(now).start)
      .run();
  } catch (error) {
    quotaFailure(error);
  }
}
export async function budgetSnapshot(c: Config, env: Env, now: number) {
  await prepareBudget(c, env, now);
  const row = await needDB(env)
    .prepare('SELECT estimated_cents FROM budget_estimates WHERE month_start=?')
    .bind(month(now).start)
    .first<{ estimated_cents: number }>();
  return {
    model: 'application-reserve',
    estimatedUSD: (row?.estimated_cents ?? 500) / 100,
    limitUSD: c.PILOT_BUDGET_USD,
    warning: (row?.estimated_cents ?? 500) >= c.PILOT_WARNING_USD * 100,
  };
}
