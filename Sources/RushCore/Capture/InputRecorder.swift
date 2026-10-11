import CoreFoundation
import CoreGraphics
import Foundation

// MARK: - NDJSON line shapes (docs/PLAN.md, Other files: input.ndjson)

/// One `input.ndjson` line. The plan's shapes:
/// `{"t":1234.5,"k":"move","x":0.412,"y":0.288}`,
/// `{"t":1302.0,"k":"down","b":0}`, `{"t":1388.1,"k":"up","b":0}`,
/// `{"t":2000.0,"k":"key","mods":["cmd","shift"],"key":"R"}`,
/// `{"t":0,"k":"geom","content":[0,0,1512,982],"scale":2}`.
///
/// `t` is media time in milliseconds, so pauses are already removed
/// (`SessionClock.mediaTimeNs` divides them out before we get here).
public struct InputEventLine: Codable, Equatable, Sendable {

    /// Media time in milliseconds.
    public var t: Double
    public var k: String
    public var x: Double?
    public var y: Double?
    /// Mouse button number (0 primary, 1 secondary, 2+ tertiary).
    public var b: Int?
    /// The key's own name for modifier/special keys ("cmd", "R", ...).
    public var key: String?
    /// The modifier chord held with the key.
    public var mods: [String]?
    /// Geometry line only: `[x, y, width, height]` of the captured content,
    /// global unflipped points.
    public var content: [Double]?
    /// Geometry line only: the point-to-pixel scale the screen track uses.
    public var scale: Double?

    public init(
        t: Double,
        k: String,
        x: Double? = nil,
        y: Double? = nil,
        b: Int? = nil,
        key: String? = nil,
        mods: [String]? = nil,
        content: [Double]? = nil,
        scale: Double? = nil
    ) {
        self.t = t
        self.k = k
        self.x = x
        self.y = y
        self.b = b
        self.key = key
        self.mods = mods
        self.content = content
        self.scale = scale
    }

    public enum Kind {
        public static let move = "move"
        public static let down = "down"
        public static let up = "up"
        public static let key = "key"
        public static let geom = "geom"
    }
}

// MARK: - Pure event logic

/// Normalizes a global pointer position to 0..1 of the captured content,
/// top-left origin (docs/PLAN.md, Input timeline).
public enum PointerNormalizer {

    /// - Parameters:
    ///   - point: the event's global unflipped location (origin at the
    ///     top-left of the main display).
    ///   - contentRect: the captured content's frame in the same space
    ///     (the area rect, the window's frame, or the whole display).
    /// - Returns: normalized x/y, or nil when the content has no size.
    public static func normalize(_ point: CGPoint, in contentRect: CGRect) -> (x: Double, y: Double)? {
        guard contentRect.width > 0, contentRect.height > 0 else { return nil }
        let x = (point.x - contentRect.minX) / contentRect.width
        let y = (point.y - contentRect.minY) / contentRect.height
        func clamp(_ v: CGFloat) -> Double { Double(min(max(v, 0), 1)) }
        return (clamp(x), clamp(y))
    }
}

/// Modifier naming and the keystroke privacy rule (docs/PLAN.md, Input
/// timeline): keystrokes are off by default, and when on, only modifier
/// chords and special keys are kept - never plain typing.
public enum KeyModifierCoder {

    /// Canonical modifier names, in a stable order, from `CGEventFlags`.
    public static func modifierNames(_ flags: CGEventFlags) -> [String] {
        var names: [String] = []
        if flags.contains(.maskCommand) { names.append("cmd") }
        if flags.contains(.maskAlternate) { names.append("opt") }
        if flags.contains(.maskControl) { names.append("ctrl") }
        if flags.contains(.maskShift) { names.append("shift") }
        if flags.contains(.maskSecondaryFn) { names.append("fn") }
        return names
    }

    /// Keycodes that count as special keys: return, tab, space (a control
    /// key in players and slides), delete, escape, the F-key range (96-122),
    /// home, page up, forward delete, end, page down and the four arrows.
    /// Apple's virtual keycode tables, as every HID keyboard on macOS maps
    /// them.
    public static let specialKeyCodes: Set<CGKeyCode> = {
        var codes: Set<CGKeyCode> = [36, 48, 49, 51, 53, 115, 116, 117, 119, 121, 123, 124, 125, 126]
        codes.formUnion((96...122).map { CGKeyCode($0) })
        return codes
    }()

    /// The modifier keys' own keycodes (flagsChanged events), left and right
    /// variants mapped to one name each.
    public static let modifierKeyCodes: [CGKeyCode: String] = [
        54: "cmd", 55: "cmd",
        56: "shift", 60: "shift",
        58: "opt", 61: "opt",
        59: "ctrl", 62: "ctrl",
        57: "caps", 63: "fn",
    ]

    /// Whether a key-down event may be recorded: a modifier chord (two or
    /// more modifiers held) or a special key. Plain typing is never kept.
    public static func isRecordable(
        keyCode: CGKeyCode, modifiers: [String]
    ) -> Bool {
        if modifiers.count >= 2 { return true }
        return specialKeyCodes.contains(keyCode)
    }
}

/// What the tap degradation decided (docs/PLAN.md, Preparing: a missing or
/// denied optional input degrades with a warning - never a crash).
public enum InputTapMode: Equatable, Sendable {
    /// Pointer, clicks and (off by default) keystroke modifiers.
    case full
    /// The full tap could not be created; a mouse-only tap still runs, so
    /// pointer and clicks are kept and keystrokes are off.
    case pointerOnly
    /// No tap could be created at all (accessibility not granted); nothing
    /// is recorded.
    case off
}

/// The tap degradation rule: try the full tap (mouse plus flagsChanged when
/// keystrokes are on), fall back to a mouse-only tap, fall back to off. A
/// degraded mode always carries a warning for the manifest.
public enum InputTapDegradation {

    public static func decide(
        keystrokesRequested: Bool, fullTapCreated: Bool, mouseOnlyTapCreated: Bool
    ) -> (mode: InputTapMode, warning: String?) {
        if fullTapCreated { return (.full, nil) }
        if mouseOnlyTapCreated {
            return (.pointerOnly, "input tap degraded: keystrokes unavailable (accessibility not granted)")
        }
        return (.off, "input tap unavailable (accessibility not granted); pointer timeline off")
    }
}

// MARK: - The recorder

/// Records the input timeline into `input.ndjson` (docs/PLAN.md, Input
/// timeline): pointer moves, drags, button presses and releases, normalized
/// to 0..1 of the captured content, plus heartbeat samples so there is always
/// a pointer position. Keystroke modifiers are off by default.
///
/// The file is appended through the project's `NDJSONAppendFile` helper with
/// per-line fsync, which exceeds the plan's one-second checkpoint cadence -
/// a crash therefore keeps every event already seen (docs/PLAN.md: "unlike
/// Screendrop ... the file is appended and flushed every second, so recovery
/// keeps the cursor data").
///
/// The tap is a listen-only `CGEventTap` on `cghidEventTap`. When the tap
/// cannot be added (no Accessibility permission) the recorder degrades to
/// pointer-only or off with a warning and never crashes.
public final class InputRecorder: @unchecked Sendable {

    /// The session clock's media-time mapping (host ns -> media ns).
    private var clock: SessionClock

    /// The content rectangle, global unflipped points, that pointer
    /// positions are normalized against.
    private let contentRect: CGRect

    /// The point-to-pixel scale written into the geometry line.
    private let pointPixelScale: Double

    private let file: NDJSONAppendFile
    private let ownWindowFrames: @Sendable () -> [CGRect]
    private let warnings: @Sendable (String) -> Void
    private let lock = NSLock()

    // Confined to `lock`.
    private var lastPointerLineAtHostNs: Int64?
    private var lastKnownPosition: CGPoint?
    private var mode: InputTapMode = .full
    private var keystrokesEnabled: Bool
    private var tap: CFMachPort?
    private var runLoopThread: Thread?
    private var tapRunLoop: CFRunLoop?

    /// - Parameters:
    ///   - url: `input.ndjson` inside the package.
    ///   - clock: the session's clock; events before the epoch are dropped.
    ///   - contentRect: the captured content's frame, global unflipped
    ///     points (display frame, window frame, or area rect).
    ///   - pointPixelScale: for the geometry line.
    ///   - keystrokes: whether keystroke modifiers were requested (off by
    ///     default per the plan's privacy rule).
    ///   - ownWindowFrames: returns the current frames of our own windows;
    ///     clicks landing inside them are dropped (Screenity idea).
    ///   - warnings: the recorder's degradation warnings go here (the engine
    ///     wires it to the session's manifest warnings).
    public init(
        url: URL,
        clock: SessionClock,
        contentRect: CGRect,
        pointPixelScale: Double,
        keystrokes: Bool = false,
        ownWindowFrames: @escaping @Sendable () -> [CGRect] = { [] },
        warnings: @escaping @Sendable (String) -> Void = { _ in }
    ) throws {
        // Per-line fsync: stronger than the plan's one-second cadence, at
        // the cost of a tiny fsync per event; input lines are ~40 bytes.
        self.file = try NDJSONAppendFile(url: url, fsyncPerLine: true)
        self.clock = clock
        self.contentRect = contentRect
        self.pointPixelScale = pointPixelScale
        self.keystrokesEnabled = keystrokes
        self.ownWindowFrames = ownWindowFrames
        self.warnings = warnings
    }

    deinit {
        file.close()
    }

    /// The mode the recorder ended up in after `start`.
    public var activeMode: InputTapMode {
        lock.lock()
        defer { lock.unlock() }
        return mode
    }

    /// Whether keystroke modifiers are being recorded.
    public var isRecordingKeystrokes: Bool {
        lock.lock()
        defer { lock.unlock() }
        return keystrokesEnabled && mode == .full
    }

    /// Writes the geometry line (media time 0 by definition) and starts the
    /// listen-only tap, degrading when the tap cannot be added.
    ///
    /// - Parameter tapFactory: creates the tap for a mask (the recorder is
    ///   delivered to the callback through `userInfo`); the production
    ///   default is `CGEvent.tapCreate` with the plan's event mask; tests
    ///   inject nil (permission denied) or an inert `CFMachPort`.
    public func start(
        tapFactory: (@Sendable (CGEventMask) -> CFMachPort?)? = nil
    ) {
        append(InputEventLine(
            t: 0,
            k: InputEventLine.Kind.geom,
            content: [
                contentRect.minX, contentRect.minY,
                contentRect.width, contentRect.height,
            ],
            scale: pointPixelScale))

        lock.lock()
        lastKnownPosition = CGEvent(source: nil)?.location ?? CGPoint(x: contentRect.midX, y: contentRect.midY)
        lastPointerLineAtHostNs = clock.epochNs
        lock.unlock()
        let keystrokesWanted = keystrokesEnabled
        // Capturing `self` (an @unchecked Sendable class) keeps the closure
        // Sendable; the raw `userInfo` pointer is derived inside, where the
        // C callback reads it.
        let make: @Sendable (CGEventMask) -> CFMachPort? =
            tapFactory ?? { mask in Self.createTap(mask: mask, recorder: self) }
        let fullTap = make(Self.eventMask(keystrokes: keystrokesWanted))
        var mouseTap: CFMachPort? = nil
        if fullTap == nil {
            // Degradation step: a mouse-only tap may still be addable when
            // the full mask is refused (keystroke events need Input
            // Monitoring; the pointer needs Accessibility).
            mouseTap = make(Self.eventMask(keystrokes: false))
        }
        let decision = InputTapDegradation.decide(
            keystrokesRequested: keystrokesWanted,
            fullTapCreated: fullTap != nil,
            mouseOnlyTapCreated: mouseTap != nil)
        lock.lock()
        mode = decision.mode
        if decision.mode == .pointerOnly { keystrokesEnabled = false }
        let chosenTap = fullTap ?? mouseTap
        tap = chosenTap
        lock.unlock()
        if let warning = decision.warning {
            warnings(warning)
        }

        guard let chosenTap else { return }
        let handle = InputTapHandle(chosenTap)
        let thread = Thread { [handle, self] in
            let chosenTap = handle.port
            if let runLoop = CFRunLoopGetCurrent() {
                self.noteTapRunLoop(runLoop)
                CGEvent.tapEnable(tap: chosenTap, enable: true)
                if let source = CFMachPortCreateRunLoopSource(nil, chosenTap, 0) {
                    CFRunLoopAddSource(runLoop, source, .defaultMode)
                }
            }
            CFRunLoopRun()
        }
        thread.name = "rush.rushcore.input.tap"
        thread.start()
        lock.lock()
        runLoopThread = thread
        lock.unlock()
    }

    /// Stores the tap thread's run loop so `stop` can end it.
    private func noteTapRunLoop(_ runLoop: CFRunLoop) {
        lock.lock()
        // Only the tap thread writes this, and only before it runs.
        if tapRunLoop == nil { tapRunLoop = runLoop }
        lock.unlock()
    }

    /// Stops the tap and closes the file. Idempotent.
    public func stop() {
        lock.lock()
        let tap = self.tap
        let runLoop = tapRunLoop
        self.tap = nil
        self.runLoopThread = nil
        self.tapRunLoop = nil
        lock.unlock()
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            if let runLoop {
                CFRunLoopStop(runLoop)
            }
        }
        file.close()
    }

    /// The event tap's own run loop thread (set once `start` spawns it).
    var tapThread: Thread? {
        lock.lock()
        defer { lock.unlock() }
        return runLoopThread
    }

    // MARK: Event handling (lock-confined, callable from the tap thread)

    func handleTapEvent(type: CGEventType, event: CGEvent) {
        // A tap-disabled notification must be answered by re-enabling, or
        // the system silently stops delivering events.
        if type == .tapDisabledByUserInput || type == .tapDisabledByTimeout {
            lock.lock()
            let currentTap = tap
            lock.unlock()
            if let currentTap { CGEvent.tapEnable(tap: currentTap, enable: true) }
            return
        }
        let hostNs = Int64(clamping: event.timestamp)
        // Events before the epoch belong to the countdown: dropped (media
        // time would be zero, which would place them at the recording start).
        guard mappedMediaMs(hostNs) != nil else { return }

        switch type {
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
            recordMove(event: event, hostNs: hostNs)
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            recordButton(event: event, hostNs: hostNs, down: true)
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            recordButton(event: event, hostNs: hostNs, down: false)
        case .flagsChanged:
            // A modifier press of its own is a chord only when more modifiers
            // end up held; the privacy rule is applied in recordKey.
            if isRecordingKeystrokes {
                recordModifierChange(event: event, hostNs: hostNs)
            }
        default:
            break
        }
    }

    private func recordMove(event: CGEvent, hostNs: Int64) {
        let location = event.location
        lock.lock()
        lastKnownPosition = location
        lastPointerLineAtHostNs = hostNs
        lock.unlock()
        guard let normalized = PointerNormalizer.normalize(location, in: contentRect) else { return }
        append(InputEventLine(
            t: mediaMs(atHostNs: hostNs),
            k: InputEventLine.Kind.move,
            x: normalized.x,
            y: normalized.y))
    }

    private func recordButton(event: CGEvent, hostNs: Int64, down: Bool) {
        let location = event.location
        // Clicks that land on our own windows are dropped (Screenity idea):
        // the bar, bubble and countdown are UI, not content.
        if ownWindowFrames().contains(where: { $0.contains(location) }) {
            return
        }
        lock.lock()
        lastKnownPosition = location
        lastPointerLineAtHostNs = hostNs
        lock.unlock()
        guard let normalized = PointerNormalizer.normalize(location, in: contentRect) else { return }
        let button = event.getIntegerValueField(.mouseEventButtonNumber)
        let kind = down ? InputEventLine.Kind.down : InputEventLine.Kind.up
        append(InputEventLine(
            t: mediaMs(atHostNs: hostNs),
            k: kind,
            x: normalized.x,
            y: normalized.y,
            b: Int(button)))
    }

    private func recordModifierChange(event: CGEvent, hostNs: Int64) {
        let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
        let modifiers = KeyModifierCoder.modifierNames(event.flags)
        // Plain typing never reaches here (flagsChanged fires for modifier
        // keys only). A change is kept when it completes a chord of two or
        // more modifiers, or when it releases the last one (an empty mods
        // list marks the chord's end); lone modifier presses are not kept.
        let completesOrEndsChord = modifiers.count >= 2 || modifiers.isEmpty
        guard completesOrEndsChord else { return }
        let name = KeyModifierCoder.modifierKeyCodes[keyCode] ?? "mod"
        append(InputEventLine(
            t: mediaMs(atHostNs: hostNs),
            k: InputEventLine.Kind.key,
            key: name,
            mods: modifiers.isEmpty ? nil : modifiers))
    }

    /// The heartbeat: called once a second by the engine's timer (or by
    /// tests). Writes a move line at the last known position whenever a
    /// second passed with no pointer event, so there is always a pointer
    /// position (Screendrop idea).
    ///
    /// The window slides only when a line is actually written: marking time
    /// on every silent tick would keep pushing the "second since the last
    /// pointer event" boundary out and the heartbeat would never fire.
    public func tick(nowHostNs: Int64) {
        lock.lock()
        let last = lastPointerLineAtHostNs
        let position = lastKnownPosition
        lock.unlock()
        guard mappedMediaMs(nowHostNs) != nil else { return }
        guard let last, nowHostNs - last >= 1_000_000_000 else { return }
        guard let position,
              let normalized = PointerNormalizer.normalize(position, in: contentRect) else { return }
        append(InputEventLine(
            t: mediaMs(atHostNs: nowHostNs),
            k: InputEventLine.Kind.move,
            x: normalized.x,
            y: normalized.y))
        lock.lock()
        lastPointerLineAtHostNs = nowHostNs
        lock.unlock()
    }

    // MARK: Internals

    public func adoptClock(_ clock: SessionClock) {
        lock.lock(); self.clock = clock; lock.unlock()
    }

    private func mappedMediaMs(_ hostNs: Int64) -> Double? {
        lock.lock(); let snapshot = clock; lock.unlock()
        guard hostNs >= snapshot.epochNs && !snapshot.isPaused(atHostNs: hostNs) else { return nil }
        return Double(snapshot.mediaTimeNs(atHostNs: hostNs)) / 1_000_000
    }

    private func mediaMs(atHostNs hostNs: Int64) -> Double {
        mappedMediaMs(hostNs) ?? 0
    }

    private func append(_ line: InputEventLine) {
        try? file.append(line)
    }

    /// The production tap creation: listen-only HID tap for the plan's mask.
    /// The callback is a capture-free closure literal (a C function pointer
    /// cannot hold context); the recorder travels through `userInfo`.
    static func createTap(mask: CGEventMask, recorder: InputRecorder) -> CFMachPort? {
        let userInfo = Unmanaged.passUnretained(recorder).toOpaque()
        return CGEvent.tapCreate(
            tap: .cghidEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: { proxy, type, event, userInfo in
                inputTapCallback(proxy: proxy, type: type, event: event, userInfo: userInfo)
            },
            userInfo: userInfo)
    }

    /// The plan's event mask: pointer moves, drags, button presses and
    /// releases; flagsChanged only when keystroke modifiers are on.
    static func eventMask(keystrokes: Bool) -> CGEventMask {
        let types: [CGEventType] = [
            .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
            .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
            .otherMouseDown, .otherMouseUp,
        ] + (keystrokes ? [.flagsChanged] : [])
        return types.reduce(CGEventMask(0)) { mask, type in
            mask | (CGEventMask(1) << CGEventMask(type.rawValue))
        }
    }
}

/// The tap's C callback: no captures (a C function pointer cannot hold
/// context); the recorder arrives through `userInfo`.
func inputTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent> {
    if let userInfo {
        let recorder = Unmanaged<InputRecorder>.fromOpaque(userInfo).takeUnretainedValue()
        recorder.handleTapEvent(type: type, event: event)
    }
    // Listen-only: the event passes through untouched.
    return Unmanaged.passUnretained(event)
}

/// A strong immutable event-tap handle whose lifetime spans its dedicated loop.
private final class InputTapHandle: @unchecked Sendable {
    let port: CFMachPort
    init(_ port: CFMachPort) { self.port = port }
}
