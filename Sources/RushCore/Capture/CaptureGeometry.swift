import CoreGraphics
import Foundation

/// The active source rectangle in global top-left screen points. It is
/// independent of output pixel dimensions and can change when a window moves.
public struct CaptureGeometry: Codable, Equatable, Sendable {
    public let mode: String
    public let rect: CaptureArea
    public let displayID: String?

    public var jsonValue: JSONValue {
        var fields: [String: JSONValue] = ["mode": .string(mode), "rect": .object([
            "x": .double(rect.x), "y": .double(rect.y),
            "width": .double(rect.width), "height": .double(rect.height)])]
        if let displayID { fields["displayID"] = .string(displayID) }
        return .object(fields)
    }

    /// Read-only metadata; no SCShareableContent, permission request or device
    /// lifecycle. Production calls this only for an already-active screen rig.
    public static func current(for request: SessionRequest) -> CaptureGeometry? {
        resolve(for: request, displayRect: { id in
            guard let number = canonicalNumber(id, prefix: "display-"), CGDisplayIsActive(number) != 0 else { return nil }
            return CGDisplayBounds(number)
        }, windowRect: { id in
            guard let number = canonicalNumber(id, prefix: "window-"),
                  let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, number) as? [[String: Any]],
                  let row = rows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == number }),
                  let dimensions = row[kCGWindowBounds as String] as? [String: Any] else { return nil }
            return CGRect(dictionaryRepresentation: dimensions as CFDictionary)
        })
    }

    /// Diagnostic rigs use a synthetic origin and their declared dimensions;
    /// they must never query the actual user's window server.
    public static func synthetic(for request: SessionRequest) -> CaptureGeometry? {
        let dimensions = request.screenDimensions ?? .init(width: 1920, height: 1080)
        let frame = CGRect(x: 0, y: 0, width: dimensions.width, height: dimensions.height)
        return resolve(for: request, displayRect: { _ in frame }, windowRect: { _ in frame })
    }

    internal static func resolve(for request: SessionRequest,
                                 displayRect: (String) -> CGRect?, windowRect: (String) -> CGRect?) -> CaptureGeometry? {
        let frame: CGRect?
        let mode: String
        let displayID: String?
        switch request.screen {
        case .display(let id): frame = displayRect(id); mode = "display"; displayID = id
        case .area(let id, let area): frame = area.cgRect; mode = "area"; displayID = id
        case .window(let id): frame = windowRect(id); mode = "window"; displayID = nil
        case nil: return nil
        }
        guard let frame, frame.origin.x.isFinite, frame.origin.y.isFinite,
              frame.width.isFinite, frame.height.isFinite, frame.width > 0, frame.height > 0 else { return nil }
        return .init(mode: mode, rect: .init(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height), displayID: displayID)
    }
    private static func canonicalNumber(_ id: String, prefix: String) -> UInt32? {
        guard id.hasPrefix(prefix), let number = UInt32(id.dropFirst(prefix.count)), number > 0,
              id == prefix + String(number) else { return nil }
        return number
    }
}
