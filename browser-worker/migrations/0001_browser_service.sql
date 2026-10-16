PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS tenants (
 id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'none' CHECK(status IN ('none','active','past_due','canceled','suspended')),
 stripe_customer TEXT UNIQUE, paid_through INTEGER, grace_through INTEGER,
 suspended_by_operator INTEGER NOT NULL DEFAULT 0 CHECK(suspended_by_operator IN (0,1)),
 period_start INTEGER NOT NULL, period_end INTEGER NOT NULL,
 retained_seconds INTEGER NOT NULL DEFAULT 0 CHECK(retained_seconds>=0),
 reserved_retained_seconds INTEGER NOT NULL DEFAULT 0 CHECK(reserved_retained_seconds>=0),
 raw_bytes INTEGER NOT NULL DEFAULT 0 CHECK(raw_bytes>=0), reserved_raw_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_raw_bytes>=0),
 billing_lock TEXT, billing_lock_until INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id),
 google_subject TEXT NOT NULL UNIQUE, email TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), csrf_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, absolute_expiry INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS oauth_states (
 state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limits (
 key TEXT NOT NULL, window INTEGER NOT NULL, attempts INTEGER NOT NULL, PRIMARY KEY(key,window)
);
CREATE TABLE IF NOT EXISTS quota_periods (
 tenant_id TEXT NOT NULL REFERENCES tenants(id), period_start INTEGER NOT NULL,
 upload_seconds INTEGER NOT NULL DEFAULT 0 CHECK(upload_seconds>=0), reserved_seconds INTEGER NOT NULL DEFAULT 0 CHECK(reserved_seconds>=0),
 delivery_seconds INTEGER NOT NULL DEFAULT 0 CHECK(delivery_seconds>=0), PRIMARY KEY(tenant_id,period_start)
);
CREATE TABLE IF NOT EXISTS recordings (
 id TEXT NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id), client_id TEXT NOT NULL, title TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('screen','camera','screen-camera')),
 state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','uploading','processing','ready','failed','deleting','deleted')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0,
 manifest TEXT, finalize_hash TEXT, composed_bytes INTEGER, composed_digest TEXT, composed_mime TEXT,
 stream_uid TEXT UNIQUE, upload_url TEXT, upload_expiry INTEGER, error TEXT, cleanup_error TEXT,
 provision_id TEXT, provision_until INTEGER, raw_expired INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,client_id)
);
CREATE INDEX IF NOT EXISTS recording_cleanup ON recordings(state,updated_at);
CREATE TABLE IF NOT EXISTS chunks (
 tenant_id TEXT NOT NULL, recording_id TEXT NOT NULL, track TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>=0 AND sequence<10000), bytes INTEGER NOT NULL CHECK(bytes>0 AND bytes<=16777216),
 digest TEXT NOT NULL, mime TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('granted','stored')),
 expires_at INTEGER NOT NULL, stored_at INTEGER, checkpoint_ms INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,recording_id,track,sequence),
 FOREIGN KEY(tenant_id,recording_id) REFERENCES recordings(tenant_id,id)
);
CREATE TRIGGER IF NOT EXISTS chunk_capacity BEFORE INSERT ON chunks BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM tenants WHERE id=NEW.tenant_id AND status='active' AND suspended_by_operator=0 AND paid_through>NEW.expires_at-900000) THEN RAISE(ABORT,'SUBSCRIPTION_REQUIRED') END;
 SELECT CASE WHEN (SELECT raw_bytes+reserved_raw_bytes FROM tenants WHERE id=NEW.tenant_id)+NEW.bytes>2147483648 THEN RAISE(ABORT,'RAW_QUOTA') END;
 SELECT CASE WHEN (SELECT state FROM recordings WHERE tenant_id=NEW.tenant_id AND id=NEW.recording_id)!='draft' THEN RAISE(ABORT,'RECORDING_CLOSED') END;
END;
CREATE TRIGGER IF NOT EXISTS chunk_reserved AFTER INSERT ON chunks BEGIN
 UPDATE tenants SET reserved_raw_bytes=reserved_raw_bytes+NEW.bytes WHERE id=NEW.tenant_id;
END;
CREATE TRIGGER IF NOT EXISTS chunk_immutable BEFORE UPDATE ON chunks BEGIN
 SELECT CASE WHEN OLD.tenant_id!=NEW.tenant_id OR OLD.recording_id!=NEW.recording_id OR OLD.track!=NEW.track OR OLD.sequence!=NEW.sequence OR OLD.bytes!=NEW.bytes OR OLD.digest!=NEW.digest OR OLD.mime!=NEW.mime THEN RAISE(ABORT,'CHUNK_CONFLICT') END;
 SELECT CASE WHEN OLD.state='stored' AND NEW.state!='stored' THEN RAISE(ABORT,'CHUNK_CONFLICT') END;
END;
CREATE TRIGGER IF NOT EXISTS chunk_accepted AFTER UPDATE OF state ON chunks WHEN OLD.state='granted' AND NEW.state='stored' BEGIN
 UPDATE tenants SET reserved_raw_bytes=reserved_raw_bytes-NEW.bytes,raw_bytes=raw_bytes+NEW.bytes WHERE id=NEW.tenant_id;
END;
CREATE TRIGGER IF NOT EXISTS chunk_released AFTER DELETE ON chunks BEGIN
 UPDATE tenants SET reserved_raw_bytes=reserved_raw_bytes-CASE WHEN OLD.state='granted' THEN OLD.bytes ELSE 0 END,
 raw_bytes=raw_bytes-CASE WHEN OLD.state='stored' THEN OLD.bytes ELSE 0 END WHERE id=OLD.tenant_id;
END;
CREATE TABLE IF NOT EXISTS upload_reservations (
 tenant_id TEXT NOT NULL, recording_id TEXT NOT NULL, period_start INTEGER NOT NULL, reserved_seconds INTEGER NOT NULL CHECK(reserved_seconds=600),
 actual_seconds INTEGER, state TEXT NOT NULL CHECK(state IN ('reserved','settled','released')), expires_at INTEGER NOT NULL,
 PRIMARY KEY(tenant_id,recording_id), FOREIGN KEY(tenant_id,recording_id) REFERENCES recordings(tenant_id,id),
 FOREIGN KEY(tenant_id,period_start) REFERENCES quota_periods(tenant_id,period_start)
);
CREATE TRIGGER IF NOT EXISTS upload_capacity BEFORE INSERT ON upload_reservations BEGIN
 SELECT CASE WHEN (SELECT state FROM recordings WHERE tenant_id=NEW.tenant_id AND id=NEW.recording_id)!='draft' THEN RAISE(ABORT,'RECORDING_CLOSED') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM tenants WHERE id=NEW.tenant_id AND status='active' AND suspended_by_operator=0 AND paid_through>NEW.expires_at-86400000) THEN RAISE(ABORT,'SUBSCRIPTION_REQUIRED') END;
 SELECT CASE WHEN NEW.state!='reserved' THEN RAISE(ABORT,'INVALID_RESERVATION') END;
 SELECT CASE WHEN (SELECT upload_seconds+reserved_seconds FROM quota_periods WHERE tenant_id=NEW.tenant_id AND period_start=NEW.period_start)+NEW.reserved_seconds>6000 THEN RAISE(ABORT,'UPLOAD_QUOTA') END;
 SELECT CASE WHEN (SELECT retained_seconds+reserved_retained_seconds FROM tenants WHERE id=NEW.tenant_id)+NEW.reserved_seconds>18000 THEN RAISE(ABORT,'RETAINED_QUOTA') END;
END;
CREATE TRIGGER IF NOT EXISTS upload_reserved AFTER INSERT ON upload_reservations BEGIN
 UPDATE quota_periods SET reserved_seconds=reserved_seconds+NEW.reserved_seconds WHERE tenant_id=NEW.tenant_id AND period_start=NEW.period_start;
 UPDATE tenants SET reserved_retained_seconds=reserved_retained_seconds+NEW.reserved_seconds WHERE id=NEW.tenant_id;
END;
CREATE TRIGGER IF NOT EXISTS upload_immutable BEFORE UPDATE ON upload_reservations BEGIN
 SELECT CASE WHEN OLD.tenant_id!=NEW.tenant_id OR OLD.recording_id!=NEW.recording_id OR OLD.period_start!=NEW.period_start OR OLD.reserved_seconds!=NEW.reserved_seconds OR OLD.state!='reserved' OR (NEW.state='reserved' AND NEW.actual_seconds IS NOT OLD.actual_seconds) OR (NEW.state='settled' AND (NEW.actual_seconds IS NULL OR NEW.actual_seconds<=0 OR NEW.actual_seconds>NEW.reserved_seconds)) THEN RAISE(ABORT,'INVALID_RESERVATION') END;
END;
CREATE TRIGGER IF NOT EXISTS upload_settled AFTER UPDATE OF state ON upload_reservations BEGIN
 UPDATE quota_periods SET reserved_seconds=reserved_seconds-OLD.reserved_seconds,
 upload_seconds=upload_seconds+CASE WHEN NEW.state='settled' THEN NEW.actual_seconds ELSE 0 END WHERE tenant_id=NEW.tenant_id AND period_start=NEW.period_start;
 UPDATE tenants SET reserved_retained_seconds=reserved_retained_seconds-OLD.reserved_seconds,
 retained_seconds=retained_seconds+CASE WHEN NEW.state='settled' THEN NEW.actual_seconds ELSE 0 END WHERE id=NEW.tenant_id;
END;
CREATE TABLE IF NOT EXISTS shares (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, recording_id TEXT NOT NULL,
 password_hash TEXT, password_salt TEXT, expires_at INTEGER, revoked_at INTEGER, policy_version INTEGER NOT NULL DEFAULT 1,
 FOREIGN KEY(tenant_id,recording_id) REFERENCES recordings(tenant_id,id), UNIQUE(tenant_id,recording_id)
);
CREATE TABLE IF NOT EXISTS deliveries (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, recording_id TEXT NOT NULL, viewer_hash TEXT NOT NULL,
 period_start INTEGER NOT NULL, seconds INTEGER NOT NULL CHECK(seconds>0), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
 budget_month INTEGER NOT NULL, issued INTEGER NOT NULL DEFAULT 0 CHECK(issued IN (0,1)),
 FOREIGN KEY(tenant_id,recording_id) REFERENCES recordings(tenant_id,id),
 FOREIGN KEY(tenant_id,period_start) REFERENCES quota_periods(tenant_id,period_start)
);
CREATE INDEX IF NOT EXISTS delivery_viewer ON deliveries(tenant_id,recording_id,viewer_hash,expires_at);
CREATE TRIGGER IF NOT EXISTS delivery_capacity BEFORE INSERT ON deliveries BEGIN
 SELECT CASE WHEN (SELECT state FROM recordings WHERE tenant_id=NEW.tenant_id AND id=NEW.recording_id)!='ready' THEN RAISE(ABORT,'RECORDING_CLOSED') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM tenants WHERE id=NEW.tenant_id AND status!='suspended' AND suspended_by_operator=0 AND ((status='active' AND paid_through>NEW.created_at) OR grace_through>NEW.created_at)) THEN RAISE(ABORT,'SUBSCRIPTION_REQUIRED') END;
 SELECT CASE WHEN (SELECT delivery_seconds FROM quota_periods WHERE tenant_id=NEW.tenant_id AND period_start=NEW.period_start)+NEW.seconds>60000 THEN RAISE(ABORT,'DELIVERY_QUOTA') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM deliveries WHERE tenant_id=NEW.tenant_id AND expires_at>NEW.created_at)>=3 THEN RAISE(ABORT,'DELIVERY_CONCURRENCY') END;
END;
CREATE TRIGGER IF NOT EXISTS delivery_reserved AFTER INSERT ON deliveries BEGIN
 UPDATE quota_periods SET delivery_seconds=delivery_seconds+NEW.seconds WHERE tenant_id=NEW.tenant_id AND period_start=NEW.period_start;
END;
CREATE TABLE IF NOT EXISTS webhook_events (
 id TEXT PRIMARY KEY, event_type TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','processing','done')),
 claim TEXT, lease_until INTEGER, received_at INTEGER NOT NULL, completed_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS active_writes (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, recording_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
 FOREIGN KEY(tenant_id,recording_id) REFERENCES recordings(tenant_id,id)
);
CREATE TRIGGER IF NOT EXISTS active_write_authorized BEFORE INSERT ON active_writes BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM tenants WHERE id=NEW.tenant_id AND status='active' AND suspended_by_operator=0 AND paid_through>NEW.expires_at-86400000) THEN RAISE(ABORT,'SUBSCRIPTION_REQUIRED') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM active_writes WHERE tenant_id=NEW.tenant_id)>=3 THEN RAISE(ABORT,'RAW_CONCURRENCY') END;
 SELECT CASE WHEN (SELECT state FROM recordings WHERE tenant_id=NEW.tenant_id AND id=NEW.recording_id)!='draft' THEN RAISE(ABORT,'RECORDING_CLOSED') END;
END;
CREATE TABLE IF NOT EXISTS billing_risks (
 tenant_id TEXT NOT NULL REFERENCES tenants(id), charge_id TEXT NOT NULL, PRIMARY KEY(tenant_id,charge_id)
);
-- Application estimates are conservative reservations, not provider invoice counters.
CREATE TABLE IF NOT EXISTS budget_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), cap_cents INTEGER NOT NULL, warning_cents INTEGER NOT NULL, month_start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS budget_months (
 month_start INTEGER PRIMARY KEY, delivery_seconds INTEGER NOT NULL DEFAULT 0, operation_units INTEGER NOT NULL DEFAULT 0,
 raw_peak_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE VIEW IF NOT EXISTS budget_estimates AS SELECT m.month_start,
 500 + CAST((COALESCE((SELECT SUM(retained_seconds+reserved_retained_seconds) FROM tenants),0)+59999)/60000 AS INTEGER)*500
 + CAST((m.delivery_seconds+599)/600 AS INTEGER)
 + CAST((m.raw_peak_bytes*15+9999999999)/10000000000 AS INTEGER)
 + CAST((m.operation_units+99)/100 AS INTEGER) AS estimated_cents
 FROM budget_months m;
CREATE TRIGGER IF NOT EXISTS tenant_budget_capacity AFTER UPDATE OF reserved_retained_seconds,retained_seconds,reserved_raw_bytes,raw_bytes ON tenants
 WHEN NEW.retained_seconds+NEW.reserved_retained_seconds>OLD.retained_seconds+OLD.reserved_retained_seconds
 OR NEW.raw_bytes+NEW.reserved_raw_bytes>OLD.raw_bytes+OLD.reserved_raw_bytes BEGIN
 UPDATE budget_months SET raw_peak_bytes=MAX(raw_peak_bytes,COALESCE((SELECT SUM(raw_bytes+reserved_raw_bytes) FROM tenants),0))
 WHERE month_start=(SELECT month_start FROM budget_settings WHERE id=1);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM budget_settings WHERE id=1) THEN RAISE(ABORT,'BUDGET_NOT_CONFIGURED') END;
 SELECT CASE WHEN (SELECT estimated_cents FROM budget_estimates WHERE month_start=(SELECT month_start FROM budget_settings WHERE id=1))>(SELECT cap_cents FROM budget_settings WHERE id=1) THEN RAISE(ABORT,'APPLICATION_BUDGET') END;
END;
CREATE TRIGGER IF NOT EXISTS delivery_budget_reserved AFTER INSERT ON deliveries BEGIN
 UPDATE budget_months SET delivery_seconds=delivery_seconds+NEW.seconds WHERE month_start=(SELECT month_start FROM budget_settings WHERE id=1);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM budget_settings WHERE id=1) THEN RAISE(ABORT,'BUDGET_NOT_CONFIGURED') END;
 SELECT CASE WHEN (SELECT estimated_cents FROM budget_estimates WHERE month_start=(SELECT month_start FROM budget_settings WHERE id=1))>(SELECT cap_cents FROM budget_settings WHERE id=1) THEN RAISE(ABORT,'APPLICATION_BUDGET') END;
END;
CREATE TRIGGER IF NOT EXISTS operation_budget_capacity AFTER UPDATE OF operation_units ON budget_months WHEN NEW.operation_units>OLD.operation_units BEGIN
 SELECT CASE WHEN (SELECT estimated_cents FROM budget_estimates WHERE month_start=NEW.month_start)>(SELECT cap_cents FROM budget_settings WHERE id=1) THEN RAISE(ABORT,'APPLICATION_BUDGET') END;
END;

CREATE TRIGGER IF NOT EXISTS undelivered_released AFTER DELETE ON deliveries WHEN OLD.issued=0 BEGIN
 UPDATE quota_periods SET delivery_seconds=delivery_seconds-OLD.seconds WHERE tenant_id=OLD.tenant_id AND period_start=OLD.period_start;
 UPDATE budget_months SET delivery_seconds=delivery_seconds-OLD.seconds WHERE month_start=OLD.budget_month;
END;
