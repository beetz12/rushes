-- Apply to an existing browser database before deploying the repaired Worker.
-- Export first. This rebuilds the application reserve, never a provider invoice.
DROP TRIGGER IF EXISTS delivery_budget_reserved;
INSERT INTO budget_months(month_start) SELECT DISTINCT budget_month FROM deliveries WHERE 1 ON CONFLICT DO NOTHING;
UPDATE budget_months SET delivery_seconds=COALESCE((SELECT SUM(seconds) FROM deliveries WHERE budget_month=budget_months.month_start),0);
CREATE TRIGGER IF NOT EXISTS delivery_budget_reserved AFTER INSERT ON deliveries BEGIN
 UPDATE budget_months SET delivery_seconds=delivery_seconds+NEW.seconds WHERE month_start=NEW.budget_month;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM budget_settings WHERE id=1) OR NOT EXISTS(SELECT 1 FROM budget_months WHERE month_start=NEW.budget_month) THEN RAISE(ABORT,'BUDGET_NOT_CONFIGURED') END;
 SELECT CASE WHEN (SELECT estimated_cents FROM budget_estimates WHERE month_start=NEW.budget_month)>(SELECT cap_cents FROM budget_settings WHERE id=1) THEN RAISE(ABORT,'APPLICATION_BUDGET') END;
END;
CREATE TRIGGER IF NOT EXISTS delivery_month_required BEFORE INSERT ON deliveries BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM budget_months WHERE month_start=NEW.budget_month) OR NEW.created_at<NEW.budget_month OR NEW.created_at>=CAST(strftime('%s',datetime(NEW.budget_month/1000,'unixepoch','+1 month')) AS INTEGER)*1000 THEN RAISE(ABORT,'INVALID_BUDGET_MONTH') END;
END;
CREATE TRIGGER IF NOT EXISTS budget_nonnegative_insert BEFORE INSERT ON budget_months BEGIN
 SELECT CASE WHEN NEW.delivery_seconds<0 OR NEW.operation_units<0 OR NEW.raw_peak_bytes<0 THEN RAISE(ABORT,'INVALID_BUDGET_LEDGER') END;
END;
CREATE TRIGGER IF NOT EXISTS budget_nonnegative_update BEFORE UPDATE ON budget_months BEGIN
 SELECT CASE WHEN NEW.delivery_seconds<0 OR NEW.operation_units<0 OR NEW.raw_peak_bytes<0 OR NEW.month_start!=OLD.month_start THEN RAISE(ABORT,'INVALID_BUDGET_LEDGER') END;
END;
