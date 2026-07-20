import Foundation

/// Distinguishes "retry later" from "never retry", exactly as the other platforms do.
public struct IngestError: Error {
    public let message: String
    public let status: Int?
    public let retryable: Bool
}

/// The queue's dependency on the network, narrowed to one method, so the outbox's
/// failure handling is testable with no simulator and no sockets.
public protocol SubmissionTransport: AnyObject {
    func submit(submissionJSON: Data, idempotencyKey: String) throws
}

/**
 HTTP transport built on URLSession. Blocking by design: the queue runs on its own
 serial queue, and the SDK never assumes it may use the host app's concurrency.
 */
public final class IngestClient: SubmissionTransport {
    private let endpoint: String
    private let projectId: String
    private let timeout: TimeInterval
    private let session: URLSession

    public init(endpoint: String, projectId: String, timeout: TimeInterval = 15) {
        // Trailing slashes would produce "//v1/reports", which some proxies reject.
        var trimmed = endpoint
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        self.endpoint = trimmed
        self.projectId = projectId
        self.timeout = timeout

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = timeout
        // The SDK must not consume the user's cellular data on a background flush
        // any more than necessary; leave the system's discretion in place.
        config.waitsForConnectivity = false
        self.session = URLSession(configuration: config)
    }

    public func submit(submissionJSON: Data, idempotencyKey: String) throws {
        try post(
            path: "/v1/reports",
            body: submissionJSON,
            extraHeaders: ["idempotency-key": idempotencyKey]
        )
    }

    public func sendReplayChunk(_ chunkJSON: Data) throws {
        try post(path: "/v1/replay/chunks", body: chunkJSON, extraHeaders: [:])
    }

    private func post(path: String, body: Data, extraHeaders: [String: String]) throws {
        guard let url = URL(string: endpoint + path) else {
            throw IngestError(message: "Invalid endpoint", status: nil, retryable: false)
        }

        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue(projectId, forHTTPHeaderField: "x-project-id")
        for (key, value) in extraHeaders {
            request.setValue(value, forHTTPHeaderField: key)
        }
        request.httpBody = body

        // Bridges URLSession's async API to this synchronous one. The caller is
        // always on the SDK's own serial queue, never the main thread.
        let semaphore = DispatchSemaphore(value: 0)
        var response: URLResponse?
        var transportError: Error?

        let task = session.dataTask(with: request) { _, res, err in
            response = res
            transportError = err
            semaphore.signal()
        }
        task.resume()
        semaphore.wait()

        if let transportError {
            // No response reached us, so a retry is worth it.
            throw IngestError(message: transportError.localizedDescription, status: nil, retryable: true)
        }

        guard let http = response as? HTTPURLResponse else {
            throw IngestError(message: "No HTTP response", status: nil, retryable: true)
        }

        guard (200...299).contains(http.statusCode) else {
            // 408/429 are client-status but genuinely transient.
            let retryable = http.statusCode >= 500 || http.statusCode == 408 || http.statusCode == 429
            throw IngestError(
                message: "Ingest failed with \(http.statusCode)",
                status: http.statusCode,
                retryable: retryable
            )
        }
    }
}
