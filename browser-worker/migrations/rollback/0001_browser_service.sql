-- Manual schema rollback for the separate browser database only.
-- Export the database first; this removes data. Restore that export to recover it.
DROP VIEW IF EXISTS budget_estimates;
DROP TABLE IF EXISTS deliveries;
DROP TABLE IF EXISTS shares;
DROP TABLE IF EXISTS active_writes;
DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS upload_reservations;
DROP TABLE IF EXISTS recordings;
DROP TABLE IF EXISTS quota_periods;
DROP TABLE IF EXISTS webhook_events;
DROP TABLE IF EXISTS billing_risks;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS tenants;
DROP TABLE IF EXISTS oauth_states;
DROP TABLE IF EXISTS rate_limits;
DROP TABLE IF EXISTS budget_settings;
DROP TABLE IF EXISTS budget_months;
