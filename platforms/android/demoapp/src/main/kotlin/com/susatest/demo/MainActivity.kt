package com.susatest.demo

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import com.susatest.signals.ConsentScope
import com.susatest.signals.FeedbackConfig
import com.susatest.signals.FeedbackSdk
import com.susatest.signals.Reporter

/**
 * A real demo app that integrates the Signals SDK the way a customer would, and
 * exercises the FULL feedback flow on a real device: analytics events, a bug
 * report WITH an automatic screenshot, and a session recording.
 *
 * It renders a realistic checkout screen (so the screenshot and replay capture
 * something real), then auto-drives the SDK once the first frame is up. There
 * are also manual buttons, but the auto-run makes the on-device test
 * deterministic.
 */
class MainActivity : Activity() {

    private lateinit var sdk: FeedbackSdk
    private val main = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildCheckoutScreen())

        sdk = FeedbackSdk.init(
            this,
            FeedbackConfig(
                projectId = "proj_android_demo",
                endpoint = "http://localhost:8000/signals",
                reporter = Reporter(email = "shopper@example.com", fullName = "Real Shopper", externalId = "user-42"),
                customData = mapOf("plan" to "pro", "tenantId" to "acme"),
            ),
        )
        // A real app collects consent from the user; here we grant all four so
        // the full pipeline (screenshot + replay + analytics) runs.
        sdk.grantConsent(listOf(
            ConsentScope.SCREENSHOT, ConsentScope.DIAGNOSTICS,
            ConsentScope.SESSION_REPLAY, ConsentScope.ANALYTICS,
        ))
    }

    override fun onResume() {
        super.onResume()
        // Drive the full flow after the window has drawn its first frame, so the
        // screenshot and replay have real content to capture.
        window.decorView.post { runFullFlow() }
    }

    private fun runFullFlow() {
        status("recording…")
        // 1. analytics
        sdk.track("checkout_viewed", mapOf("cartValue" to "4250", "currency" to "INR"))
        sdk.track("payment_method_selected", mapOf("method" to "card"))

        // 2. session replay — record the screen while the "user" interacts
        val session = sdk.startRecording(this)
        status("recording session ${session?.take(8)}")

        // simulate an interaction partway through the recording
        main.postDelayed({
            (findViewById<TextView>(TITLE_ID))?.text = "Acme Checkout — Paying…"
            sdk.track("pay_tapped")
        }, 1500)

        // 3. a bug report WITH an automatic screenshot of the current screen
        main.postDelayed({
            status("filing bug report (with screenshot)…")
            sdk.report(
                activity = this,
                title = "Pay button spins forever",
                description = "Tapped Pay on the checkout screen; the spinner never resolves and no charge appears.",
                route = "/checkout",
            ) { ok -> status(if (ok) "bug report sent ✓" else "bug report skipped") }
        }, 3000)

        // 4. stop recording + flush everything to the ingest
        main.postDelayed({
            sdk.stopRecording()
            sdk.flushEvents { }
            sdk.flush { status("flushed — done") }
        }, 6500)
    }

    private fun status(text: String) {
        runOnUiThread { findViewById<TextView>(STATUS_ID)?.text = text }
    }

    // --- a realistic screen so captures have real content --------------------

    private fun buildCheckoutScreen(): LinearLayout {
        fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            setPadding(dp(24), dp(48), dp(24), dp(24))
            layoutParams = ViewGroup.LayoutParams(MATCH, MATCH)
        }
        fun label(text: String, size: Float, color: Int, bold: Boolean = false, id: Int = 0) =
            TextView(this).apply {
                this.text = text
                setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
                setTextColor(color)
                if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
                if (id != 0) this.id = id
                setPadding(0, dp(6), 0, dp(6))
            }

        root.addView(label("Acme Checkout", 26f, Color.parseColor("#111111"), bold = true, id = TITLE_ID))
        root.addView(label("Order #A-10427", 14f, Color.parseColor("#888888")))
        root.addView(label("2 × Wireless Headphones", 16f, Color.parseColor("#222222")))
        root.addView(label("1 × USB-C Cable", 16f, Color.parseColor("#222222")))
        root.addView(label("————————————————", 14f, Color.parseColor("#cccccc")))
        root.addView(label("Total: ₹4,250.00", 20f, Color.parseColor("#111111"), bold = true))
        root.addView(label("Card ending 4242", 14f, Color.parseColor("#888888")))

        root.addView(Button(this).apply {
            text = "Pay ₹4,250.00"
            setBackgroundColor(Color.parseColor("#2563EB"))
            setTextColor(Color.WHITE)
        })
        root.addView(label(" ", 8f, Color.WHITE))
        root.addView(label("status: starting…", 13f, Color.parseColor("#2563EB"), id = STATUS_ID))
        return root
    }

    companion object {
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val TITLE_ID = 1001
        private const val STATUS_ID = 1002
    }
}
