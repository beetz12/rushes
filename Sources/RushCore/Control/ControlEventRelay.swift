import Foundation

/// Bounded services publish through the current socket broadcast without
/// retaining the controller or sending raw recognition text to diagnostics.
final class ControlEventRelay: @unchecked Sendable {
    private let lock = NSLock()
    private var sink: (@Sendable (ControlEvent) -> Void)?
    func setSink(_ value: @escaping @Sendable (ControlEvent) -> Void) { lock.withLock { sink = value } }
    func publish(_ event: ControlEvent) { let callback = lock.withLock { sink }; callback?(event) }
}
