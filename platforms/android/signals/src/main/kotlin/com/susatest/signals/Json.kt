package com.susatest.signals

/**
 * Minimal JSON writer.
 *
 * `org.json` ships with Android but is stubbed out in JVM unit tests, which would
 * make the schema — the part that most needs testing — the part we cannot test
 * without an emulator. A few dozen lines here buys full JVM-testable serialization
 * and keeps the library dependency-free.
 *
 * Write-only on purpose: the outbox stores already-serialized submissions and
 * replays those strings verbatim, so nothing ever needs parsing back.
 */
internal class JsonWriter {
    private val sb = StringBuilder()

    fun obj(build: ObjectScope.() -> Unit): JsonWriter {
        sb.append('{')
        ObjectScope(sb).build()
        sb.append('}')
        return this
    }

    override fun toString(): String = sb.toString()

    internal class ObjectScope(private val sb: StringBuilder) {
        private var first = true

        private fun key(name: String) {
            if (!first) sb.append(',')
            first = false
            sb.append(quote(name)).append(':')
        }

        /** Omits the field entirely when null — absent and null are different on the wire. */
        fun str(name: String, value: String?) {
            if (value == null) return
            key(name)
            sb.append(quote(value))
        }

        fun num(name: String, value: Number?) {
            if (value == null) return
            key(name)
            // Non-finite doubles are not valid JSON; emit null rather than `NaN`,
            // which would make the whole payload unparseable server-side.
            val d = value.toDouble()
            if (d.isNaN() || d.isInfinite()) sb.append("null") else sb.append(value.toString())
        }

        fun bool(name: String, value: Boolean?) {
            if (value == null) return
            key(name)
            sb.append(if (value) "true" else "false")
        }

        fun obj(name: String, build: ObjectScope.() -> Unit) {
            key(name)
            sb.append('{')
            ObjectScope(sb).build()
            sb.append('}')
        }

        fun <T> array(name: String, items: List<T>, write: ObjectScope.(T) -> Unit) {
            key(name)
            sb.append('[')
            items.forEachIndexed { index, item ->
                if (index > 0) sb.append(',')
                sb.append('{')
                ObjectScope(sb).write(item)
                sb.append('}')
            }
            sb.append(']')
        }

        fun strArray(name: String, items: List<String>) {
            key(name)
            sb.append('[')
            items.forEachIndexed { index, item ->
                if (index > 0) sb.append(',')
                sb.append(quote(item))
            }
            sb.append(']')
        }

        /** Escape hatch for a value already serialized elsewhere. */
        fun raw(name: String, json: String) {
            key(name)
            sb.append(json)
        }
    }

    internal companion object {
        fun quote(value: String): String {
            val out = StringBuilder(value.length + 2)
            out.append('"')
            for (ch in value) {
                when (ch) {
                    '"' -> out.append("\\\"")
                    '\\' -> out.append("\\\\")
                    '\n' -> out.append("\\n")
                    '\r' -> out.append("\\r")
                    '\t' -> out.append("\\t")
                    '\b' -> out.append("\\b")
                    '' -> out.append("\\f")
                    else ->
                        // Control characters must be escaped; U+2028/2029 are legal
                        // JSON but break JavaScript parsers that eval the response.
                        if (ch < ' ' || ch == ' ' || ch == ' ') {
                            out.append(String.format("\\u%04x", ch.code))
                        } else {
                            out.append(ch)
                        }
                }
            }
            out.append('"')
            return out.toString()
        }
    }
}
