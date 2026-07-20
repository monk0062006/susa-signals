import Foundation

/**
 Same seam as `KeyValueStore` in core and Android. A protocol rather than a direct
 UserDefaults dependency so the queue and consent logic stay testable with no
 simulator and no UIKit.
 */
public protocol KeyValueStore: AnyObject {
    func get(_ key: String) -> String?
    func set(_ key: String, _ value: String)
    func remove(_ key: String)
    /// Keys carrying the given prefix. The outbox enumerates its entries this way.
    func keys(prefix: String) -> [String]
}

public final class UserDefaultsStore: KeyValueStore {
    private let defaults: UserDefaults

    public init(suiteName: String = "io.markerusa.feedback") {
        // Falls back to .standard when the suite cannot be created (which happens
        // if the name collides with the bundle id) rather than dropping writes.
        self.defaults = UserDefaults(suiteName: suiteName) ?? .standard
    }

    public func get(_ key: String) -> String? {
        defaults.string(forKey: key)
    }

    public func set(_ key: String, _ value: String) {
        defaults.set(value, forKey: key)
    }

    public func remove(_ key: String) {
        defaults.removeObject(forKey: key)
    }

    public func keys(prefix: String) -> [String] {
        defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix(prefix) }
    }
}

/// In-memory store for unit tests.
public final class InMemoryStore: KeyValueStore {
    private var map: [String: String] = [:]

    public init() {}

    public func get(_ key: String) -> String? { map[key] }
    public func set(_ key: String, _ value: String) { map[key] = value }
    public func remove(_ key: String) { map.removeValue(forKey: key) }
    public func keys(prefix: String) -> [String] { map.keys.filter { $0.hasPrefix(prefix) } }
}
