#if canImport(UIKit)
import UIKit
import WebKit
import XCTest
@testable import SusaSignals

/**
 Replay masking, verified by reading pixels back.

 The recorder captures frames rather than DOM mutations, so nothing about
 masking is structural — it is pixels painted over pixels. That makes this the
 only way to know it works, and it is the highest-stakes assertion in the iOS
 library: a gap here streams a password to a server continuously rather than
 once.

 Mirrors `ReplayMaskingInstrumentedTest.kt` case for case.
 */
final class ReplayMaskingTests: XCTestCase {

    private func makeWindow() -> (UIWindow, UITextField, UILabel) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 300, height: 400))
        window.backgroundColor = .white

        let label = UILabel(frame: CGRect(x: 0, y: 0, width: 300, height: 100))
        label.backgroundColor = UIColor(red: 0, green: 0.8, blue: 0, alpha: 1)
        label.text = "ordinary label"

        let password = UITextField(frame: CGRect(x: 0, y: 100, width: 300, height: 100))
        password.isSecureTextEntry = true
        password.text = "hunter2"
        password.backgroundColor = UIColor(red: 0.8, green: 0, blue: 0, alpha: 1)

        window.addSubview(label)
        window.addSubview(password)
        window.makeKeyAndVisible()
        window.layoutIfNeeded()

        return (window, password, label)
    }

    private func pixel(_ image: UIImage, x: Int, y: Int) -> (r: UInt8, g: UInt8, b: UInt8, a: UInt8) {
        guard let cg = image.cgImage else { return (0, 0, 0, 0) }

        var data = [UInt8](repeating: 0, count: 4)
        guard let ctx = CGContext(
            data: &data, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return (0, 0, 0, 0) }

        ctx.translateBy(x: CGFloat(-x), y: CGFloat(y - cg.height + 1))
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        return (data[0], data[1], data[2], data[3])
    }

    func testPasswordFieldIsDetectedAsSensitive() {
        let (window, _, _) = makeWindow()

        let regions = FrameMasker.sensitiveRegions(in: window)

        // The password field, and not the ordinary label.
        XCTAssertEqual(regions.count, 1, "expected exactly one sensitive region")
    }

    func testTaggedViewIsDetectedAsSensitive() {
        let (window, _, label) = makeWindow()
        label.accessibilityIdentifier = FrameMasker.privateIdentifier

        XCTAssertEqual(FrameMasker.sensitiveRegions(in: window).count, 2)
    }

    func testWebViewsAreTreatedAsSensitiveWholesale() {
        let (window, _, _) = makeWindow()
        let before = FrameMasker.sensitiveRegions(in: window).count

        // A web view renders remote content the SDK cannot inspect, so its
        // contents are unknowable and must be excluded entirely.
        let web = WKWebView(frame: CGRect(x: 0, y: 200, width: 300, height: 100))
        window.addSubview(web)
        window.layoutIfNeeded()

        XCTAssertEqual(FrameMasker.sensitiveRegions(in: window).count, before + 1)
    }

    func testHiddenViewsAreNotMasked() {
        let (window, password, _) = makeWindow()
        let visible = FrameMasker.sensitiveRegions(in: window).count

        password.isHidden = true

        // Nothing is drawn, so nothing needs covering.
        XCTAssertEqual(FrameMasker.sensitiveRegions(in: window).count, visible - 1)
    }

    func testMaskingPaintsOverSensitiveRegionsOnly() {
        let (window, _, _) = makeWindow()
        let regions = FrameMasker.sensitiveRegions(in: window)

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true

        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { ctx in
            window.layer.render(in: ctx.cgContext)
            FrameMasker.apply(regions, in: ctx.cgContext, scale: 1)
        }

        let labelPixel = pixel(image, x: 150, y: 50)      // ordinary label
        let passwordPixel = pixel(image, x: 150, y: 150)  // secure field

        // The password field must be painted over...
        XCTAssertTrue(
            passwordPixel.r < 60 && passwordPixel.g < 60 && passwordPixel.b < 60,
            "password field was not masked (got \(passwordPixel))"
        )
        // ...and ordinary content must survive, or masking is just a black
        // rectangle over everything and proves nothing.
        XCTAssertTrue(
            labelPixel.g > 120,
            "ordinary content was masked too (got \(labelPixel))"
        )
    }
}

/// The recorder's gating and buffering, independent of any window.
final class FrameRecorderTests: XCTestCase {

    private final class FakeUploader: FrameRecorder.FrameUploading {
        var chunks: [(seq: Int, frames: Int, final: Bool)] = []

        func upload(sessionId: String, seq: Int, frames: [FrameRecorder.Frame], final: Bool) throws {
            chunks.append((seq, frames.count, final))
        }
    }

    func testRecorderRefusesToStartWithoutConsent() {
        let consent = ConsentManager(storage: InMemoryStore(), policyVersion: "1")
        let recorder = FrameRecorder(consent: consent, uploader: FakeUploader())

        // Returns nil rather than a session id, so a caller can tell
        // "recording" from "silently not recording".
        XCTAssertNil(recorder.start())
        XCTAssertNil(recorder.currentSessionId())
    }

    func testRecorderStartsOnceConsentExists() {
        let consent = ConsentManager(storage: InMemoryStore(), policyVersion: "1")
        consent.grant([.sessionReplay], source: "explicit_prompt")

        let recorder = FrameRecorder(consent: consent, uploader: FakeUploader())
        let session = recorder.start()

        XCTAssertNotNil(session)
        XCTAssertEqual(recorder.currentSessionId(), session)
        recorder.stop()
    }

    func testScreenshotConsentDoesNotEnableReplay() {
        let consent = ConsentManager(storage: InMemoryStore(), policyVersion: "1")
        consent.grant([.screenshot, .diagnostics], source: "host_app")

        let recorder = FrameRecorder(consent: consent, uploader: FakeUploader())

        // Replay has no implicit-consent moment the way filing a report does.
        XCTAssertNil(recorder.start())
    }

    func testAbandonDiscardsWithoutUploading() {
        let consent = ConsentManager(storage: InMemoryStore(), policyVersion: "1")
        consent.grant([.sessionReplay], source: "explicit_prompt")

        let uploader = FakeUploader()
        let recorder = FrameRecorder(consent: consent, uploader: uploader)
        recorder.start()
        recorder.abandon()

        // Withdrawal must not flush a final chunk; stop() would.
        XCTAssertTrue(uploader.chunks.isEmpty)
    }
}
#endif
