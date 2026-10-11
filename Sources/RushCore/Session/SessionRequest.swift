import CoreGraphics
import Foundation

/// What a recording wants to be, before any check runs (docs/PLAN.md,
/// Control interface: `rushes record start`).
///
/// Source ids are the catalog's stable ids (`SourceIds.display`,
/// `SourceIds.window`, `SourceIds.device`). Video dimensions are the output
/// size the caller resolved for the content (the content rectangle times the
/// point-to-pixel scale); the session does not size captures itself, so
/// capture and control both stay thin over this type.
public struct SessionRequest: Codable, Equatable, Sendable {

    /// Output width and height in pixels of a video track.
    public struct Dimensions: Codable, Equatable, Sendable {
        public var width: Int
        public var height: Int

        public init(width: Int, height: Int) {
            self.width = width
            self.height = height
        }
    }

    /// Which screen surface to record.
    public enum ScreenTarget: Codable, Equatable, Sendable {
        /// A whole display, by stable catalog id.
        case display(id: String)
        /// One window, by stable catalog id.
        case window(id: String)
        case area(displayID: String, rect: CaptureArea)

        /// The manifest's capture mode string ("display" or "window").
        public var modeString: String {
            switch self {
            case .display: return "display"
            case .window: return "window"
            case .area: return "area"
            }
        }
    }

    /// The screen surface, or nil for a camera-only take.
    public var screen: ScreenTarget?

    /// Output size for the screen track. Required when `screen` is set; the
    /// caller computes it from the content (docs/PLAN.md, capture-screen).
    public var screenDimensions: Dimensions?

    /// Camera device id, or nil for no camera.
    public var cameraId: String?

    /// Output size for the camera track. Defaults to 1920x1080
    /// (docs/PLAN.md, capture-camera) when a camera is requested without a
    /// size.
    public var cameraDimensions: Dimensions?

    /// Microphone device id, or nil for no microphone.
    public var microphoneId: String?

    /// Whether system audio is captured. System audio rides the screen
    /// stream and has no device id of its own.
    public var systemAudio: Bool

    /// Countdown in seconds (0, 3 or 5). The countdown itself is the
    /// caller's timing; the session only opens the gate when told to
    /// (docs/PLAN.md, Clock, start gate and pause).
    public var countdownSeconds: Int

    public var title: String?
    public var cursor: String = "baked"

    /// A saved preset carried alongside the request, untouched.
    public var preset: SessionPreset?

    public init(
        screen: ScreenTarget? = nil,
        screenDimensions: Dimensions? = nil,
        cameraId: String? = nil,
        cameraDimensions: Dimensions? = nil,
        microphoneId: String? = nil,
        systemAudio: Bool = false,
        countdownSeconds: Int = 0,
        title: String? = nil,
        preset: SessionPreset? = nil
    ) {
        self.screen = screen
        self.screenDimensions = screenDimensions
        self.cameraId = cameraId
        self.cameraDimensions = cameraDimensions
        self.microphoneId = microphoneId
        self.systemAudio = systemAudio
        self.countdownSeconds = countdownSeconds
        self.title = title
        self.preset = preset
    }

    /// The track kinds this request asks for, in manifest order.
    public var trackKinds: [TrackKind] {
        var kinds: [TrackKind] = []
        if screen != nil { kinds.append(.screen) }
        if cameraId != nil { kinds.append(.camera) }
        if microphoneId != nil { kinds.append(.microphone) }
        if systemAudio { kinds.append(.systemAudio) }
        return kinds
    }

    /// Camera output size with the plan default applied.
    var effectiveCameraDimensions: Dimensions {
        cameraDimensions ?? Dimensions(width: 1920, height: 1080)
    }
}

/// A named preset carried alongside a request (docs/PLAN.md,
/// recording-controls: saved presets).
///
/// The payload is raw JSON the session never interprets: a preset is stored
/// shell settings, and its meaning belongs to the layer that saved it. The
/// session only stores the name in its log so a take can say which preset
/// started it.
public struct SessionPreset: Codable, Equatable, Sendable {
    public var name: String
    public var payload: Data?

    public init(name: String, payload: Data? = nil) {
        self.name = name
        self.payload = payload
    }
}

/// Global screen points, top-left origin. The source converts to display-local.
public struct CaptureArea: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public var cgRect: CGRect {
        CGRect(origin: CGPoint(x: x, y: y), size: CGSize(width: width, height: height))
    }
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }
}
