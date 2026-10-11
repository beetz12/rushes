import CoreMedia

/// Exact integer conversions between `CMTime` and nanosecond counters.
///
/// Media and host instants inside the writers are carried as Int64
/// nanoseconds (`SessionClock`'s unit). Going through `CMTimeGetSeconds`
/// loses precision at host-clock magnitudes, so every conversion is done in
/// `Int128` and truncated towards zero.
extension CMTime {

    /// Nanoseconds of this time, or nil when the time is invalid or has no
    /// finite timescale.
    var nanosecondsI64: Int64? {
        guard isValid && timescale > 0 else { return nil }
        let ns = Int128(value) * 1_000_000_000 / Int128(timescale)
        return Int64(clamping: ns)
    }
}

extension CMTime {

    /// A valid `CMTime` carrying exactly `ns` nanoseconds (timescale 1e9, so
    /// every Int64 nanosecond count is representable).
    init(exactNanoseconds ns: Int64) {
        self = CMTime(value: ns, timescale: 1_000_000_000)
    }
}
