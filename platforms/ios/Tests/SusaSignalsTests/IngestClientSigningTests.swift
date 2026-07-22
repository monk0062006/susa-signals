import XCTest
@testable import SusaSignals

/// SPEC-174 integration: proves the iOS `IngestClient` actually attaches a correct
/// signature to a real request (not just that the `Signing` helper is right).
///
/// A stub URLProtocol captures the request the client sends. Posting `{"a":1}` to
/// /v1/reports at ts 1700000000 is exactly the cross-language known-answer vector,
/// so the intercepted `x-susa-signature` must equal the value the server + web +
/// Android tests also assert.
final class IngestClientSigningTests: XCTestCase {

    func testClientAttachesCorrectSignatureToRealRequest() throws {
        StubURLProtocol.lastRequest = nil
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: config)

        let secret = Data("0123456789abcdef0123456789abcdef".utf8)
        let client = IngestClient(
            endpoint: "http://signals.test/signals",
            projectId: "proj-x",
            signingSecret: secret,
            now: { 1700000000 },
            session: session
        )

        try client.submit(submissionJSON: Data("{\"a\":1}".utf8), idempotencyKey: "idem-1")

        let req = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(req.value(forHTTPHeaderField: "x-project-id"), "proj-x")
        XCTAssertEqual(req.value(forHTTPHeaderField: "x-susa-timestamp"), "1700000000")
        XCTAssertEqual(
            req.value(forHTTPHeaderField: "x-susa-signature"),
            "v1=aeff4ef503c24cbd3d5a6f3554cf22905dea5f44b9d850e7322edd76d21c62d3"
        )
    }

    func testNoSecretMeansNoSignature() throws {
        StubURLProtocol.lastRequest = nil
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: config)

        let client = IngestClient(
            endpoint: "http://signals.test/signals", projectId: "proj-x", session: session)
        try client.submit(submissionJSON: Data("{}".utf8), idempotencyKey: "k")

        let req = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertNil(req.value(forHTTPHeaderField: "x-susa-signature"))
    }
}

/// Captures the request and returns 201 so the blocking client call completes.
final class StubURLProtocol: URLProtocol {
    static var lastRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool {
        lastRequest = request
        return true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 201, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{\"id\":\"att\"}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
