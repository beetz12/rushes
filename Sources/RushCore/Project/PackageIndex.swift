import Foundation
import SQLite3

/// The library index over the recordings root: `index.sqlite`
/// (docs/PLAN.md, Rules).
///
/// One row per package with id, folder, title, creation time, duration,
/// status, share URL and transcript state. The manifest is always the source
/// of truth: the index is a cache, and `rebuild(root:)` reconstructs it by
/// scanning the storage root for manifests. The database runs in write-ahead
/// logging mode so readers (list, library) never block the writer.
///
/// Implemented as a thin layer over the system SQLite3 C API; no third-party
/// dependency. An actor serializes every statement, so the handle never
/// crosses threads unguarded.
public actor PackageIndex {

    // SQLITE_TRANSIENT is not exposed to Swift; this is the standard
    // reinterpretation of the -1 destructor sentinel.
    private static let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    /// One package's index row.
    public struct Row: Codable, Equatable, Sendable {
        public let id: String
        /// Absolute path of the package folder.
        public let folder: String
        public let title: String?
        public let createdAt: String
        public let durationMs: Int64?
        public let status: String
        public let shareURL: String?
        public let transcriptState: String

        public init(
            id: String,
            folder: String,
            title: String? = nil,
            createdAt: String,
            durationMs: Int64? = nil,
            status: String,
            shareURL: String? = nil,
            transcriptState: String = "none"
        ) {
            self.id = id
            self.folder = folder
            self.title = title
            self.createdAt = createdAt
            self.durationMs = durationMs
            self.status = status
            self.shareURL = shareURL
            self.transcriptState = transcriptState
        }

        /// The row a manifest scan produces.
        public init(entry: RecordingPackage.ScanEntry) {
            let manifest = entry.manifest
            let durationMs = manifest.clock?.durationNs.map { $0 / 1_000_000 }
            self.init(
                id: manifest.id,
                folder: entry.package.folderURL.path,
                title: manifest.title,
                createdAt: manifest.createdAt ?? "",
                durationMs: durationMs,
                status: manifest.status.rawValue,
                shareURL: nil,
                transcriptState: "none")
        }
    }

    /// Index problems.
    public enum IndexError: Error, Equatable, Sendable, CustomStringConvertible {
        case openFailed(path: String, detail: String)
        case statementFailed(String, detail: String)

        public var description: String {
            switch self {
            case .openFailed(let path, let detail):
                return "could not open index at \(path): \(detail)"
            case .statementFailed(let sql, let detail):
                return "index statement failed (\(sql)): \(detail)"
            }
        }
    }

    /// `~/Library/Application Support/Rushes/index.sqlite`.
    public static var defaultDatabaseURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Rushes/index.sqlite")
    }

    public let databaseURL: URL

    // Confined to the actor. `nonisolated(unsafe)` lets deinit close the
    // handle; no statement is executing at deinit time by construction.
    private nonisolated(unsafe) var db: OpaquePointer?

    public init(databaseURL: URL = PackageIndex.defaultDatabaseURL) throws {
        self.databaseURL = databaseURL
        try FileManager.default.createDirectory(
            at: databaseURL.deletingLastPathComponent(), withIntermediateDirectories: true)

        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(databaseURL.path, &handle, flags, nil) == SQLITE_OK, let handle else {
            let detail = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "sqlite3_open_v2 failed"
            if let handle { sqlite3_close(handle) }
            throw IndexError.openFailed(path: databaseURL.path, detail: detail)
        }
        self.db = handle

        try Self.exec("PRAGMA journal_mode=WAL", on: handle)
        try Self.exec(
            """
            CREATE TABLE IF NOT EXISTS recordings (
                id TEXT PRIMARY KEY,
                folder TEXT NOT NULL UNIQUE,
                title TEXT,
                created_at TEXT NOT NULL DEFAULT '',
                duration_ms INTEGER,
                status TEXT NOT NULL DEFAULT 'failed',
                share_url TEXT,
                transcript_state TEXT NOT NULL DEFAULT 'none'
            )
            """, on: handle)
    }

    // MARK: - Reading and writing rows

    /// Inserts or updates one row.
    public func upsert(_ row: Row) throws {
        let sql = """
            INSERT INTO recordings
                (id, folder, title, created_at, duration_ms, status, share_url, transcript_state)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(id) DO UPDATE SET
                folder = excluded.folder,
                title = excluded.title,
                created_at = excluded.created_at,
                duration_ms = excluded.duration_ms,
                status = excluded.status,
                share_url = excluded.share_url,
                transcript_state = excluded.transcript_state
            """
        try Self.withStatement(sql, on: db) { statement in
            sqlite3_bind_text(statement, 1, row.id, -1, Self.sqliteTransient)
            sqlite3_bind_text(statement, 2, row.folder, -1, Self.sqliteTransient)
            Self.bindText(statement, index: 3, row.title)
            sqlite3_bind_text(statement, 4, row.createdAt, -1, Self.sqliteTransient)
            Self.bindInt64(statement, index: 5, row.durationMs)
            sqlite3_bind_text(statement, 6, row.status, -1, Self.sqliteTransient)
            Self.bindText(statement, index: 7, row.shareURL)
            sqlite3_bind_text(statement, 8, row.transcriptState, -1, Self.sqliteTransient)
            try Self.stepToDone(statement, sql: sql, on: db)
        }
    }

    /// The row for one recording id, if indexed.
    public func row(id: String) throws -> Row? {
        let sql = """
            SELECT id, folder, title, created_at, duration_ms, status, share_url, transcript_state
            FROM recordings WHERE id = ?1
            """
        return try Self.withStatement(sql, on: db) { statement in
            sqlite3_bind_text(statement, 1, id, -1, Self.sqliteTransient)
            if sqlite3_step(statement) == SQLITE_ROW {
                return Self.row(from: statement)
            }
            return nil
        }
    }

    /// Every row, newest first.
    public func allRows() throws -> [Row] {
        let sql = """
            SELECT id, folder, title, created_at, duration_ms, status, share_url, transcript_state
            FROM recordings ORDER BY created_at DESC, id ASC
            """
        return try Self.withStatement(sql, on: db) { statement in
            var rows: [Row] = []
            while sqlite3_step(statement) == SQLITE_ROW {
                rows.append(Self.row(from: statement))
            }
            return rows
        }
    }

    /// Removes one row.
    @discardableResult
    public func delete(id: String) throws -> Bool {
        let sql = "DELETE FROM recordings WHERE id = ?1"
        return try Self.withStatement(sql, on: db) { statement in
            sqlite3_bind_text(statement, 1, id, -1, Self.sqliteTransient)
            try Self.stepToDone(statement, sql: sql, on: db)
            return sqlite3_changes(db) > 0
        }
    }

    /// Replaces the whole table with `rows` in one transaction.
    public func replace(with rows: [Row]) throws {
        try Self.exec("BEGIN IMMEDIATE", on: db)
        do {
            try Self.exec("DELETE FROM recordings", on: db)
            for row in rows {
                try upsert(row)
            }
            try Self.exec("COMMIT", on: db)
        } catch {
            try? Self.exec("ROLLBACK", on: db)
            throw error
        }
    }

    /// Rebuilds the index from the manifests under `root` (voom idea: the
    /// index is a rebuildable cache). Returns the number of indexed
    /// packages. A missing root yields an empty index.
    @discardableResult
    public func rebuild(root: URL) throws -> Int {
        let entries = try RecordingPackage.scanManifests(root: root)
        let rows = entries.map(Row.init(entry:))
        try replace(with: rows)
        return rows.count
    }

    /// The active journal mode ("wal" after init).
    public func journalMode() throws -> String {
        let sql = "PRAGMA journal_mode"
        return try Self.withStatement(sql, on: db) { statement in
            guard sqlite3_step(statement) == SQLITE_ROW,
                  let text = sqlite3_column_text(statement, 0) else {
                throw IndexError.statementFailed(sql, detail: "no journal mode returned")
            }
            return String(cString: text)
        }
    }

    /// Closes the database. Statements after `close` throw.
    public func close() {
        if let db {
            sqlite3_close_v2(db)
            self.db = nil
        }
    }

    deinit {
        if let db { sqlite3_close_v2(db) }
    }

    // MARK: - SQLite plumbing
    //
    // The helpers are nonisolated and take the handle explicitly, so the
    // actor's (nonisolated) initializer can run them; every actor method
    // passes its own serialized handle.

    private nonisolated static func exec(_ sql: String, on db: OpaquePointer?) throws {
        var errorPointer: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &errorPointer) == SQLITE_OK else {
            let detail = errorPointer.map { String(cString: $0) } ?? "unknown error"
            sqlite3_free(errorPointer)
            throw IndexError.statementFailed(sql, detail: detail)
        }
    }

    /// Runs `body` with a prepared statement and always finalizes it.
    private nonisolated static func withStatement<T>(
        _ sql: String, on db: OpaquePointer?, _ body: (OpaquePointer) throws -> T
    ) throws -> T {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK,
              let statement else {
            throw IndexError.statementFailed(sql, detail: Self.errorMessage(db))
        }
        defer { sqlite3_finalize(statement) }
        return try body(statement)
    }

    private nonisolated static func stepToDone(
        _ statement: OpaquePointer, sql: String, on db: OpaquePointer?
    ) throws {
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw IndexError.statementFailed(sql, detail: Self.errorMessage(db))
        }
    }

    private nonisolated static func errorMessage(_ db: OpaquePointer?) -> String {
        db.map { String(cString: sqlite3_errmsg($0)) } ?? "database closed"
    }

    private nonisolated static func bindText(
        _ statement: OpaquePointer, index: Int32, _ value: String?
    ) {
        if let value {
            sqlite3_bind_text(statement, index, value, -1, sqliteTransient)
        } else {
            sqlite3_bind_null(statement, index)
        }
    }

    private nonisolated static func bindInt64(
        _ statement: OpaquePointer, index: Int32, _ value: Int64?
    ) {
        if let value {
            sqlite3_bind_int64(statement, index, value)
        } else {
            sqlite3_bind_null(statement, index)
        }
    }

    private nonisolated static func row(from statement: OpaquePointer) -> Row {
        func text(_ index: Int32) -> String? {
            guard let raw = sqlite3_column_text(statement, index) else { return nil }
            return String(cString: raw)
        }
        let durationMs = sqlite3_column_type(statement, 4) == SQLITE_NULL
            ? nil : sqlite3_column_int64(statement, 4)
        return Row(
            id: text(0) ?? "",
            folder: text(1) ?? "",
            title: text(2),
            createdAt: text(3) ?? "",
            durationMs: durationMs,
            status: text(5) ?? "failed",
            shareURL: text(6),
            transcriptState: text(7) ?? "none")
    }
}
