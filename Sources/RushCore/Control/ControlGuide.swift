import Foundation

/// The self-describing guide (`rushes guide --json`), built from the same
/// command table the engine serves (docs/PLAN.md, extensibility-automation:
/// "It has a self-describing `guide --json`"). Every command, its usage,
/// its parameters, the event types and the stable exit-code table, so an
/// agent that has never seen Rushes can drive it from this one object.
public struct ControlGuide: Codable, Equatable, Sendable {

    public static let schema = "rushes.guide/1"

    // MARK: - Doc types

    public struct ParamDoc: Codable, Equatable, Sendable {
        /// Socket argument name (camelCase) and CLI flag, when they differ.
        public var name: String
        public var flag: String?
        public var type: String
        public var required: Bool
        public var description: String

        public init(name: String, flag: String? = nil, type: String,
                    required: Bool = false, description: String) {
            self.name = name
            self.flag = flag
            self.type = type
            self.required = required
            self.description = description
        }
    }

    public struct CommandDoc: Codable, Equatable, Sendable {
        /// Socket command name (dot-separated) and the CLI spelling.
        public var name: String
        public var cli: [String]
        public var summary: String
        public var usage: String
        public var params: [ParamDoc]
        /// Shape of the successful `result` object, as prose.
        public var result: String

        public init(name: String, cli: [String], summary: String,
                    usage: String, params: [ParamDoc] = [], result: String) {
            self.name = name
            self.cli = cli
            self.summary = summary
            self.usage = usage
            self.params = params
            self.result = result
        }
    }

    public struct EventDoc: Codable, Equatable, Sendable {
        public var event: String
        public var fields: [String]
        public var description: String

        public init(event: String, fields: [String], description: String) {
            self.event = event
            self.fields = fields
            self.description = description
        }
    }

    public struct ExitDoc: Codable, Equatable, Sendable {
        public var code: Int
        public var name: String
        public var meaning: String

        public init(code: Int, name: String, meaning: String) {
            self.code = code
            self.name = name
            self.meaning = meaning
        }
    }

    // MARK: - Fields

    public var schema: String
    public var name: String
    public var version: String
    /// The control protocol revision this guide describes.
    public var protocolVersion: String
    public var socket: String
    public var commands: [CommandDoc]
    public var events: [EventDoc]
    public var exitCodes: [ExitDoc]

    // MARK: - Construction

    /// The full guide. `socketPath` is echoed so a reader knows where this
    /// engine is listening; `version` is the engine's version string.
    public static func make(version: String, socketPath: String) -> ControlGuide {
        ControlGuide(
            schema: schema,
            name: "rushes",
            version: version,
            protocolVersion: "1",
            socket: socketPath,
            commands: commandDocs() + ExtendedCommandRouter.commandDocs,
            events: eventDocs(),
            exitCodes: exitDocs())
    }

    private static func commandDocs() -> [CommandDoc] {
        [
            CommandDoc(name: "drawing.show", cli: [], summary: "Include only the dedicated Rushes Drawing window in an active display or area take.", usage: "socket drawing.show {windowID:string}", params: [.init(name: "windowID", type: "string", required: true, description: "Canonical window-N ID owned by the configured shell with title Rushes Drawing.")], result: "{enabled,windowID}"),
            CommandDoc(name: "drawing.hide", cli: [], summary: "Restore capture exclusions for the drawing panel.", usage: "socket drawing.hide", result: "{enabled:false}"),
            CommandDoc(name: "drawing.status", cli: [], summary: "Inspect the explicitly included drawing panel.", usage: "socket drawing.status", result: "{enabled,windowID?}"),
            CommandDoc(name: "library.trash", cli: [], summary: "Move a finalized recording package to macOS Trash with a five-second undo.", usage: "socket library.trash {id:string}", params: [.init(name: "id", type: "string", required: true, description: "Recording ULID.")], result: "{id,undoToken,undoExpiresAt,undoWindowMs,trashedPath}"),
            CommandDoc(name: "library.undoTrash", cli: [], summary: "Restore one recording within its five-second undo window; never overwrite an occupied path.", usage: "socket library.undoTrash {token:string}", params: [.init(name: "token", type: "string", required: true, description: "Undo token returned by library.trash.")], result: "{id,restored:true}"),
            CommandDoc(name: "library.refresh", cli: [], summary: "Rebuild library cache after a reversible move or restore; manifests remain authoritative.", usage: "socket library.refresh", result: "{recordings:[index rows]}"),
            CommandDoc(name: "mcp.enable", cli: ["mcp enable"], summary: "Enable private loopback MCP; read-only unless allowMutations is explicitly true.", usage: "rushes mcp enable [--args FILE]", params: [.init(name: "allowMutations", type: "boolean", description: "Explicitly permit recording/edit/export/share mutations."), .init(name: "port", type: "integer", description: "0 requests an available loopback port.")], result: "{enabled,allowMutations,url,token}; token only returned on enable"),
            CommandDoc(name: "mcp.disable", cli: ["mcp disable"], summary: "Stop loopback MCP and disable restoration on next launch.", usage: "rushes mcp disable", result: "{enabled:false}"),
            CommandDoc(name: "mcp.status", cli: ["mcp status"], summary: "Inspect local automation state without revealing the credential.", usage: "rushes mcp status", result: "{enabled,allowMutations,url?}"),
            CommandDoc(name: "url.open", cli: [], summary: "Validate and execute a closed-list rushes:// automation route.", usage: "socket url.open {url:string}", result: "underlying command result"),
            CommandDoc(name: "permissions.check", cli: ["permissions check"], summary: "Inspect native permissions without prompting.", usage: "rushes permissions check", result: "{screen,camera,microphone,accessibility,inputMonitoring,details}"),
            CommandDoc(name: "permissions.request", cli: ["permissions request"], summary: "Explicitly request one native permission.", usage: "rushes permissions request PERMISSION", result: "permission states"),
            CommandDoc(name: "permissions.settings", cli: ["permissions settings"], summary: "Get the relevant Settings link.", usage: "rushes permissions settings PERMISSION", result: "{url}"),
            CommandDoc(name: "camera.preview.subscribe", cli: [], summary: "Enable or disable preview events without changing camera device lifecycle; allowed during active CLI takes.", usage: "socket camera.preview.subscribe {enabled:true}", result: "{enabled}"),
            CommandDoc(name: "camera.preview.start", cli: ["camera preview-start"], summary: "Warm camera and publish bounded JPEG preview events.", usage: "rushes camera preview-start --camera default", result: "{running,camera,name}"),
            CommandDoc(name: "camera.preview.stop", cli: ["camera preview-stop"], summary: "Close camera preview while idle.", usage: "rushes camera preview-stop", result: "{}"),
            CommandDoc(name: "record.cancel", cli: ["record cancel"], summary: "Cancel countdown.", usage: "rushes record cancel", result: "{state}"),
            CommandDoc(name: "record.discard", cli: ["record discard"], summary: "Delete only the active take after closing writers.", usage: "rushes record discard", result: "{id,discarded,state}"),
            CommandDoc(name: "record.restart", cli: ["record restart"], summary: "Discard active take and start a new one with prior options.", usage: "rushes record restart", result: "{id,packagePath,state}"),
            CommandDoc(name: "record.mute", cli: ["record mute"], summary: "Mute one audio track while keeping its timeline continuous.", usage: "rushes record mute --track microphone --muted true", result: "{track,muted}"),
            CommandDoc(name: "record.bubble", cli: [], summary: "Store normalized camera bubble center and point size.", usage: "socket record.bubble {center:[x,y],size:200,visible:true}", result: "{}"),
            CommandDoc(
                name: "ping",
                cli: ["ping"],
                summary: "Liveness probe; also returns the engine's host-clock now.",
                usage: "rushes ping",
                result: "{pong: true, nowNs: number}"),
            CommandDoc(
                name: "version",
                cli: ["version"],
                summary: "Engine name, version and protocol revision.",
                usage: "rushes version",
                result: "{name, version, protocol}"),
            CommandDoc(
                name: "guide",
                cli: ["guide", "guide --json"],
                summary: "This guide: every command, param, event type and exit code.",
                usage: "rushes guide --json",
                result: "the guide object itself"),
            CommandDoc(
                name: "status",
                cli: ["status"],
                summary: "Engine state and, while a recording runs, its live snapshot.",
                usage: "rushes status",
                result: "{state: \"idle\"|\"recording\"|\"paused\", recording?: SessionSnapshot}"),
            CommandDoc(
                name: "targets",
                cli: ["targets"],
                summary: "Catalog lists: displays, windows, cameras, microphones, with stable ids.",
                usage: "rushes targets",
                result: "{displays: [{id, name, widthPoints, heightPoints, isMain}],"
                    + " windows: [{id, title, owningApplication, displayID}],"
                    + " cameras: [{id, name}], microphones: [{id, name}]}"),
            CommandDoc(
                name: "record.start",
                cli: ["record start"],
                summary: "Preflight, create the package, arm capture behind the gate,"
                    + " open the gate when the countdown elapses (immediately at 0)"
                    + " and return the recording id. One recording at a time.",
                usage: "rushes record start (--display ID|main | --window ID)"
                    + " [--camera ID|default] [--mic ID|default] [--system-audio]"
                    + " [--countdown SEC] [--duration SEC] [--title TEXT] [--wait]",
                params: [
                    ParamDoc(name: "display", flag: "--display", type: "string",
                             description: "Display to record, by stable id or \"main\"."
                                 + " Exactly one of display/window is required unless the take is camera-only."),
                    ParamDoc(name: "area", flag: "--area", type: "object", description: "Global point rectangle {x,y,width,height}; CLI X,Y,W,H."),
                    ParamDoc(name: "cursor", flag: "--cursor", type: "string", description: "baked or data (cursor-free master)."),
                    ParamDoc(name: "window", flag: "--window", type: "string",
                             description: "Window to record, by stable id."),
                    ParamDoc(name: "camera", flag: "--camera", type: "string",
                             description: "Camera device id, or \"default\" for the first discovered camera."),
                    ParamDoc(name: "mic", flag: "--mic", type: "string",
                             description: "Microphone device id, or \"default\" for the first discovered microphone."),
                    ParamDoc(name: "systemAudio", flag: "--system-audio", type: "boolean",
                             description: "Record system audio into its own track."),
                    ParamDoc(name: "countdownSeconds", flag: "--countdown", type: "int",
                             description: "Countdown before the gate opens (0, 3 or 5). Default 0."),
                    ParamDoc(name: "duration", flag: "--duration", type: "seconds",
                             description: "Stop the recording automatically after this many seconds."),
                    ParamDoc(name: "title", flag: "--title", type: "string",
                             description: "Recording title stored in the manifest."),
                    ParamDoc(name: "wait", flag: "--wait", type: "boolean",
                             description: "Hold the request open: stream NDJSON events and"
                                 + " respond when the recording stops."),
                ],
                result: "{id, packagePath, state}: the id keys later stop/show/verify."
                    + " With wait, events recording-started/state-changed/warning"
                    + " stream first and the response is the stop outcome."),
            CommandDoc(
                name: "record.stop",
                cli: ["record stop"],
                summary: "Stop the active recording (or the one named by id), finalize"
                    + " every track bounded, and return the package outcome.",
                usage: "rushes record stop [--id ID]",
                params: [
                    ParamDoc(name: "id", flag: "--id", type: "string",
                             description: "The recording id from record start. Omitted stops the active take."),
                ],
                result: "{id, packagePath, status, durationMs, tracks: [TrackWriterStatus]}"),
            CommandDoc(
                name: "record.pause",
                cli: ["record pause"],
                summary: "Pause the active recording on the one shared pause clock.",
                usage: "rushes record pause",
                result: "{state: \"paused\"}"),
            CommandDoc(
                name: "record.resume",
                cli: ["record resume"],
                summary: "Resume the paused recording.",
                usage: "rushes record resume",
                result: "{state: \"recording\"}"),
            CommandDoc(
                name: "list",
                cli: ["list"],
                summary: "Recordings from the package index, newest first. The index is a"
                    + " cache rebuilt from manifests at engine boot.",
                usage: "rushes list [--limit N]",
                params: [
                    ParamDoc(name: "limit", flag: "--limit", type: "int",
                             description: "Return at most N recordings."),
                ],
                result: "{recordings: [{id, folder, title, createdAt, durationMs, status}]}"),
            CommandDoc(
                name: "show",
                cli: ["show"],
                summary: "One recording's manifest plus absolute track paths.",
                usage: "rushes show ID",
                params: [
                    ParamDoc(name: "id", type: "string", required: true,
                             description: "Recording id (ULID) from record start or list."),
                ],
                result: "{id, packagePath, tracks: [{role, file, path}], manifest}"),
            CommandDoc(
                name: "verify",
                cli: ["verify"],
                summary: "Decode test of every track: openable, durations within 50 ms of"
                    + " the manifest duration, offsets consistent.",
                usage: "rushes verify ID",
                params: [
                    ParamDoc(name: "id", type: "string", required: true,
                             description: "Recording id."),
                ],
                result: "{packageId, ok, trackChecks: [{kind, file, ok, skipped, issues}], issues}"),
            CommandDoc(
                name: "selftest.sync",
                cli: ["selftest sync"],
                summary: "Screen-to-system-audio sync selftest. The engine records itself in"
                    + " selftest mode (the stream includes the engine's own flash window and"
                    + " its own tone), flashes a full-screen white window and plays a tone at"
                    + " the same host instant - twice, around one pause - then measures both"
                    + " signals in screen.mov and system.mov and reports the offset after the"
                    + " stored latency. The freshly measured latency is stored for the next"
                    + " run, so a passing run proves run-to-run stability within one 60 fps"
                    + " frame (17 ms).",
                usage: "rushes selftest sync [--seconds N] [--pause-at S]",
                params: [
                    ParamDoc(name: "seconds", flag: "--seconds", type: "seconds",
                             description: "Media length of the selftest take. Default 20."),
                    ParamDoc(name: "pauseAt", flag: "--pause-at", type: "seconds",
                             description: "Media second at which the take pauses for 3 s,"
                                 + " so the offset is measured before and after a pause."),
                ],
                result: "{recordingId, packagePath, pre: {flashMs, toneMs, rawOffsetMs, offsetMs},"
                    + " post: {...}, appliedLatencyMs, storedLatencyMs, pass, toleranceMs: 17}"),
            CommandDoc(
                name: "analyze.clap",
                cli: ["analyze clap"],
                summary: "Camera-to-microphone offset from a recording with hand claps in"
                    + " view of the camera: each clap's audio onset in mic.mov is matched"
                    + " with the strongest frame-to-frame change in camera.mov near it;"
                    + " every offset must sit within 40 ms.",
                usage: "rushes analyze clap ID",
                params: [
                    ParamDoc(name: "id", type: "string", required: true,
                             description: "Recording id of a take with camera and microphone."),
                ],
                result: "{claps: [{tMs, audioMs, visualMs, offsetMs}], toleranceMs: 40, pass}"),
        ]
    }

    private static func eventDocs() -> [EventDoc] {
        [
            EventDoc(event: "camera-preview", fields: ["result.jpeg", "result.mime", "result.mirrored"], description: "Bounded best-effort JPEG frames from the recording camera session."),
            EventDoc(event: "countdown", fields: ["recordingId", "result.remaining"], description: "Warm pipeline countdown, then zero at the gate."),
            EventDoc(
                event: ControlEventKind.recordingStarted.rawValue,
                fields: ["id (request tag)", "recordingId", "t (media ms)"],
                description: "The gate opened; media time zero is set."),
            EventDoc(
                event: ControlEventKind.recordingStopped.rawValue,
                fields: ["id (request tag)", "recordingId", "result (stop outcome)"],
                description: "The take finished; every track finalized."),
            EventDoc(
                event: ControlEventKind.stateChanged.rawValue,
                fields: ["id (request tag)", "recordingId", "state"],
                description: "The session moved between recording/paused/finishing/complete."),
            EventDoc(
                event: ControlEventKind.warning.rawValue,
                fields: ["id (request tag)", "recordingId", "code", "message", "t (media ms)"],
                description: "A warning was recorded (camera-lost, mic-silent, codec-fallback...)."),
        ]
    }

    private static func exitDocs() -> [ExitDoc] {
        [
            ExitDoc(code: Int(ControlExitCode.ok.rawValue), name: "ok",
                    meaning: "The command succeeded."),
            ExitDoc(code: Int(ControlExitCode.runtime.rawValue), name: "runtime error",
                    meaning: "The command ran and failed (low-disk, already-active,"
                        + " not-recording, writer failure...)."),
            ExitDoc(code: Int(ControlExitCode.usage.rawValue), name: "usage error",
                    meaning: "The CLI was invoked incorrectly (unknown command,"
                        + " bad arguments)."),
            ExitDoc(code: Int(ControlExitCode.permission.rawValue), name: "permission missing",
                    meaning: "A macOS permission is denied or was never asked for."),
            ExitDoc(code: Int(ControlExitCode.unreachable.rawValue), name: "app not reachable",
                    meaning: "No engine is listening on the control socket,"
                        + " or the connection died mid-request."),
            ExitDoc(code: Int(ControlExitCode.notFound.rawValue), name: "not found",
                    meaning: "No recording matches the id."),
        ]
    }
}
