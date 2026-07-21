import Foundation

/**
 multipart/form-data upload.

 The ingest API takes multipart because browsers send FormData; matching it here
 keeps one endpoint rather than two.
 */
final class MultipartUploader {
    private let endpoint: String
    private let projectId: String
    private let timeout: TimeInterval

    init(endpoint: String, projectId: String, timeout: TimeInterval = 30) {
        var trimmed = endpoint
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        self.endpoint = trimmed
        self.projectId = projectId
        self.timeout = timeout
    }

    /// Returns the server-assigned attachment id.
    ///
    /// `mimeType` is explicit because replay frames are JPEG while screenshots
    /// are PNG, and the server validates the declared type against an allowlist.
    func upload(pngData: Data, filename: String, mimeType: String = "image/png") throws -> String {
        guard let url = URL(string: endpoint + "/v1/uploads") else {
            throw IngestError(message: "Invalid endpoint", status: nil, retryable: false)
        }

        let boundary = "----susa-signals\(UInt64(Date().timeIntervalSince1970 * 1_000_000))"
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "content-type")
        request.setValue(projectId, forHTTPHeaderField: "x-project-id")

        var body = Data()
        func append(_ string: String) {
            if let data = string.data(using: .utf8) { body.append(data) }
        }

        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n")
        append("Content-Type: image/png\r\n\r\n")
        body.append(pngData)
        append("\r\n--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"kind\"\r\n\r\n")
        append("screenshot\r\n")
        append("--\(boundary)--\r\n")

        request.httpBody = body

        let semaphore = DispatchSemaphore(value: 0)
        var responseData: Data?
        var response: URLResponse?
        var transportError: Error?

        URLSession.shared.dataTask(with: request) { data, res, err in
            responseData = data
            response = res
            transportError = err
            semaphore.signal()
        }.resume()
        semaphore.wait()

        if let transportError {
            throw IngestError(message: transportError.localizedDescription, status: nil, retryable: true)
        }

        guard let http = response as? HTTPURLResponse else {
            throw IngestError(message: "No HTTP response", status: nil, retryable: true)
        }

        guard (200...299).contains(http.statusCode) else {
            throw IngestError(
                message: "Upload failed with \(http.statusCode)",
                status: http.statusCode,
                retryable: http.statusCode >= 500
            )
        }

        guard
            let responseData,
            let object = try? JSONSerialization.jsonObject(with: responseData) as? [String: Any],
            let id = object["id"] as? String,
            !id.isEmpty
        else {
            throw IngestError(message: "Upload response missing id", status: http.statusCode, retryable: false)
        }

        return id
    }
}
