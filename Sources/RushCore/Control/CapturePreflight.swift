import CoreGraphics
import CoreMedia
import Foundation

public enum CapturePreflightMode: Sendable, Equatable { case system, generated }

internal struct CapturePreflightDrivers: Sendable {
    var microphone: @Sendable () -> any MicrophonePreviewing
    var snapshot: @Sendable (ScreenSurface, [String]) async throws -> ScreenPreviewImage
    static let system = Self(microphone: { NativeMicrophonePreview() },
                             snapshot: { try await NativeScreenPreview.snapshot(surface: $0, excluding: $1) })
    static let generated = Self(microphone: { GeneratedMicrophonePreview() },
                                snapshot: { surface, _ in try NativeScreenPreview.generated(surface: surface) })
}

/// Serial native ownership outlives a response timeout. Invalidating a selection
/// immediately blocks publication, while the queued stop still drains its exact
/// handle before any replacement or recording can acquire the input.
internal actor CapturePreflight {
    private struct Lease: Sendable {
        var token: String
        var selection: String
        var revision: Int64
        var owner: String
        var microphone: String?
        var surface: ScreenSurface?
        var source: String?
    }
    private let catalog: any SourceCataloging
    private let permissions: PermissionAdvisor
    private let drivers: CapturePreflightDrivers
    private let excluding: [String]
    private let budgetNs: UInt64
    private let publication: PreflightPublication
    private var requested: (token: String, selection: String, revision: Int64, owner: String)?
    // One high-water mark per live connection prevents stop/start wire tasks
    // being admitted in the opposite order. No unbounded token tombstone list.
    private var intents: [String: Int64] = [:]
    private var running: (lease: Lease, microphone: (any MicrophonePreviewing)?)?
    private var tail = Task<Void, Never> {}
    private var pending = 0
    private var starts = 0
    private var screenshotPending = false
    private var drainTask: PreflightCompletion<Void>?

    init(catalog: any SourceCataloging, permissions: PermissionAdvisor,
         drivers: CapturePreflightDrivers, excluding: [String], budgetNs: UInt64 = 3_000_000_000,
         publish: @escaping @Sendable (ControlEvent) -> Void) {
        self.catalog = catalog; self.permissions = permissions; self.drivers = drivers
        self.excluding = excluding; self.budgetNs = budgetNs
        publication = PreflightPublication(sink: publish)
    }

    // Retired queued requests cannot acquire after their intent is invalidated.
    // Native ownership, not the scheduling of those skipped tasks, defines idle.
    var quiescent: Bool { requested == nil && running == nil && !screenshotPending && drainTask == nil }
    var pendingOperationCount: Int { pending }

    func start(_ params: [String: JSONValue], owner: String,
               connected: @escaping @Sendable () -> Bool) async throws -> JSONValue {
        let selection = try Self.token(params["selectionToken"])
        let revision = try Self.revision(params["selectionRevision"])
        guard connected(), revision > intents[owner, default: 0] else {
            throw ControlFailure(code: "cancelled", message: "Preview selection was superseded or cancelled.")
        }
        intents[owner] = revision
        let token = UUID().uuidString
        requested = (token, selection, revision, owner); publication.clear()
        guard starts < 2 else {
            requested = nil; _ = drainNative()
            throw ControlFailure(code: "preflight-busy", message: "Wait for the previous input to close.")
        }
        starts += 1
        let task = enqueue {
            try await self.acquireCounted(params, token: token, selection: selection,
                revision: revision, owner: owner, connected: connected)
        }
        do {
            let result = try await bounded(task)
            guard current(token), connected() else { throw ControlFailure(code: "cancelled", message: "Preview selection changed.") }
            return result
        } catch {
            if current(token) {
                requested = nil; publication.clear()
                _ = drainNative()
            }
            throw error
        }
    }

    func stop(owner: String, selection: String, revision: Int64) async throws -> Bool {
        guard revision >= intents[owner, default: 0] else { return quiescent }
        intents[owner] = revision
        if let requested, requested.owner == owner,
           requested.revision == revision, requested.selection != selection {
            throw ControlFailure(code: "invalid-params", message: "Preview selection did not match.")
        }
        guard requested?.owner == owner else {
            if let drainTask { _ = try await bounded(drainTask) }
            return quiescent
        }
        requested = nil; publication.clear()
        _ = try await bounded(drainNative())
        return quiescent
    }

    func disconnected(_ owner: String) async {
        intents.removeValue(forKey: owner)
        guard requested?.owner == owner else { return }
        requested = nil; publication.clear()
        _ = drainNative()
    }

    func stopAll() async throws {
        requested = nil; publication.clear()
        _ = try await bounded(drainNative())
    }

    func snapshot(owner: String, token: String) async throws -> JSONValue {
        guard current(token), let lease = running?.lease, lease.owner == owner,
              let surface = lease.surface else {
            throw ControlFailure(code: "cancelled", message: "This screen preview is no longer active.")
        }
        guard !screenshotPending else { throw ControlFailure(code: "preflight-busy", message: "A screen check is still finishing.") }
        screenshotPending = true
        // The next screenshot cannot begin until the previous native completion,
        // even if its caller's response budget expired.
        let deadline = DispatchTime.now() + .nanoseconds(Int(budgetNs))
        let task = enqueue { try await self.performSnapshot(lease, surface: surface, deadline: deadline) }
        return try await bounded(task)
    }

    private func performSnapshot(_ lease: Lease, surface: ScreenSurface, deadline: DispatchTime) async throws -> JSONValue {
        defer { screenshotPending = false }
        guard current(lease.token) else { throw ControlFailure(code: "cancelled") }
        guard DispatchTime.now() < deadline else { throw ControlFailure(code: "preflight-busy") }
        guard await permissions.check(.screen).state == .allowed else {
            throw ControlFailure(code: "permission-denied", message: "Screen access was revoked.")
        }
        guard current(lease.token) else { throw ControlFailure(code: "cancelled") }
        guard DispatchTime.now() < deadline else { throw ControlFailure(code: "preflight-busy") }
        let image = try await drivers.snapshot(surface, excluding).validated()
        guard current(lease.token) else { throw ControlFailure(code: "cancelled") }
        guard DispatchTime.now() < deadline else { throw ControlFailure(code: "preflight-busy") }
        return .object(["previewToken": .string(lease.token), "source": .string(lease.source),
            "jpeg": .string(image.jpeg.base64EncodedString()), "mime": .string("image/jpeg"),
            "width": .int(Int64(image.width)), "height": .int(Int64(image.height))])
    }

    private func drainNative() -> PreflightCompletion<Void> {
        if let drainTask { return drainTask }
        let task = enqueue { await self.performDrain() }
        drainTask = task
        return task
    }
    private func performDrain() async {
        defer { drainTask = nil }
        await releaseRunning()
    }

    private func enqueue<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T) -> PreflightCompletion<T> {
        let previous = tail
        let completion = PreflightCompletion<T>()
        pending += 1
        tail = Task<Void, Never> {
            await previous.value
            let result: Result<T, Error>
            do { result = .success(try await operation()) }
            catch { result = .failure(error) }
            pending -= 1
            completion.resolve(result)
        }
        return completion
    }

    private func bounded<T: Sendable>(_ completion: PreflightCompletion<T>) async throws -> T {
        try await completion.value(deadline: .now() + .nanoseconds(Int(budgetNs)))
    }

    private func current(_ token: String) -> Bool { requested?.token == token }

    private func acquireCounted(_ params: [String: JSONValue], token: String, selection: String, revision: Int64,
                                owner: String, connected: @escaping @Sendable () -> Bool) async throws -> JSONValue {
        defer { starts -= 1 }
        return try await acquire(params, token: token, selection: selection, revision: revision, owner: owner, connected: connected)
    }

    private func acquire(_ params: [String: JSONValue], token: String, selection: String, revision: Int64,
                         owner: String, connected: @escaping @Sendable () -> Bool) async throws -> JSONValue {
        await releaseRunning()
        guard current(token), connected() else { throw ControlFailure(code: "cancelled") }
        let mic = try Self.string(params["mic"], defaultValue: "none")
        var microphone: String?
        if mic != "none" {
            guard await permissions.check(.microphone).state == .allowed else {
                throw ControlFailure(code: "permission-denied", message: "Allow microphone access to test the selected input.")
            }
            let devices = try await catalog.microphones()
            microphone = mic == "default" ? devices.first?.id : devices.first(where: { $0.id == mic })?.id
            guard microphone != nil else { throw ControlFailure(code: "microphone-not-found", message: "The selected microphone disconnected.") }
        }
        let display = try Self.optionalString(params["display"]), window = try Self.optionalString(params["window"])
        guard !(display != nil && window != nil), !(window != nil && params["area"] != nil) else {
            throw ControlFailure(code: "invalid-params", message: "Choose one screen source.")
        }
        var surface: ScreenSurface?, source: String?
        if display != nil || window != nil {
            guard await permissions.check(.screen).state == .allowed else {
                throw ControlFailure(code: "permission-denied", message: "Allow screen access to preview this source.")
            }
            if let window {
                let windows = try await catalog.windows()
                guard let found = windows.first(where: { $0.id == window }),
                      !excluding.contains(found.owningApplication) else {
                    throw ControlFailure(code: "source-unavailable", message: "Choose an available window outside Rushes.")
                }
                source = window; surface = .window(id: window)
            } else if let display {
                let displays = try await catalog.displays()
                guard let found = display == "main" ? displays.first(where: \.isMain) : displays.first(where: { $0.id == display }) else {
                    throw ControlFailure(code: "source-unavailable", message: "The selected display disconnected.")
                }
                source = found.id
                if let area = params["area"] {
                    guard let value = area.object,
                          let x = value["x"]?.double, let y = value["y"]?.double,
                          let width = value["width"]?.double, let height = value["height"]?.double,
                          [x,y,width,height].allSatisfy(\.isFinite), width > 0, height > 0 else {
                        throw ControlFailure(code: "invalid-params", message: "Select a valid recording area.")
                    }
                    surface = .area(displayID: found.id, rect: CGRect(x: x, y: y, width: width, height: height))
                } else { surface = .display(id: found.id) }
            }
        } else if params["area"] != nil { throw ControlFailure(code: "invalid-params", message: "An area needs its display.") }
        guard current(token), connected() else { throw ControlFailure(code: "cancelled") }
        let lease = Lease(token: token, selection: selection, revision: revision, owner: owner, microphone: microphone, surface: surface, source: source)
        let monitor = microphone.map { _ in drivers.microphone() }
        running = (lease, monitor)
        publication.activate(token, microphone: microphone)
        do {
            if let microphone, let monitor {
                let publication = publication
                try await monitor.start(deviceID: microphone) { publication.publish($0, token: token) }
            }
            guard current(token), connected() else { throw ControlFailure(code: "cancelled") }
        } catch {
            await releaseRunning()
            throw error
        }
        return .object(["previewToken": .string(token), "selectionToken": .string(selection), "selectionRevision": .int(revision),
                        "microphone": .string(microphone), "source": .string(source)])
    }

    private func releaseRunning() async {
        let old = running; running = nil
        if let old { publication.clear(old.lease.token); await old.microphone?.stop() }
    }

    static func token(_ value: JSONValue?) throws -> String {
        guard let text = value?.string, UUID(uuidString: text) != nil else {
            throw ControlFailure(code: "invalid-params", message: "A preview selection token is required.")
        }
        return text
    }
    static func revision(_ value: JSONValue?) throws -> Int64 {
        guard let number = value?.int, number > 0, number <= 9_007_199_254_740_991 else {
            throw ControlFailure(code: "invalid-params", message: "A positive selection revision is required.")
        }
        return number
    }
    private static func string(_ value: JSONValue?, defaultValue: String) throws -> String {
        try optionalString(value) ?? defaultValue
    }
    private static func optionalString(_ value: JSONValue?) throws -> String? {
        guard let value else { return nil }
        guard let text = value.string, !text.isEmpty, text.utf8.count <= 300 else {
            throw ControlFailure(code: "invalid-params", message: "Invalid preview source identifier.")
        }
        return text
    }
}

/// Expired callers are removed instead of leaving one suspended Task behind a
/// hung operation on every retry. Native work has one completion and a bounded
/// set of live response waiters.
internal final class PreflightCompletion<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<T, Error>?
    private var waiters: [UUID: CheckedContinuation<T, Error>] = [:]
    var waiterCount: Int { lock.withLock { waiters.count } }
    func value(deadline: DispatchTime) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            let id = UUID()
            let immediate: Result<T, Error>? = lock.withLock {
                if let result { return result }
                guard waiters.count < 64 else { return .failure(Self.busy()) }
                waiters[id] = continuation
                return nil
            }
            if let immediate { continuation.resume(with: immediate); return }
            DispatchQueue.global().asyncAfter(deadline: deadline) { [self] in
                let expired = lock.withLock { waiters.removeValue(forKey: id) }
                expired?.resume(throwing: Self.busy())
            }
        }
    }
    func resolve(_ value: Result<T, Error>) {
        let pending: [CheckedContinuation<T, Error>] = lock.withLock {
            guard result == nil else { return [] }
            result = value; let found = Array(waiters.values); waiters.removeAll(); return found
        }
        for destination in pending { destination.resume(with: value) }
    }
    private static func busy() -> ControlFailure {
        .init(code: "preflight-busy",
            message: "A preview device is still opening or closing. Wait for cleanup, then try again.")
    }
}

private final class PreflightPublication: @unchecked Sendable {
    private let lock = NSLock()
    private var token: String?, microphone: String?
    private let sink: @Sendable (ControlEvent) -> Void
    init(sink: @escaping @Sendable (ControlEvent) -> Void) { self.sink = sink }
    func activate(_ token: String, microphone: String?) { lock.withLock { self.token = token; self.microphone = microphone } }
    func clear(_ expected: String? = nil) {
        lock.withLock {
            if let expected, token != expected { return }
            token = nil; microphone = nil
        }
    }
    func publish(_ level: MicrophoneLevels?, token expected: String) {
        let mic = lock.withLock { token == expected ? microphone : nil }
        guard let mic else { return }
        var payload: [String: JSONValue] = ["previewToken": .string(expected), "microphone": .string(mic),
            "available": .bool(level != nil), "measuredAtMs": .int(Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000))]
        if let level {
            payload["rms"] = .double(level.rms); payload["peak"] = .double(level.peak)
            payload["clipping"] = .bool(level.clipping); payload["frames"] = .int(Int64(level.frames))
        }
        sink(ControlEvent(kind: .microphoneLevel, result: .object(payload)))
    }
}

private actor GeneratedMicrophonePreview: MicrophonePreviewing {
    private var task: Task<Void, Never>?
    func start(deviceID: String, receive: @escaping @Sendable (MicrophoneLevels?) -> Void) async throws {
        guard deviceID == "mic-diagnostic" else { throw ControlFailure(code: "microphone-not-found") }
        task = Task {
            var index = 0
            while !Task.isCancelled {
                if let sample = SyntheticMedia.audioBuffer(channels: 1, hostNs: Int64(DispatchTime.now().uptimeNanoseconds)),
                   let block = CMSampleBufferGetDataBuffer(sample) {
                    let amplitude: Float = [0, 0.04, 0.2, 1.05][index % 4]
                    let values = [Float](repeating: amplitude, count: CMSampleBufferGetNumSamples(sample))
                    _ = values.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: $0.count) }
                    receive(MicrophoneLevels.measure(sample)); index += 1
                }
                do { try await Task.sleep(for: .milliseconds(100)) } catch { break }
            }
        }
    }
    func stop() async { let old = task; task = nil; old?.cancel(); await old?.value }
}
