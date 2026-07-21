package com.susatest.signals.replay

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.TextView

/**
 * Finds regions of the screen that must never appear in a recording, and paints
 * over them.
 *
 * The web recorder masks by CSS selector; there is no DOM here, so masking works
 * on the view hierarchy instead. The principle is identical and non-negotiable:
 * **default to hiding**. A recorder that captures everything until someone
 * remembers to exclude the password field will eventually ship a password to a
 * server — silently, permanently, and discovered by a customer.
 *
 * The inverted default means the failure mode is "we recorded less than we
 * could have", which is recoverable.
 */
internal object FrameMasker {

    /**
     * Tag a view with this as its `tag` (or via `setTag(R.id...)` in the host
     * app) to exclude it. Mirrors `data-private` on web.
     */
    const val PRIVATE_TAG = "susa-private"

    /** Solid fill, never a blur: blur is reversible enough to be unsafe. */
    private val paint = Paint().apply {
        color = Color.parseColor("#11141A")
        style = Paint.Style.FILL
        isAntiAlias = false
    }

    /**
     * Collects rectangles to obscure, in window coordinates.
     *
     * Walks the whole hierarchy rather than sampling: a missed subtree is a
     * leaked field, and hierarchies are shallow enough that the traversal cost
     * is irrelevant next to the frame encode.
     */
    fun sensitiveRegions(root: View): List<Rect> {
        val regions = mutableListOf<Rect>()
        collect(root, regions)
        return regions
    }

    private fun collect(view: View, into: MutableList<Rect>) {
        // Invisible views cannot leak what is not drawn, and skipping them
        // avoids masking regions the user cannot see anyway.
        if (view.visibility != View.VISIBLE) return

        if (isSensitive(view)) {
            val location = IntArray(2)
            view.getLocationInWindow(location)
            into.add(
                Rect(
                    location[0],
                    location[1],
                    location[0] + view.width,
                    location[1] + view.height,
                ),
            )
            // No need to descend: the whole subtree is already covered.
            return
        }

        if (view is ViewGroup) {
            for (i in 0 until view.childCount) {
                collect(view.getChildAt(i), into)
            }
        }
    }

    private fun isSensitive(view: View): Boolean {
        if (view.tag == PRIVATE_TAG) return true

        // WebViews render arbitrary remote content this SDK cannot inspect, so
        // their contents are unknowable and treated as sensitive wholesale.
        if (view is WebView) return true

        if (view is TextView) {
            val type = view.inputType
            val cls = type and InputType.TYPE_MASK_CLASS
            val variation = type and InputType.TYPE_MASK_VARIATION

            // Every password variation across text, number and web input classes.
            val isPassword =
                (cls == InputType.TYPE_CLASS_TEXT && (
                    variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                        variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
                        variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
                    )) ||
                    (cls == InputType.TYPE_CLASS_NUMBER &&
                        variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD)

            if (isPassword) return true

            // Payment and personal fields, matched the way autofill hints
            // declare them. The host app already labels these for the keyboard;
            // reusing that costs the integrator nothing.
            val hints = view.autofillHints
            if (hints != null && hints.any { hint -> SENSITIVE_AUTOFILL.contains(hint) }) {
                return true
            }
        }

        return false
    }

    private val SENSITIVE_AUTOFILL = setOf(
        View.AUTOFILL_HINT_CREDIT_CARD_NUMBER,
        View.AUTOFILL_HINT_CREDIT_CARD_SECURITY_CODE,
        View.AUTOFILL_HINT_CREDIT_CARD_EXPIRATION_DATE,
        View.AUTOFILL_HINT_PASSWORD,
        View.AUTOFILL_HINT_USERNAME,
    )

    /** Paints over every sensitive region. Must run before the frame is encoded. */
    fun apply(canvas: Canvas, regions: List<Rect>, scale: Float) {
        for (region in regions) {
            canvas.drawRect(
                region.left * scale,
                region.top * scale,
                region.right * scale,
                region.bottom * scale,
                paint,
            )
        }
    }
}
