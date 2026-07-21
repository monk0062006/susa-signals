#if canImport(UIKit)
import UIKit

/**
 Session replay for iOS.

 rrweb records DOM mutations, which is why web replay is small and sharp. There
 is no DOM here, so this captures frames — the approach UXCam and Smartlook
 take. That difference drives every constraint below: frames cost CPU, battery
 and bandwidth in a way mutation records do not, so the defaults are
 deliberately conservative.

 A researcher watching back at 1fps loses nothing that matters; a user whose
 battery drains loses trust immediately.

 Mirrors `FrameRecorder.kt`.
 */
public final class FrameRecorder {

    public struct Options {
        /// Frames per second. One is enough to follow intent; more is video.
        public var fps: Double
        /// Longest edge in points, downscaled from whatever the device is.
        public var maxEdge: CGFloat
        /// JPEG quality. Frames are UI, not photographs.
        public var quality: CGFloat
        /// Hard ceiling per session, so a forgotten screen cannot stream forever.
        public var maxFrames: Int
        /// Frames per uploaded chunk.
        public var chunkSize: Int

        public init(
            fps: Double = 1,
            maxEdge: CGFloat = 480,
            quality: CGFloat = 0.55,
            maxFrames: Int = 900,
            chunkSize: Int = 15
        ) {
            self.fps = fps
            self.maxEdge = maxEdge
            self.quality = quality
            self.maxFrames = maxFrames
            self.chunkSize = chunkSize
        }
    }

    /// One captured frame, already masked and encoded.
    public struct Frame {
        public let id: String
        public let timestampMs: Int64
        public let jpeg: Data
        public let width: Int
        public let height: Int
    }

    /// Seam so the recorder is testable without a network.
    public protocol FrameUploading: AnyObject {
        func upload(sessionId: String, seq: Int, frames: [Frame], final: Bool) throws
    }

    private let consent: ConsentManager
    private let uploader: FrameUploading
    private let options: Options
    private let log: (String) -> Void

    private let queue = DispatchQueue(label: "io.markerusa.replay", qos: .utility)
    private let lock = NSLock()

    private var timer: DispatchSourceTimer?
    private var sessionId: String?
    private var pending: [Frame] = []
    private var frameCount = 0
    private var seq = 0
    private var running = false

    public init(
        consent: ConsentManager,
        uploader: FrameUploading,
        options: Options = Options(),
        log: @escaping (String) -> Void = { _ in }
    ) {
        self.consent = consent
        self.uploader = uploader
        self.options = options
        self.log = log
    }

    deinit {
        timer?.cancel()
    }

    public func currentSessionId() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return sessionId
    }

    /**
     Starts recording, or does nothing if consent is absent.

     Returns the session id on success and nil otherwise, so callers can tell
     "recording" from "silently not recording" — a distinction that matters when
     a researcher is waiting on data that will never arrive.
     */
    @discardableResult
    public func start() -> String? {
        lock.lock()
        if running {
            defer { lock.unlock() }
            return sessionId
        }
        lock.unlock()

        // The gate. Never record without an explicit, current grant.
        guard consent.has(.sessionReplay) else {
            log("replay not started: no session_replay consent")
            return nil
        }

        let id = UUID().uuidString.lowercased()

        lock.lock()
        sessionId = id
        frameCount = 0
        seq = 0
        pending.removeAll()
        running = true
        lock.unlock()

        let interval = 1.0 / max(options.fps, 0.2)
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + interval, repeating: interval)
        source.setEventHandler { [weak self] in self?.captureFrame() }
        source.resume()
        timer = source

        log("replay started (session \(id))")
        return id
    }

    /// Stops recording and flushes the tail as the final chunk.
    public func stop() {
        lock.lock()
        guard running else {
            lock.unlock()
            return
        }
        running = false
        lock.unlock()

        timer?.cancel()
        timer = nil
        flush(final: true)
        log("replay stopped")
    }

    /**
     Stops and discards anything not yet uploaded. Called when consent is
     withdrawn, at which point buffered frames must not be transmitted.
     */
    public func abandon() {
        lock.lock()
        running = false
        let dropped = pending.count
        pending.removeAll()
        lock.unlock()

        timer?.cancel()
        timer = nil
        log("replay abandoned; \(dropped) buffered frame(s) discarded")
    }

    // MARK: - capture

    private func captureFrame() {
        lock.lock()
        let active = running
        let count = frameCount
        lock.unlock()

        guard active else { return }

        if count >= options.maxFrames {
            log("replay hit frame cap; stopping")
            stop()
            return
        }

        // UIKit geometry and rendering are main-thread only. The encode is the
        // expensive part and happens back on the recorder queue.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }

            guard let window = ScreenCapture.activeWindow() else { return }
            let bounds = window.bounds
            guard bounds.width > 0, bounds.height > 0 else { return }

            let regions = FrameMasker.sensitiveRegions(in: window)
            let scale = self.scaleFor(bounds.size)

            let format = UIGraphicsImageRendererFormat()
            format.scale = scale
            format.opaque = true

            let image = UIGraphicsImageRenderer(bounds: bounds, format: format).image { ctx in
                // afterScreenUpdates: false — true forces a synchronous layout
                // pass and can deadlock inside a view lifecycle callback.
                if !window.drawHierarchy(in: bounds, afterScreenUpdates: false) {
                    window.layer.render(in: ctx.cgContext)
                }
                // Masking last, over the rendered content, in the same
                // coordinate space so a region cannot cover the wrong pixels.
                FrameMasker.apply(regions, in: ctx.cgContext, scale: 1)
            }

            self.queue.async { self.encodeAndBuffer(image) }
        }
    }

    private func scaleFor(_ size: CGSize) -> CGFloat {
        let longest = max(size.width, size.height)
        guard longest > options.maxEdge else { return 1 }
        return options.maxEdge / longest
    }

    private func encodeAndBuffer(_ image: UIImage) {
        // JPEG, not PNG: frames are numerous and photographic-ish, and PNG would
        // multiply bandwidth for detail nobody watches.
        guard let data = image.jpegData(compressionQuality: options.quality) else { return }

        let frame = Frame(
            id: UUID().uuidString.lowercased(),
            timestampMs: Int64(Date().timeIntervalSince1970 * 1000),
            jpeg: data,
            width: Int(image.size.width * image.scale),
            height: Int(image.size.height * image.scale)
        )

        lock.lock()
        frameCount += 1
        pending.append(frame)
        let ready: [Frame]? = pending.count >= options.chunkSize ? pending : nil
        if ready != nil { pending.removeAll() }
        lock.unlock()

        if let ready { upload(ready, final: false) }
    }

    private func flush(final: Bool) {
        lock.lock()
        let ready = pending
        pending.removeAll()
        lock.unlock()

        if !ready.isEmpty || final { upload(ready, final: final) }
    }

    private func upload(_ frames: [Frame], final: Bool) {
        lock.lock()
        guard let session = sessionId else {
            lock.unlock()
            return
        }
        let index = seq
        seq += 1
        lock.unlock()

        do {
            try uploader.upload(sessionId: session, seq: index, frames: frames, final: final)
        } catch {
            // Replay is explicitly best-effort: dropped rather than retried.
            // Persisting it would compete with the report outbox for storage,
            // and a gap in a recording is far cheaper than losing a report the
            // user actually wrote.
            log("replay chunk \(index) dropped: \(error.localizedDescription)")
        }
    }
}
#endif
