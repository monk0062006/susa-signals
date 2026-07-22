import XCTest
@testable import SusaSignals

/// SPEC-174: the iOS signer must reproduce the exact HMAC the server and the
/// web/Android signers produce for one fixed vector, so the four implementations
/// can never silently diverge. The expected hex is asserted identically in the
/// Python server test and the Android SigningTest.
final class SigningTests: XCTestCase {

    func testKnownAnswerVector() {
        let secret = Data("0123456789abcdef0123456789abcdef".utf8)
        let body = Data("{\"a\":1}".utf8)
        let canonical = Signing.canonical(ts: "1700000000", method: "POST", path: "/v1/reports", body: body)
        XCTAssertEqual(
            Signing.sign(secret: secret, canonical: canonical),
            "aeff4ef503c24cbd3d5a6f3554cf22905dea5f44b9d850e7322edd76d21c62d3"
        )
    }

    func testHeadersHaveTimestampAndVersionedSignature() {
        let secret = Data("0123456789abcdef0123456789abcdef".utf8)
        let h = Signing.headers(secret: secret, ts: "1700000000", path: "/v1/reports", body: Data("{\"a\":1}".utf8))
        XCTAssertEqual(h["x-susa-timestamp"], "1700000000")
        XCTAssertEqual(
            h["x-susa-signature"],
            "v1=aeff4ef503c24cbd3d5a6f3554cf22905dea5f44b9d850e7322edd76d21c62d3"
        )
    }
}
