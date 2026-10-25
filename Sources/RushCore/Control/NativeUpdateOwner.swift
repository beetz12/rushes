import Darwin
import Foundation

/// Only a shell-launched engine can reserve an update hold. Parent identity is
/// checked as well as PID liveness so reparenting cannot preserve an orphan.
public struct NativeUpdateOwner: Sendable {
    public let parentPID: Int32
    internal let isAlive: @Sendable () -> Bool
    internal let requestTermination: @Sendable () -> Void
    internal let pollIntervalNs: UInt64

    public init(parentPID: Int32, requestTermination: @escaping @Sendable () -> Void) {
        self.init(parentPID: parentPID, isAlive: {
            Self.parentIsAlive(parentPID, currentParent: getppid(), exists: { kill($0, 0) == 0 })
        }, requestTermination: requestTermination)
    }

    internal init(parentPID: Int32, isAlive: @escaping @Sendable () -> Bool,
                  pollIntervalNs: UInt64 = 1_000_000_000,
                  requestTermination: @escaping @Sendable () -> Void) {
        self.parentPID = parentPID
        self.isAlive = isAlive
        self.pollIntervalNs = pollIntervalNs
        self.requestTermination = requestTermination
    }

    internal static func parentIsAlive(_ captured: Int32, currentParent: Int32,
                                      exists: (Int32) -> Bool) -> Bool {
        captured > 1 && currentParent == captured && exists(captured)
    }
}
