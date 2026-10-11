import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation

/// Everything the plan fixes about the ScreenCaptureKit stream, as pure
/// values (docs/PLAN.md, capture-screen and Track settings).
///
/// `ScreenSource` builds the real `SCStream`/`SCContentFilter` objects from a
/// plan; the plan itself is constructible and checkable without any capture
/// hardware, so the plan's numbers are unit tested here, not on David's Mac.
public struct ScreenStreamPlan: Equatable, Sendable {

    /// Output size in pixels: the content rectangle times the point-to-pixel
    /// scale, even numbers, long edge at most 3840 px (docs/PLAN.md,
    /// capture-screen; the math is OpenScreen's `captureOutputSize`).
    public var width: Int
    public var height: Int

    /// 60 fps target: the minimum frame interval is 1/60 s.
    public var minimumFrameInterval: CMTime

    /// Queue depth 3, so the stream drops frames instead of piling up memory
    /// when the synchronous writer hop stalls (docs/PLAN.md, Backpressure).
    /// If Phase 1 measures more than 1 % dropped screen frames this rises to
    /// 6; the plan carries the value, so the change is one constant here.
    public var queueDepth: Int

    /// NV12 video range ('420v'): two notes agree on NV12 and it halves
    /// memory traffic (docs/PLAN.md, Pixel format).
    public var pixelFormat: OSType

    /// The cursor is baked into the screen master for Phases 1 to 5
    /// (docs/PLAN.md, Open decisions).
    public var showsCursor: Bool

    /// System audio rides the same stream as the screen whenever a screen is
    /// recorded, into its own writer (never into screen.mov).
    public var capturesSystemAudio: Bool

    /// Our own process's audio is excluded from system audio in normal
    /// recordings, and included only in `selftest sync` mode, which must
    /// measure our own test tone (docs/PLAN.md, Roadmap Phase 1 item 9).
    public var excludesOwnProcessAudio: Bool

    /// The microphone rides the stream as a third output whenever a screen is
    /// recorded, on the same host clock (docs/PLAN.md, Sources per capture
    /// mode).
    public var capturesMicrophone: Bool

    /// The microphone device's `AVCaptureDevice.uniqueID`, when the caller
    /// chose a device; nil means the system default microphone.
    public var microphoneDeviceID: String?

    /// Area mode only: the source rectangle in points inside the display
    /// (docs/PLAN.md, Sources per capture mode: "Display filter with a source
    /// rectangle"). Nil for display and window modes.
    public var sourceRect: CGRect?

    public init(
        width: Int,
        height: Int,
        minimumFrameInterval: CMTime = CMTime(value: 1, timescale: 60),
        queueDepth: Int = 3,
        pixelFormat: OSType = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        showsCursor: Bool = true,
        capturesSystemAudio: Bool,
        excludesOwnProcessAudio: Bool,
        capturesMicrophone: Bool,
        microphoneDeviceID: String? = nil,
        sourceRect: CGRect? = nil
    ) {
        self.width = width
        self.height = height
        self.minimumFrameInterval = minimumFrameInterval
        self.queueDepth = queueDepth
        self.pixelFormat = pixelFormat
        self.showsCursor = showsCursor
        self.capturesSystemAudio = capturesSystemAudio
        self.excludesOwnProcessAudio = excludesOwnProcessAudio
        self.capturesMicrophone = capturesMicrophone
        self.microphoneDeviceID = microphoneDeviceID
        self.sourceRect = sourceRect
    }

    /// The plan's stream configuration for one captured surface.
    ///
    /// - Parameters:
    ///   - contentSize: the filter's content rectangle size, in points.
    ///   - pointPixelScale: the filter's points-to-pixels factor.
    ///   - systemAudio: whether system audio is captured through the stream.
    ///   - microphone: whether the microphone is captured through the stream.
    ///   - microphoneDeviceID: chosen microphone device id, nil for default.
    ///   - selftest: selftest mode includes our own windows in the filter and
    ///     our own audio in system audio; normal recordings exclude both.
    ///   - sourceRect: the area rectangle in points (area mode only).
    public static func make(
        contentSize: CGSize,
        pointPixelScale: CGFloat,
        systemAudio: Bool,
        microphone: Bool,
        microphoneDeviceID: String? = nil,
        selftest: Bool = false,
        sourceRect: CGRect? = nil
    ) -> ScreenStreamPlan {
        // Long edge at most 3840 px with one proportional fit factor; the
        // helper keeps both numbers even (docs/PLAN.md, capture-screen).
        let size = captureOutputSize(
            contentSize: contentSize,
            pointPixelScale: pointPixelScale,
            maxWidth: Self.maxLongEdgePixels,
            maxHeight: Self.maxLongEdgePixels)
        return ScreenStreamPlan(
            width: size.width,
            height: size.height,
            capturesSystemAudio: systemAudio,
            excludesOwnProcessAudio: !selftest,
            capturesMicrophone: microphone,
            microphoneDeviceID: microphoneDeviceID,
            sourceRect: sourceRect)
    }

    /// The long-edge cap for every screen output (docs/PLAN.md,
    /// capture-screen: "long edge at most 3840 px").
    public static let maxLongEdgePixels = 3840
}

/// Which screen surface a take captures, in the plan's three screen modes
/// (docs/PLAN.md, Sources per capture mode).
public enum ScreenSurface: Equatable, Sendable {

    /// A whole display, by stable catalog id (`SourceIds.display`).
    case display(id: String)

    /// One window, by stable catalog id (`SourceIds.window`). The
    /// desktop-independent window filter follows the window as it moves or is
    /// covered.
    case window(id: String)

    /// A dragged area of a display: the display filter plus a source
    /// rectangle in points, global unflipped coordinates (origin top-left of
    /// the main display), already clamped to the display's frame.
    case area(displayID: String, rect: CGRect)

    /// The manifest's capture mode string.
    public var modeString: String {
        switch self {
        case .display: return "display"
        case .window: return "window"
        case .area: return "area"
        }
    }
}

/// The own-app exclusion seam (docs/PLAN.md, Live UI kept out of the
/// footage).
///
/// The engine's content filter excludes a list of applications: the Electron
/// shell and the engine itself, whenever the engine runs outside the app
/// bundle in development. Both bundle ids are injectable so the engine and
/// tests decide the list without hardcoding one deployment shape. In selftest
/// mode the list is empty: the selftest stream must include our own window
/// and audio to measure them.
public struct ScreenExclusionList: Equatable, Sendable {

    /// The Electron shell's bundle id (for example "ai.rushes.app").
    public let shellBundleID: String?

    /// The engine's own bundle id when it runs inside the bundle, or its
    /// executable identity in development. Nil leaves only the shell excluded.
    public let engineBundleID: String?

    public init(shellBundleID: String?, engineBundleID: String?) {
        self.shellBundleID = shellBundleID
        self.engineBundleID = engineBundleID
    }

    /// The bundle ids to exclude from the display filter, in a stable order.
    /// Empty in selftest mode, where the stream must see our own window.
    public func bundleIDs(selftest: Bool) -> [String] {
        guard !selftest else { return [] }
        var ids: [String] = []
        if let shell = shellBundleID, !shell.isEmpty { ids.append(shell) }
        if let engine = engineBundleID, !engine.isEmpty, engine != shellBundleID {
            ids.append(engine)
        }
        return ids
    }
}

/// Area-mode rectangle math (docs/PLAN.md, Sources per capture mode: area is
/// a display filter with a source rectangle).
public enum AreaRectMath {

    /// Clamps a dragged rectangle (global unflipped points) to the display it
    /// will be recorded from, and drops an empty intersection.
    ///
    /// - Parameters:
    ///   - dragged: the rectangle the picker dragged, in global unflipped
    ///     points (origin at the top-left of the main display).
    ///   - displayFrame: the display's frame in the same coordinates.
    /// - Returns: the clamped rectangle with positive size, or nil when the
    ///   drag misses the display entirely.
    public static func clamp(_ dragged: CGRect, toDisplay displayFrame: CGRect) -> CGRect? {
        let intersection = dragged.intersection(displayFrame)
        guard !intersection.isNull, intersection.width >= 1, intersection.height >= 1 else {
            return nil
        }
        return intersection
    }

    /// The area's output size: the rectangle's point size times the scale,
    /// even numbers, long edge at most 3840 px - the same rules as a whole
    /// display, because area mode uses the display filter with a source rect.
    public static func outputSize(
        area: CGRect, pointPixelScale: CGFloat
    ) -> (width: Int, height: Int) {
        captureOutputSize(
            contentSize: area.size,
            pointPixelScale: pointPixelScale,
            maxWidth: ScreenStreamPlan.maxLongEdgePixels,
            maxHeight: ScreenStreamPlan.maxLongEdgePixels)
    }
}
