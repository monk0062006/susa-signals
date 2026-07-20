import Foundation

/**
 Durable outbox, mirroring core and Android.

 Stores the *already-serialized* submission and replays those exact bytes, so a
 schema change can never strand queued items behind a decoding failure.

 Retries are scheduled per item with exponential backoff rather than counted per
 flush. Without that, filing several reports during one outage burns every queued
 item's attempt budget within seconds — the queue would discard reports minutes
 into an outage it was built to survive for days. Constants match Android exactly;
 the three implementations must not drift.
 */
public final class SubmissionQueue {
    private enum Const {
        static let prefix = "markerio.outbox."
        static let attemptsPrefix = "markerio.attempts."
        static let nextAttemptPrefix = "markerio.nextAttempt."
        static let maxQueued = 20
        static let maxAttempts = 8
        static let baseBackoffMs: Int64 = 30_000
        /// Ceiling so a long-queued item still retries a few times a day.
        static let maxBackoffMs: Int64 = 6 * 60 * 60 * 1000
        /// Wide enough for millisecond epochs well past the year 5000.
        static let stampWidth = 13
    }

    public struct FlushResult: Equatable {
        public let sent: Int
        public let remaining: Int
    }

    private let storage: KeyValueStore
    private let client: SubmissionTransport
    private let now: () -> Int64

    public init(
        storage: KeyValueStore,
        client: SubmissionTransport,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.storage = storage
        self.client = client
        self.now = now
    }

    /// Persist first, deliver second. Never throws on network failure.
    @discardableResult
    public func enqueue(id: String, submissionJSON: Data) -> FlushResult {
        guard let body = String(data: submissionJSON, encoding: .utf8) else {
            return FlushResult(sent: 0, remaining: size())
        }

        // Key embeds a zero-padded timestamp so lexicographic order IS chronological
        // order. Keying by UUID alone would make "evict oldest" evict at random.
        let stamp = String(format: "%0\(Const.stampWidth)d", now())
        storage.set("\(Const.prefix)\(stamp).\(id)", body)
        storage.set("\(Const.attemptsPrefix)\(id)", "0")
        storage.set("\(Const.nextAttemptPrefix)\(id)", "0") // due immediately

        evictOverflow()
        return flush()
    }

    @discardableResult
    public func flush() -> FlushResult {
        // Oldest first, so a persistent failure at the head cannot starve the tail
        // of its retry budget.
        let keys = storage.keys(prefix: Const.prefix).sorted()
        let currentTime = now()
        var sent = 0

        for key in keys {
            guard let id = id(fromKey: key) else { continue }

            // Not yet due. Skipping is what stops rapid flushes from consuming the
            // retry budget of items that have not had a fair chance to succeed.
            let dueAt = Int64(storage.get("\(Const.nextAttemptPrefix)\(id)") ?? "") ?? 0
            if currentTime < dueAt { continue }

            guard let body = storage.get(key), let data = body.data(using: .utf8) else { continue }
            let attempts = Int(storage.get("\(Const.attemptsPrefix)\(id)") ?? "") ?? 0

            do {
                try client.submit(submissionJSON: data, idempotencyKey: id)
                drop(key: key, id: id)
                sent += 1
            } catch let error as IngestError {
                let next = attempts + 1
                // Drop permanently-rejected items and ones we have given up on, so a
                // single poison submission cannot block everything behind it.
                if !error.retryable || next >= Const.maxAttempts {
                    drop(key: key, id: id)
                } else {
                    storage.set("\(Const.attemptsPrefix)\(id)", String(next))
                    storage.set("\(Const.nextAttemptPrefix)\(id)", String(currentTime + backoff(for: next)))
                }
            } catch {
                // Unexpected error type: treat as retryable rather than discarding
                // a report the user wrote.
                let next = attempts + 1
                if next >= Const.maxAttempts {
                    drop(key: key, id: id)
                } else {
                    storage.set("\(Const.attemptsPrefix)\(id)", String(next))
                    storage.set("\(Const.nextAttemptPrefix)\(id)", String(currentTime + backoff(for: next)))
                }
            }
        }

        return FlushResult(sent: sent, remaining: size())
    }

    public func size() -> Int {
        storage.keys(prefix: Const.prefix).count
    }

    /// 30s, 1m, 2m, 4m … capped at 6h.
    private func backoff(for attempts: Int) -> Int64 {
        let exponent = min(max(attempts - 1, 0), 20)
        let delay = Const.baseBackoffMs << exponent
        return (delay <= 0 || delay > Const.maxBackoffMs) ? Const.maxBackoffMs : delay
    }

    /// Key layout: `markerio.outbox.<13-digit stamp>.<uuid>`
    private func id(fromKey key: String) -> String? {
        let withoutPrefix = key.dropFirst(Const.prefix.count)
        guard let dot = withoutPrefix.firstIndex(of: ".") else { return nil }
        let id = String(withoutPrefix[withoutPrefix.index(after: dot)...])
        return id.isEmpty ? nil : id
    }

    private func drop(key: String, id: String) {
        storage.remove(key)
        storage.remove("\(Const.attemptsPrefix)\(id)")
        storage.remove("\(Const.nextAttemptPrefix)\(id)")
    }

    /// Drops oldest-first on overflow. A stale report is worth less than the fresh
    /// one the user just took the trouble to write.
    private func evictOverflow() {
        let keys = storage.keys(prefix: Const.prefix).sorted()
        guard keys.count > Const.maxQueued else { return }
        for key in keys.prefix(keys.count - Const.maxQueued) {
            if let id = id(fromKey: key) {
                drop(key: key, id: id)
            }
        }
    }
}
