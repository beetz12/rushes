PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, expires_at TEXT, password_salt TEXT, password_hash TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS shares_expiry ON shares(expires_at);
CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, r2_id TEXT NOT NULL, share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE, file TEXT NOT NULL, bytes INTEGER NOT NULL, content_type TEXT NOT NULL, sha256 TEXT NOT NULL, parts TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'uploading', UNIQUE(share_id,file));
CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE, name TEXT NOT NULL, body TEXT NOT NULL, timestamp_ms INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reactions (share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE, session TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(share_id,session,kind));
CREATE TABLE IF NOT EXISTS plays (share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE, session TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(share_id,session));
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(key,window));
CREATE TABLE IF NOT EXISTS upload_parts (upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE, part_number INTEGER NOT NULL, etag TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(upload_id,part_number));
