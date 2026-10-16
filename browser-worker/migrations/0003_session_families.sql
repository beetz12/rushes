-- Old tokens have no trustworthy family lineage. Revoke them once on upgrade.
-- Deploy before the family-aware Worker; a fresh Google sign-in creates a newfamily.
CREATE TABLE IF NOT EXISTS session_families (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), current_token_hash TEXT NOT NULL,
 absolute_expiry INTEGER NOT NULL, revoked_at INTEGER
);
ALTER TABLE sessions ADD COLUMN family_id TEXT REFERENCES session_families(id);
UPDATE sessions SET revoked_at=COALESCE(revoked_at,CAST(strftime('%s','now') AS INTEGER)*1000) WHERE family_id IS NULL;
CREATE INDEX IF NOT EXISTS sessions_family ON sessions(family_id);
CREATE TRIGGER IF NOT EXISTS session_family_required BEFORE INSERT ON sessions BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM session_families WHERE id=NEW.family_id AND account_id=NEW.account_id AND current_token_hash=NEW.token_hash AND revoked_at IS NULL AND absolute_expiry>=NEW.absolute_expiry) THEN RAISE(ABORT,'SESSION_FAMILY_REQUIRED') END;
END;
CREATE TRIGGER IF NOT EXISTS session_lineage_immutable BEFORE UPDATE OF token_hash,account_id,family_id ON sessions BEGIN
 SELECT CASE WHEN NEW.token_hash!=OLD.token_hash OR NEW.account_id!=OLD.account_id OR NEW.family_id IS NOT OLD.family_id THEN RAISE(ABORT,'SESSION_LINEAGE_IMMUTABLE') END;
END;
