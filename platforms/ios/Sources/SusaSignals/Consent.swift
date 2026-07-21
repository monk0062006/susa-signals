import Foundation

/**
 Consent, mirroring `packages/core/src/consent.ts` and the Android implementation.

 Same rule on every platform: capture is gated on an explicit, current grant, and
 every uncertain path resolves to "not granted". A missed capture is a product
 problem; an unconsented one is a legal problem.
 */

public enum ConsentScope: String, Codable, CaseIterable {
    case screenshot
    case diagnostics
    case sessionReplay = "session_replay"
    /// A separate legal basis from diagnostics under GDPR and ePrivacy, so it
    /// cannot ride on the implicit consent that filing a report carries.
    case analytics
}

public struct ConsentRecord: Codable, Equatable {
    public let scopes: [ConsentScope]
    public let policyVersion: String
    public let grantedAt: Int64
    public let source: String
}

public final class ConsentManager {
    private enum Key {
        static let scopes = "susa.signals.consent.scopes"
        static let version = "susa.signals.consent.version"
        static let grantedAt = "susa.signals.consent.grantedAt"
        static let source = "susa.signals.consent.source"
    }

    private let storage: KeyValueStore
    private let policyVersion: String

    public init(storage: KeyValueStore, policyVersion: String) {
        self.storage = storage
        self.policyVersion = policyVersion
    }

    /// Stored as discrete keys rather than a serialized blob so the gate can never
    /// fail open because of a deserialization bug.
    public func load() -> ConsentRecord? {
        guard let version = storage.get(Key.version) else { return nil }
        // A grant against superseded terms is not a grant against these ones.
        guard version == policyVersion else { return nil }

        guard let raw = storage.get(Key.scopes) else { return nil }
        let scopes = raw
            .split(separator: ",")
            .map(String.init)
            .compactMap(ConsentScope.init(rawValue:))
        guard !scopes.isEmpty else { return nil }

        return ConsentRecord(
            scopes: scopes,
            policyVersion: version,
            grantedAt: Int64(storage.get(Key.grantedAt) ?? "") ?? 0,
            source: storage.get(Key.source) ?? "host_app"
        )
    }

    /// The gate every capture path calls.
    public func has(_ scope: ConsentScope) -> Bool {
        load()?.scopes.contains(scope) ?? false
    }

    @discardableResult
    public func grant(_ scopes: [ConsentScope], source: String) -> ConsentRecord {
        // Union with any prior grant, so granting replay cannot silently drop
        // screenshot/diagnostics.
        var merged = load()?.scopes ?? []
        for scope in scopes where !merged.contains(scope) {
            merged.append(scope)
        }

        let now = Int64(Date().timeIntervalSince1970 * 1000)
        storage.set(Key.scopes, merged.map(\.rawValue).joined(separator: ","))
        storage.set(Key.version, policyVersion)
        storage.set(Key.grantedAt, String(now))
        storage.set(Key.source, source)

        return ConsentRecord(scopes: merged, policyVersion: policyVersion, grantedAt: now, source: source)
    }

    /// Withdrawal must be as easy as granting, and takes effect immediately.
    public func revoke() {
        storage.remove(Key.scopes)
        storage.remove(Key.version)
        storage.remove(Key.grantedAt)
        storage.remove(Key.source)
    }
}
