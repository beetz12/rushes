import AppKit
import AVFoundation
import CoreMedia
import Dispatch
import Foundation

/// The selftest's synchronized signal, as the controller sees it: prepare,
/// fire at a host instant, stop. `SelftestSignalEmitter` is the production
/// conformer; tests inject a no-op so the command path runs headless without
/// flashing a window or playing a tone on the machine running the suite.
public protocol SelftestSignaling: Sendable {
    /// Creates resources ahead of time; throws when the signal cannot run
    /// (for example, no audio output device).
    func prepare() throws
    /// Schedules the flash and the tone for the same host instant.
    func fire(atHostNs hostNs: Int64)
    /// Releases everything. Safe to call twice.
    func stop()
}

/// The selftest's synchronized signal: a full-screen white window flashed on
/// the main display plus a tone played through the default output, both at
/// one named host instant (docs/PLAN.md, Roadmap Phase 1 item 9: "the engine
/// flashes a full-screen white window and plays a tone at the same host
/// time").
///
/// The window is borderless, non-activating and click-through, so flashing it
/// never steals keyboard focus; in selftest mode only, the capture filter
/// includes this window and the system-audio stream includes our own tone
/// (`ScreenExclusionList.bundleIDs(selftest:)` and
/// `excludesOwnProcessAudio`), which normal recordings exclude.
public final class SelftestSignalEmitter: @unchecked Sendable, SelftestSignaling {

    /// Problems preparing the signal.
    public enum SignalError: Error, CustomStringConvertible, Sendable {
        case audioOutputUnavailable(String)

        public var description: String {
            switch self {
            case .audioOutputUnavailable(let detail):
                return "the test tone could not start: \(detail)"
            }
        }
    }

    private let lock = NSLock()
    private var window: NSWindow?
    private var flashTimers: [DispatchSourceTimer] = []
    private let tonePlayer = SelftestTonePlayer()

    /// Tone shape: 440 Hz, 400 ms, a comfortable level. A sustained tone
    /// (not a click) gives the energy onset a clean, flat plateau to find.
    private static let toneFrequency: Float = 440
    private static let toneDurationSeconds: Double = 0.4
    private static let toneAmplitude: Float = 0.6
    /// How long the white window stays on screen.
    private static let flashDurationNs: UInt64 = 200_000_000

    private var toneBuffer: AVAudioPCMBuffer?

    public init() {}

    /// Creates the window and starts the audio engine, so `fire` only has to
    /// schedule. Throws when no default audio output can start; the caller
    /// reports that instead of recording a useless take.
    public func prepare() throws {
        try tonePlayer.prepare()
        let buffer = try SelftestTonePlayer.makeToneBuffer(
            frequency: Self.toneFrequency,
            durationSeconds: Self.toneDurationSeconds,
            amplitude: Self.toneAmplitude)
        lock.lock()
        self.toneBuffer = buffer
        lock.unlock()
        createWindowOnMainThread()
    }

    /// Schedules the flash and the tone for the same host instant `hostNs`
    /// (nanoseconds on the mach clock, the same clock
    /// `DispatchTime.now().uptimeNanoseconds` reads). Both are scheduled
    /// ahead of time; whatever jitter remains is part of what the selftest
    /// measures in the recorded files.
    public func fire(atHostNs hostNs: Int64) {
        lock.lock()
        let buffer = toneBuffer
        let window = self.window
        lock.unlock()
        if let buffer {
            tonePlayer.play(buffer, atHostNs: hostNs)
        }
        guard let window else { return }
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
        timer.schedule(deadline: DispatchTime(uptimeNanoseconds: UInt64(clamping: hostNs)))
        // The handler must not capture the timer itself (a source holding a
        // closure holding the source never deallocates); the array owns the
        // timer and is cleared in `stop`.
        timer.setEventHandler {
            window.orderFrontRegardless()
            DispatchQueue.main.asyncAfter(
                deadline: .now() + DispatchTimeInterval.nanoseconds(Int(Self.flashDurationNs))
            ) {
                window.orderOut(nil)
            }
        }
        timer.resume()
        lock.lock()
        flashTimers.append(timer)
        lock.unlock()
    }

    /// Stops the tone engine and closes the window. Safe to call twice.
    public func stop() {
        tonePlayer.stop()
        lock.lock()
        let window = self.window
        let timers = flashTimers
        flashTimers = []
        self.window = nil
        lock.unlock()
        for timer in timers { timer.cancel() }
        if let window {
            DispatchQueue.main.async {
                window.orderOut(nil)
            }
        }
    }



    /// Window creation happens on the main thread (AppKit's rule). The window
    /// is never ordered front here; it exists only to be flashed later.
    private func createWindowOnMainThread() {
        DispatchQueue.main.sync {
            let application = NSApplication.shared
            // Faceless engine: no Dock presence, no activation, no focus
            // stealing. Accessory apps may still order windows front.
            application.setActivationPolicy(.accessory)
            guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
            let window = NSWindow(
                contentRect: screen.frame,
                styleMask: .borderless,
                backing: .buffered,
                defer: false)
            window.backgroundColor = .white
            window.isOpaque = true
            window.level = .screenSaver
            window.ignoresMouseEvents = true
            window.hidesOnDeactivate = false
            window.collectionBehavior = [
                .canJoinAllSpaces, .fullScreenAuxiliary,
            ]
            lock.lock()
            self.window = window
            lock.unlock()
        }
    }
}

// MARK: - Tone player

/// A prepared `AVAudioEngine` whose player node starts at a named host time
/// (`AVAudioTime(hostTime:)`), so the tone and the window flash share one
/// scheduled instant.
final class SelftestTonePlayer: @unchecked Sendable {

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let stateLock = NSLock()
    private var prepared = false

    func prepare() throws {
        try stateLock.withLock {
            guard !prepared else { return }
            let format = AVAudioFormat(
                standardFormatWithSampleRate: 48_000, channels: 1)
                ?? AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            engine.prepare()
            do {
                try engine.start()
            } catch {
                throw SelftestSignalEmitter.SignalError.audioOutputUnavailable(
                    String(describing: error))
            }
            prepared = true
        }
    }

    /// Plays `buffer` starting at host instant `hostNs`.
    func play(_ buffer: AVAudioPCMBuffer, atHostNs hostNs: Int64) {
        let hostTicks = Self.machTicks(fromHostNanoseconds: hostNs)
        player.scheduleBuffer(buffer, at: nil, options: [], completionHandler: nil)
        player.play(at: AVAudioTime(hostTime: hostTicks))
    }

    func stop() {
        stateLock.lock()
        let wasPrepared = prepared
        stateLock.unlock()
        guard wasPrepared else { return }
        player.stop()
        engine.stop()
    }

    /// Nanoseconds on the mach clock to mach ticks (AVAudioTime's unit).
    static func machTicks(fromHostNanoseconds ns: Int64) -> UInt64 {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        let value = Double(ns) * Double(info.denom) / Double(info.numer)
        return UInt64(max(0, value.rounded()))
    }

    /// One sine-wave tone buffer at 48 kHz mono Float32.
    static func makeToneBuffer(
        frequency: Float, durationSeconds: Double, amplitude: Float
    ) throws -> AVAudioPCMBuffer {
        let sampleRate: Double = 48_000
        let frameCount = AVAudioFrameCount(sampleRate * durationSeconds)
        guard let format = AVAudioFormat(
            standardFormatWithSampleRate: sampleRate, channels: 1) else {
            throw SelftestSignalEmitter.SignalError.audioOutputUnavailable(
                "no 48 kHz mono format")
        }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
            throw SelftestSignalEmitter.SignalError.audioOutputUnavailable(
                "could not allocate the tone buffer")
        }
        buffer.frameLength = frameCount
        guard let channels = buffer.floatChannelData else {
            throw SelftestSignalEmitter.SignalError.audioOutputUnavailable(
                "the tone buffer has no channel data")
        }
        let samples = channels[0]
        // A 5 ms linear fade in and out keeps the onset sharp (the attack is
        // what the detector finds) without a click at the very start.
        let fadeFrames = AVAudioFrameCount(sampleRate * 0.005)
        for frame in 0..<Int(frameCount) {
            var gain: Float = 1
            if frame < fadeFrames {
                gain = Float(frame) / Float(fadeFrames)
            } else if frame >= Int(frameCount) - Int(fadeFrames) {
                gain = Float(Int(frameCount) - frame) / Float(fadeFrames)
            }
            let t = Float(frame) / Float(sampleRate)
            samples[frame] = amplitude * gain * sin(2 * Float.pi * frequency * t)
        }
        return buffer
    }
}

extension NSLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
