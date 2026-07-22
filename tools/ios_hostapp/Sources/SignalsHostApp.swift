import SwiftUI
import SusaSignals

// Minimal host app: on appear, drive the real Signals SDK against the endpoint
// from Info.plist and post the same payloads the Android/simulator captures use.
// Exists only to produce installable device bytes for the SPEC-173 wire test.

@main
struct SignalsHostApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    @State private var status = "starting…"

    var body: some View {
        VStack(spacing: 12) {
            Text("Susa Signals host").font(.headline)
            Text(status).font(.footnote).multilineTextAlignment(.center)
        }
        .padding()
        .onAppear(perform: drive)
    }

    private func info(_ key: String, _ fallback: String) -> String {
        (Bundle.main.object(forInfoDictionaryKey: key) as? String) ?? fallback
    }

    private func drive() {
        let endpoint = info("SIGNALS_ENDPOINT", "http://127.0.0.1:8000/signals")
        let projectId = info("SIGNALS_PROJECT_ID", "proj_ios_device_cap")

        let sdk = SusaSignals.start(config: SusaSignalsConfig(
            projectId: projectId,
            endpoint: endpoint,
            reporter: Reporter(email: "iOSDevice@Example.com", fullName: "iOS Device Rig", externalId: "ext-ios-dev-1"),
            customData: ["plan": "pro", "tenantId": "acme"]
        ))
        sdk.grantConsent([.screenshot, .diagnostics, .analytics])
        sdk.identify(userId: "ext-ios-dev-1")

        sdk.track("checkout_started", properties: ["cartValue": "42.5", "currency": "INR"])
        sdk.track("page_view")
        sdk.flushEvents { _ in
            sdk.submitResearchResponse(
                studyId: "nps",
                answers: [
                    Answer(questionId: "q1", value: "9"),
                    Answer(questionId: "q2", values: ["a", "b"]),
                ],
                completed: true,
                durationMs: 4200
            )
            sdk.flush { _ in
                DispatchQueue.main.async { status = "sent to \(endpoint)" }
            }
        }
    }
}
