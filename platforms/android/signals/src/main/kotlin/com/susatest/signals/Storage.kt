package com.susatest.signals

import android.content.Context
import android.content.SharedPreferences

/**
 * Same seam as `KeyValueStore` in core. An interface rather than a direct
 * SharedPreferences dependency so the queue and consent logic stay JVM-testable
 * without an emulator — which is what makes them testable at all on a machine
 * with no Android device attached.
 */
interface KeyValueStore {
    fun get(key: String): String?
    fun set(key: String, value: String)
    fun remove(key: String)
    /** Keys carrying the given prefix. The outbox enumerates its entries this way. */
    fun keys(prefix: String): List<String>
}

internal class SharedPrefsStore(context: Context) : KeyValueStore {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("com.susatest.signals", Context.MODE_PRIVATE)

    override fun get(key: String): String? = prefs.getString(key, null)

    override fun set(key: String, value: String) {
        // commit(), not apply(): the queue's whole purpose is surviving a process
        // death that can happen milliseconds later, and apply() is asynchronous.
        prefs.edit().putString(key, value).commit()
    }

    override fun remove(key: String) {
        prefs.edit().remove(key).commit()
    }

    override fun keys(prefix: String): List<String> =
        prefs.all.keys.filter { it.startsWith(prefix) }
}

/** In-memory store for unit tests. */
class InMemoryStore : KeyValueStore {
    private val map = LinkedHashMap<String, String>()
    override fun get(key: String): String? = map[key]
    override fun set(key: String, value: String) { map[key] = value }
    override fun remove(key: String) { map.remove(key) }
    override fun keys(prefix: String): List<String> = map.keys.filter { it.startsWith(prefix) }
}
