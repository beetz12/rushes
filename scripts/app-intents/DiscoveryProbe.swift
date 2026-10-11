import ExtensionFoundation
import Foundation

@main
struct IntentExtensionDiscoveryProbe {
    static func main() async throws {
        let identifier = CommandLine.arguments.dropFirst().first ?? "com.nexai.rushes.intentqa.extension"
        let identities = try AppExtensionIdentity.matching(appExtensionPointIDs: "com.apple.appintents-extension")
        for await available in identities {
            let matches = available.filter { $0.bundleIdentifier == identifier }
            let result: [String: Any] = ["bundleIdentifier": identifier, "matchingRegisteredExtensions": matches.count,
                "extensions": matches.map { ["id": $0.id, "name": $0.localizedName, "point": $0.extensionPointIdentifier] }]
            let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            print(String(decoding: data, as: UTF8.self))
            return
        }
    }
}
