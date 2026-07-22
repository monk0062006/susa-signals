import XCTest
@testable import SusaSignals

/// SPEC-173 §3 #1 (iOS, simulator). Drives the REAL Swift SDK against a capture
/// server, from the iOS Simulator — the full iOS runtime (UIKit, Foundation,
/// URLSession), unlike the Windows wire test which could only exercise the
/// Foundation-only encoder.
///
/// Reachability-gated: skipped unless `SIGNALS_CAPTURE_URL` is set and answers,
/// so this is inert in the normal unit-test run and only fires in the capture
/// workflow (signals-ios-wire-capture.yml), which starts the capture server and
/// exports that env var.
final class SpecPortWireCaptureTests: XCTestCase {

    private var endpoint: String {
        ProcessInfo.processInfo.environment["SIGNALS_CAPTURE_URL"] ?? ""
    }
    private let projectId = "proj_ios_sim_cap"

    private func reachable() -> Bool {
        guard !endpoint.isEmpty, let url = URL(string: "\(endpoint)/health") else { return false }
        var ok = false
        let sem = DispatchSemaphore(value: 0)
        var req = URLRequest(url: url)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            ok = (resp as? HTTPURLResponse)?.statusCode == 200
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 5)
        return ok
    }

    func testEmitsEventsAndResearchResponseFromSimulator() throws {
        try XCTSkipUnless(reachable(),
            "capture server not reachable at \(endpoint) — set SIGNALS_CAPTURE_URL")

        let sdk = SusaSignals.start(config: SusaSignalsConfig(
            projectId: projectId,
            endpoint: endpoint,
            reporter: Reporter(email: "iOSSim@Example.com", fullName: "iOS Sim Rig", externalId: "ext-ios-sim-1"),
            customData: ["plan": "pro", "tenantId": "acme"]
        ))

        sdk.grantConsent([.screenshot, .diagnostics, .analytics])
        sdk.identify(userId: "ext-ios-sim-1")

        // --- analytics (/v1/events) ---
        sdk.track("checkout_started", properties: ["cartValue": "42.5", "currency": "INR"])
        sdk.track("page_view")
        let events = expectation(description: "events flushed")
        sdk.flushEvents { _ in events.fulfill() }
        wait(for: [events], timeout: 20)

        // --- research response (/v1/reports) with a multi-select answer ---
        sdk.submitResearchResponse(
            studyId: "nps",
            answers: [
                Answer(questionId: "q1", value: "9"),
                Answer(questionId: "q2", values: ["a", "b"]),
            ],
            completed: true,
            durationMs: 4200
        )
        let report = expectation(description: "report flushed")
        sdk.flush { _ in report.fulfill() }
        wait(for: [report], timeout: 20)

        // Let the SDK's single worker drain the final POST before teardown.
        Thread.sleep(forTimeInterval: 2)
    }
}
