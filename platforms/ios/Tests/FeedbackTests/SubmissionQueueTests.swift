import XCTest
@testable import Feedback

/// Mirrors `SubmissionQueueTest.kt`, including the backoff regression that was
/// discarding reports minutes into an outage.
final class SubmissionQueueTests: XCTestCase {

    /// Stands in for the network without one.
    private final class FakeClient: SubmissionTransport {
        var failWith: IngestError?
        var submitted: [String] = []
        var calls = 0

        init(failWith: IngestError? = nil) {
            self.failWith = failWith
        }

        func submit(submissionJSON: Data, idempotencyKey: String) throws {
            calls += 1
            if let failWith { throw failWith }
            submitted.append(idempotencyKey)
        }
    }

    private func json(_ text: String) -> Data {
        text.data(using: .utf8)!
    }

    func testSuccessfulSubmitClearsTheItem() {
        let client = FakeClient()
        let queue = SubmissionQueue(storage: InMemoryStore(), client: client) { 1_000 }

        let result = queue.enqueue(id: "id-1", submissionJSON: json(#"{"id":"id-1"}"#))

        XCTAssertEqual(result.sent, 1)
        XCTAssertEqual(result.remaining, 0)
        XCTAssertEqual(client.submitted, ["id-1"])
    }

    func testRetryableFailureKeepsItemForLaterFlush() {
        let client = FakeClient(failWith: IngestError(message: "offline", status: nil, retryable: true))
        let store = InMemoryStore()
        var clock: Int64 = 1_000
        let queue = SubmissionQueue(storage: store, client: client) { clock }

        let result = queue.enqueue(id: "id-1", submissionJSON: json(#"{"id":"id-1"}"#))
        XCTAssertEqual(result.sent, 0)
        XCTAssertEqual(result.remaining, 1)

        // Network comes back, but the item is still inside its backoff window.
        client.failWith = nil
        XCTAssertEqual(queue.flush().sent, 0)

        // Past the backoff: the stored bytes are replayed verbatim.
        clock += 31_000
        XCTAssertEqual(queue.flush().sent, 1)
        XCTAssertEqual(queue.size(), 0)
    }

    func testBackoffStopsRapidFlushesFromBurningRetryBudget() {
        let client = FakeClient(failWith: IngestError(message: "offline", status: nil, retryable: true))
        let clock: Int64 = 1_000
        let queue = SubmissionQueue(storage: InMemoryStore(), client: client) { clock }

        queue.enqueue(id: "id-1", submissionJSON: json(#"{"id":"id-1"}"#))
        let callsAfterEnqueue = client.calls

        // Simulates a burst of reports during one outage, each triggering a flush.
        for _ in 0..<50 { queue.flush() }

        // The item must not have been retried 50 times, and must still be queued.
        XCTAssertEqual(client.calls, callsAfterEnqueue)
        XCTAssertEqual(queue.size(), 1)
    }

    func testPermanentRejectionDropsItem() {
        let client = FakeClient(failWith: IngestError(message: "bad request", status: 400, retryable: false))
        let queue = SubmissionQueue(storage: InMemoryStore(), client: client) { 1_000 }

        let result = queue.enqueue(id: "id-1", submissionJSON: json(#"{"id":"id-1"}"#))

        XCTAssertEqual(result.sent, 0)
        // A 400 will never become a 200; keeping it would block the queue forever.
        XCTAssertEqual(result.remaining, 0)
    }

    func testPoisonItemAbandonedAfterAttemptLimit() {
        let client = FakeClient(failWith: IngestError(message: "server down", status: 500, retryable: true))
        var clock: Int64 = 1_000
        let queue = SubmissionQueue(storage: InMemoryStore(), client: client) { clock }

        queue.enqueue(id: "id-1", submissionJSON: json(#"{"id":"id-1"}"#))

        for _ in 0..<12 {
            clock += 7 * 60 * 60 * 1000 // beyond the 6h cap
            queue.flush()
        }

        XCTAssertEqual(queue.size(), 0)
    }

    func testOverflowEvictsOldestFirst() {
        let client = FakeClient(failWith: IngestError(message: "offline", status: nil, retryable: true))
        let store = InMemoryStore()
        var clock: Int64 = 1_000
        let queue = SubmissionQueue(storage: store, client: client) { clock }

        // 25 items into a queue capped at 20.
        for i in 0..<25 {
            clock += 1_000
            queue.enqueue(id: "id-\(i)", submissionJSON: json(#"{"seq":\#(i)}"#))
        }

        XCTAssertEqual(queue.size(), 20)

        // The five oldest must be gone and the newest must remain. UUID-keyed
        // storage would have evicted an arbitrary five instead.
        let remaining = store.keys(prefix: "markerio.outbox.")
        XCTAssertFalse(remaining.contains { $0.hasSuffix(".id-0") })
        XCTAssertFalse(remaining.contains { $0.hasSuffix(".id-4") })
        XCTAssertTrue(remaining.contains { $0.hasSuffix(".id-24") })
    }
}
