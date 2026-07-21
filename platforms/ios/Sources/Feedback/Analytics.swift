import Foundation

/**
 Product analytics.

 Deliberately does NOT use `SubmissionQueue`. Reports and research responses are
 irreplaceable — a person typed them — so they persist to storage before any
 network call and retry for days. Events are individually worthless, valuable
 only in aggregate, and produced hundreds of times more often. Routing them
 through the same outbox would exhaust UserDefaults and evict the reports that
 outbox exists to protect.

 So events batch in memory, flush on a timer or when a batch fills, and are
 dropped on overflow. Losing a screen view is a rounding error; losing a bug
 report is a lost customer conversation.

 Mirrors `packages/core/src/analytics.ts` and `Analytics.kt`. The three must not
 drift.
 */
public final class Analytics {

    public struct Options {
        /// Events per batch. Reaching it triggers an immediate flush.
        public var batchSize: Int
        /// Flush cadence for traffic too slow to fill a batch.
        public var flushInterval: TimeInterval
        /// Ceiling on the buffer. Beyond it the OLDEST events are dropped:
        /// during an outage, recent behaviour explains current behaviour and
        /// the distant past does not.
        public var maxBuffered: Int

        public init(batchSize: Int = 25, flushInterval: TimeInterval = 15, maxBuffered: Int = 500) {
            self.batchSize = batchSize
            self.flushInterval = flushInterval
            self.maxBuffered = maxBuffered
        }
    }

    public struct Event: Encodable {
        public let id: String
        public let name: String
        public let properties: [String: String]?
        public let userId: String?
        public let sessionId: String
        public let timestamp: Int64
    }

    /// Seam so the batching logic is testable without a network.
    public protocol EventTransport: AnyObject {
        func sendEvents(_ events: [Event], device: DeviceContext) throws
    }

    private let transport: EventTransport
    private let consent: ConsentManager
    private let device: () -> DeviceContext
    private let options: Options
    private let log: (String) -> Void

    /// Serialises every mutation of the buffer. `track` is called from whatever
    /// thread the host app happens to be on.
    private let lock = NSLock()
    private var buffer: [Event] = []
    private var userId: String?
    private var timer: DispatchSourceTimer?

    private let queue = DispatchQueue(label: "io.markerusa.analytics", qos: .utility)
    public let sessionId = UUID().uuidString.lowercased()

    public init(
        transport: EventTransport,
        consent: ConsentManager,
        device: @escaping () -> DeviceContext,
        options: Options = Options(),
        log: @escaping (String) -> Void = { _ in }
    ) {
        self.transport = transport
        self.consent = consent
        self.device = device
        self.options = options
        self.log = log
    }

    deinit {
        timer?.cancel()
    }

    /// Begins periodic flushing. Safe to call more than once.
    public func start() {
        lock.lock()
        defer { lock.unlock() }
        guard timer == nil else { return }

        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + options.flushInterval, repeating: options.flushInterval)
        source.setEventHandler { [weak self] in
            _ = self?.flush()
        }
        source.resume()
        timer = source
    }

    /**
     Records an event.

     Consent is checked at flush rather than here, so a grant arriving between
     buffering and sending cannot retroactively authorise capture, and a
     revocation discards whatever is still buffered.
     */
    public func track(_ name: String, properties: [String: String]? = nil) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let event = Event(
            id: UUID().uuidString.lowercased(),
            name: String(trimmed.prefix(200)),
            properties: properties,
            userId: currentUserId(),
            sessionId: sessionId,
            timestamp: Int64(Date().timeIntervalSince1970 * 1000)
        )

        lock.lock()
        buffer.append(event)
        while buffer.count > options.maxBuffered { buffer.removeFirst() }
        let shouldFlush = buffer.count >= options.batchSize
        lock.unlock()

        if shouldFlush {
            queue.async { [weak self] in _ = self?.flush() }
        }
    }

    /// Associates subsequent events with a person.
    public func identify(_ user: Reporter) {
        lock.lock()
        userId = user.externalId ?? user.email
        lock.unlock()
    }

    public func identify(userId id: String) {
        lock.lock()
        userId = id
        lock.unlock()
    }

    private func currentUserId() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return userId
    }

    /**
     Sends whatever is buffered. Never throws.

     A failed batch is discarded rather than retried: retrying would grow the
     buffer during exactly the outage that caused the failure.
     */
    @discardableResult
    public func flush() -> Int {
        lock.lock()
        let batch = buffer
        buffer.removeAll()
        lock.unlock()

        guard !batch.isEmpty else { return 0 }

        // The gate. Without a grant the events are discarded, not held —
        // holding them would mean transmitting later on a consent never given
        // for the moment of capture.
        guard consent.has(.analytics) else {
            log("analytics: discarded \(batch.count) event(s), no consent")
            return 0
        }

        do {
            try transport.sendEvents(batch, device: device())
            return batch.count
        } catch {
            log("analytics: dropped \(batch.count) event(s): \(error.localizedDescription)")
            return 0
        }
    }

    /// Discards buffered events without sending. Used when consent is withdrawn.
    public func discard() {
        lock.lock()
        let dropped = buffer.count
        buffer.removeAll()
        lock.unlock()

        if dropped > 0 { log("analytics: discarded \(dropped) buffered event(s)") }
    }

    public func stop() {
        lock.lock()
        timer?.cancel()
        timer = nil
        lock.unlock()
        flush()
    }

    /// Exposed for tests and diagnostics.
    public func buffered() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return buffer.count
    }
}

/// Ships batches to the ingest service.
final class HTTPEventTransport: Analytics.EventTransport {
    private let projectId: String
    private let client: IngestClient

    init(projectId: String, client: IngestClient) {
        self.projectId = projectId
        self.client = client
    }

    private struct Batch: Encodable {
        let events: [Analytics.Event]
        let device: DeviceContext
    }

    func sendEvents(_ events: [Analytics.Event], device: DeviceContext) throws {
        let encoder = JSONEncoder()
        // Stable key order keeps the wire format diffable against the other two
        // platforms when chasing schema drift.
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(Batch(events: events, device: device))
        try client.sendEvents(data)
    }
}
