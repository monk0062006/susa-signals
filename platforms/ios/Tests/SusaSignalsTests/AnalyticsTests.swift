import XCTest
@testable import SusaSignals

/**
 Batching behaviour, mirroring `AnalyticsTest.kt` case for case.

 Divergence between the two files is the earliest signal that the platforms have
 drifted on rules that must be identical — particularly that events are
 discarded rather than held when consent is absent.
 */
final class AnalyticsTests: XCTestCase {

    private final class FakeTransport: Analytics.EventTransport {
        var batches: [[Analytics.Event]] = []
        var failWith: Error?

        func sendEvents(_ events: [Analytics.Event], device: DeviceContext) throws {
            if let failWith { throw failWith }
            batches.append(events)
        }

        var totalSent: Int { batches.reduce(0) { $0 + $1.count } }
    }

    private struct Boom: Error {}

    private var storage: InMemoryStore!
    private var consent: ConsentManager!
    private var transport: FakeTransport!

    override func setUp() {
        super.setUp()
        storage = InMemoryStore()
        consent = ConsentManager(storage: storage, policyVersion: "1")
        transport = FakeTransport()
    }

    private func analytics(_ options: Analytics.Options = Analytics.Options()) -> Analytics {
        Analytics(
            transport: transport,
            consent: consent,
            device: { DeviceContext(sdkVersion: "0.0.0") },
            options: options
        )
    }

    func testEventsAreDiscardedWithoutConsent() {
        let a = analytics()
        a.track("viewed")
        a.track("clicked")

        XCTAssertEqual(a.flush(), 0)
        // Discarded, not held: transmitting later would rely on a consent never
        // given for the moment of capture.
        XCTAssertEqual(a.buffered(), 0)
        XCTAssertEqual(transport.totalSent, 0)
    }

    func testEventsAreSentOnceConsentExists() {
        consent.grant([.analytics], source: "explicit_prompt")

        let a = analytics()
        a.track("viewed", properties: ["path": "/billing"])

        XCTAssertEqual(a.flush(), 1)
        XCTAssertEqual(transport.batches.first?.first?.name, "viewed")
        XCTAssertEqual(transport.batches.first?.first?.properties?["path"], "/billing")
    }

    func testScreenshotConsentDoesNotEnableAnalytics() {
        consent.grant([.screenshot, .diagnostics], source: "host_app")

        let a = analytics()
        a.track("viewed")

        // Analytics is a separate legal basis; it must never ride on the
        // implicit consent that filing a report carries.
        XCTAssertEqual(a.flush(), 0)
    }

    func testFullBatchFlushesWithoutWaitingForTheTimer() {
        consent.grant([.analytics], source: "explicit_prompt")

        let a = analytics(Analytics.Options(batchSize: 3))

        // withExtendedLifetime is load-bearing, not decoration. The auto-flush
        // is dispatched with [weak self], and `a`'s last use is the final
        // track() call — so ARC may release it before the async block runs,
        // leaving self nil and no flush at all. The SDK holds Analytics as a
        // stored property for the app's lifetime, so this is a test-lifetime
        // hazard rather than a product one.
        withExtendedLifetime(a) {
            for i in 0..<3 { a.track("event-\(i)") }

            let drained = expectation(description: "batch flushed")
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { drained.fulfill() }
            wait(for: [drained], timeout: 3)

            XCTAssertEqual(transport.totalSent, 3)
            XCTAssertEqual(a.buffered(), 0)
        }
    }

    func testOverflowDropsOldestNotNewest() {
        consent.grant([.analytics], source: "explicit_prompt")

        // batchSize above maxBuffered so nothing auto-flushes mid-test.
        let a = analytics(Analytics.Options(batchSize: 1000, maxBuffered: 5))
        for i in 0..<8 { a.track("event-\(i)") }

        XCTAssertEqual(a.buffered(), 5)
        a.flush()

        let names = transport.batches.flatMap { $0 }.map(\.name)
        // During an outage the recent past explains current behaviour; the
        // distant past does not.
        XCTAssertFalse(names.contains("event-0"), "oldest should have been dropped")
        XCTAssertTrue(names.contains("event-7"), "newest should survive")
    }

    func testFailedBatchIsDroppedNotRetried() {
        consent.grant([.analytics], source: "explicit_prompt")

        let a = analytics()
        a.track("viewed")
        transport.failWith = Boom()

        XCTAssertEqual(a.flush(), 0)
        // Re-buffering would grow the buffer during exactly the outage that
        // caused the failure.
        XCTAssertEqual(a.buffered(), 0)
    }

    func testIdentifyAttachesToSubsequentEventsOnly() {
        consent.grant([.analytics], source: "explicit_prompt")

        let a = analytics()
        a.track("before")
        a.identify(Reporter(email: "dana@example.com"))
        a.track("after")
        a.flush()

        let events = transport.batches.flatMap { $0 }
        XCTAssertNil(events.first { $0.name == "before" }?.userId)
        XCTAssertEqual(events.first { $0.name == "after" }?.userId, "dana@example.com")
    }

    func testIdentifyPrefersExternalIdOverEmail() {
        consent.grant([.analytics], source: "explicit_prompt")

        let a = analytics()
        a.identify(Reporter(email: "dana@example.com", fullName: nil, externalId: "user_42"))
        a.track("viewed")
        a.flush()

        XCTAssertEqual(transport.batches.flatMap { $0 }.first?.userId, "user_42")
    }

    func testAllEventsShareOneSessionId() {
        consent.grant([.analytics], source: "explicit_prompt")

        let a = analytics()
        a.track("one")
        a.track("two")
        a.flush()

        let ids = Set(transport.batches.flatMap { $0 }.map(\.sessionId))
        XCTAssertEqual(ids.count, 1)
        XCTAssertEqual(ids.first, a.sessionId)
    }

    func testDiscardDropsBufferedEventsWithoutSending() {
        consent.grant([.analytics], source: "explicit_prompt")

        let a = analytics(Analytics.Options(batchSize: 100))
        a.track("viewed")
        a.discard()

        XCTAssertEqual(a.buffered(), 0)
        XCTAssertEqual(a.flush(), 0)
        XCTAssertEqual(transport.totalSent, 0)
    }

    func testBlankEventNamesAreIgnored() {
        consent.grant([.analytics], source: "explicit_prompt")

        let a = analytics()
        a.track("")
        a.track("   ")

        XCTAssertEqual(a.buffered(), 0)
    }

    func testAbsurdEventNamesAreTruncated() {
        consent.grant([.analytics], source: "explicit_prompt")

        let a = analytics()
        a.track(String(repeating: "x", count: 5000))
        a.flush()

        XCTAssertLessThanOrEqual(transport.batches.flatMap { $0 }.first?.name.count ?? 0, 200)
    }
}
