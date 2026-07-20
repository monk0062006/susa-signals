package io.markerusa.feedback

/**
 * Consent, mirroring `packages/core/src/consent.ts`.
 *
 * Same rule as web: capture is gated on an explicit, current grant, and every
 * uncertain path resolves to "not granted". A missed capture is a product
 * problem; an unconsented one is a legal problem.
 */

enum class ConsentScope(val wire: String) {
    SCREENSHOT("screenshot"),
    DIAGNOSTICS("diagnostics"),
    SESSION_REPLAY("session_replay")
}

data class ConsentRecord(
    val scopes: List<ConsentScope>,
    val policyVersion: String,
    val grantedAt: Long,
    val source: String
)

class ConsentManager(
    private val storage: KeyValueStore,
    private val policyVersion: String
) {
    private companion object {
        const val KEY_SCOPES = "markerio.consent.scopes"
        const val KEY_VERSION = "markerio.consent.version"
        const val KEY_GRANTED_AT = "markerio.consent.grantedAt"
        const val KEY_SOURCE = "markerio.consent.source"
    }

    /**
     * Stored as discrete keys rather than a serialized blob specifically because
     * this class has no JSON parser. Keeping consent readable without one means
     * the gate can never fail open due to a deserialization bug.
     */
    fun load(): ConsentRecord? {
        val version = storage.get(KEY_VERSION) ?: return null
        // A grant against superseded terms is not a grant against these ones.
        if (version != policyVersion) return null

        val raw = storage.get(KEY_SCOPES) ?: return null
        val scopes = raw.split(',')
            .filter { it.isNotBlank() }
            .mapNotNull { wire -> ConsentScope.entries.firstOrNull { it.wire == wire } }
        if (scopes.isEmpty()) return null

        return ConsentRecord(
            scopes = scopes,
            policyVersion = version,
            grantedAt = storage.get(KEY_GRANTED_AT)?.toLongOrNull() ?: 0L,
            source = storage.get(KEY_SOURCE) ?: "host_app"
        )
    }

    /** The gate every capture path calls. */
    fun has(scope: ConsentScope): Boolean = load()?.scopes?.contains(scope) == true

    fun grant(scopes: List<ConsentScope>, source: String): ConsentRecord {
        // Union with any prior grant, so granting replay cannot silently drop
        // screenshot/diagnostics.
        val merged = ((load()?.scopes ?: emptyList()) + scopes).distinct()
        val now = System.currentTimeMillis()

        storage.set(KEY_SCOPES, merged.joinToString(",") { it.wire })
        storage.set(KEY_VERSION, policyVersion)
        storage.set(KEY_GRANTED_AT, now.toString())
        storage.set(KEY_SOURCE, source)

        return ConsentRecord(merged, policyVersion, now, source)
    }

    /** Withdrawal must be as easy as granting, and takes effect immediately. */
    fun revoke() {
        storage.remove(KEY_SCOPES)
        storage.remove(KEY_VERSION)
        storage.remove(KEY_GRANTED_AT)
        storage.remove(KEY_SOURCE)
    }
}
