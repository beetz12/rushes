import Foundation

/// Correlates a JPEG with the camera lifetime that produced it. The token stays
/// attached through the socket's best-effort mailbox; it is not authorization.
internal final class PreviewPublication: @unchecked Sendable {
    private let lock = NSLock()
    private var enabled = false
    private var token: String?
    private var sink: (@Sendable (ControlEvent) -> Void)?

    var currentToken: String? { lock.withLock { token } }
    var isEnabled: Bool { lock.withLock { enabled } }
    func activate(_ value: String) { lock.withLock { token = value } }
    func invalidate(_ expected: String? = nil) {
        lock.withLock {
            if let expected, token != expected { return }
            token = nil
        }
    }
    func setEnabled(_ value: Bool) { lock.withLock { enabled = value } }
    func setSink(_ value: @escaping @Sendable (ControlEvent) -> Void) {
        lock.withLock { sink = value }
    }
    func publish(_ jpeg: Data, token capturedToken: String) {
        let destination = lock.withLock { enabled && token == capturedToken ? sink : nil }
        destination?(ControlEvent(kind: .cameraPreview, result: .object([
            "jpeg": .string(jpeg.base64EncodedString()), "mime": .string("image/jpeg"),
            "mirrored": .bool(true), "previewToken": .string(capturedToken)
        ])))
    }
}
