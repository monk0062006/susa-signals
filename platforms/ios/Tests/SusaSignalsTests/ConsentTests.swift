import XCTest
@testable import SusaSignals

/// Mirrors `ConsentTest.kt` case for case. Divergence between these two files is
/// the earliest signal that the platforms have drifted.
final class ConsentTests: XCTestCase {

    private func manager(
        _ store: KeyValueStore = InMemoryStore(),
        version: String = "1"
    ) -> ConsentManager {
        ConsentManager(storage: store, policyVersion: version)
    }

    func testNoGrantMeansNoConsent() {
        let consent = manager()
        XCTAssertNil(consent.load())
        XCTAssertFalse(consent.has(.sessionReplay))
        XCTAssertFalse(consent.has(.screenshot))
    }

    func testGrantedScopeIsReportedAndOthersAreNot() {
        let consent = manager()
        consent.grant([.screenshot], source: "host_app")

        XCTAssertTrue(consent.has(.screenshot))
        // Granting one scope must never imply another.
        XCTAssertFalse(consent.has(.sessionReplay))
    }

    func testGrantingNewScopePreservesEarlierOnes() {
        let consent = manager()
        consent.grant([.screenshot, .diagnostics], source: "host_app")
        consent.grant([.sessionReplay], source: "explicit_prompt")

        XCTAssertTrue(consent.has(.screenshot))
        XCTAssertTrue(consent.has(.diagnostics))
        XCTAssertTrue(consent.has(.sessionReplay))
    }

    func testRevokeClearsEverything() {
        let consent = manager()
        consent.grant(ConsentScope.allCases, source: "explicit_prompt")
        consent.revoke()

        XCTAssertNil(consent.load())
        for scope in ConsentScope.allCases {
            XCTAssertFalse(consent.has(scope))
        }
    }

    func testGrantAgainstSupersededPolicyVersionDoesNotCount() {
        let store = InMemoryStore()
        manager(store, version: "1").grant([.sessionReplay], source: "explicit_prompt")

        // Consent copy changed; the old agreement was to different terms.
        let afterPolicyChange = manager(store, version: "2")
        XCTAssertNil(afterPolicyChange.load())
        XCTAssertFalse(afterPolicyChange.has(.sessionReplay))
    }

    func testCorruptStoredScopesFailClosed() {
        let store = InMemoryStore()
        store.set("susa.signals.consent.version", "1")
        store.set("susa.signals.consent.scopes", "not_a_real_scope,,,garbage")

        let consent = manager(store)
        // Unrecognized scopes must not resolve to "some consent".
        XCTAssertNil(consent.load())
        XCTAssertFalse(consent.has(.sessionReplay))
    }
}
