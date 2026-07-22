import Foundation
import CryptoKit

/// SPEC-174 request signing. A pure enum so the crypto is unit-testable with no
/// simulator and pinned against the same known-answer vector as the server
/// (signing.py) and the web/Android signers — see SigningTests.
///
/// Canonical string: v1\n<ts>\n<METHOD>\n<path>\n<hex sha256(body)>.
enum Signing {

    static func canonical(ts: String, method: String, path: String, body: Data) -> String {
        let hash = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        return "v1\n\(ts)\n\(method)\n\(path)\n\(hash)"
    }

    static func sign(secret: Data, canonical: String) -> String {
        HMAC<SHA256>
            .authenticationCode(for: Data(canonical.utf8), using: SymmetricKey(data: secret))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    /// The two headers to attach for a POST of `body` to `path`.
    static func headers(secret: Data, ts: String, path: String, body: Data) -> [String: String] {
        let sig = sign(secret: secret, canonical: canonical(ts: ts, method: "POST", path: path, body: body))
        return ["x-susa-timestamp": ts, "x-susa-signature": "v1=\(sig)"]
    }
}
