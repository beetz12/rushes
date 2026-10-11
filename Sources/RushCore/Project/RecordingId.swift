import Foundation

/// Recording ids: 26-character ULIDs that sort by creation time.
///
/// The id is the agent-facing handle for a take (docs/PLAN.md, Package
/// layout: "The recording id is a ULID: a 26-character unique id that sorts
/// by creation time"). Ten characters encode the millisecond timestamp and
/// sixteen encode 80 bits of randomness, both in Crockford base 32, so ids
/// generated in order compare in lexicographic order. The first six
/// characters also appear in the package folder name.
public enum RecordingId {

    public static let length = 26

    /// Crockford base 32 alphabet (no I, L, O, U).
    static let alphabet: [Character] = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// Generates a new id for now with system randomness.
    public static func generate() -> String {
        generate(date: Date(), randomBytes: secureRandomBytes)
    }

    /// Generates the id for `date` with injectable randomness (tests use
    /// deterministic bytes).
    public static func generate(date: Date, randomBytes: () -> [UInt8]) -> String {
        let ms = UInt64(max(0, date.timeIntervalSince1970 * 1000).rounded())
        return encode(timestampMs: ms, randomness: randomBytes())
    }

    /// Assembles the id from its two halves.
    public static func encode(timestampMs: UInt64, randomness: [UInt8]) -> String {
        String(encodeTime(timestampMs) + encodeRandom(randomness))
    }

    /// Whether `id` is shaped like a recording id.
    public static func isValid(_ id: String) -> Bool {
        id.count == length && id.allSatisfy { alphabet.contains($0) }
    }

    /// The six characters used in the package folder name.
    public static func folderPrefix(_ id: String) -> String {
        String(id.prefix(6))
    }

    /// Ten base-32 characters for the 48-bit millisecond timestamp,
    /// most significant character first.
    private static func encodeTime(_ ms: UInt64) -> [Character] {
        var remaining = ms
        var chars = [Character](repeating: "0", count: 10)
        var index = chars.count - 1
        while index >= 0 {
            chars[index] = alphabet[Int(remaining & 0x1f)]
            remaining >>= 5
            index -= 1
        }
        return chars
    }

    /// Sixteen base-32 characters for ten random bytes (80 bits), most
    /// significant character first.
    private static func encodeRandom(_ bytes: [UInt8]) -> [Character] {
        precondition(bytes.count == 10, "ULID randomness is 80 bits")
        let charCount = 16
        var chars = [Character](repeating: "0", count: charCount)
        for charIndex in 0..<charCount {
            var value = 0
            for bit in 0..<5 {
                // Bit 0 is the least significant bit of the last byte.
                let bitIndex = (charCount - 1 - charIndex) * 5 + bit
                let byteIndex = bytes.count - 1 - bitIndex / 8
                let bitInByte = UInt8(bitIndex % 8)
                let bit = (bytes[byteIndex] >> bitInByte) & 1
                value = (value << 1) | Int(bit)
            }
            chars[charIndex] = alphabet[value]
        }
        return chars
    }

    /// 80 bits from the system generator.
    static func secureRandomBytes() -> [UInt8] {
        var generator = SystemRandomNumberGenerator()
        return (0..<10).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
    }
}
