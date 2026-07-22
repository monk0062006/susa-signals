# @susatest/signals

In-app **analytics, UX research & feedback** for your web app — the web SDK for
[Susa Signals](https://susatest.com/docs/signals). Your users send you three kinds
of real-world signal, and you review them in the Signals dashboard alongside your
SUSA testing:

1. **Analytics** — product events (`checkout_started`, `signup_completed`, …), with
   counts and distinct-user trends.
2. **UX research** — in-app surveys (NPS, ratings, choice, free text), aggregated.
3. **Feedback** — bug reports with an automatic screenshot, plus **session replay**
   (rrweb) so you can watch what the user did before they hit the problem.

All three share one `sessionId`, so a bug report links to the replay that produced
it and the events around it. The SDK is **~11.6 KB gzipped**; the screenshot and
replay engines load lazily, and replay only loads *after* the user grants consent.

> **Signals is a Pro / Team feature.** It runs inside SUSA (self-hosted or the
> hosted service) and is enabled per organization.

---

## 1. Create your project (in the dashboard)

A project belongs to **one app**, so create it before adding the SDK:

1. **Signals → New project** in your SUSA dashboard.
2. **Pick the app** — the picker lists the apps you run a strategist for, each
   labelled by platform (`Web — acme.com`). The label is also how the dashboard
   distinguishes a web project from an Android/iOS one for the same product.
3. **Name it** and add the **origins** your site is served from
   (`https://app.acme.com`) so the browser SDK is accepted.
4. Copy the generated **`project` id** (e.g. `proj_acme_web`) — the only credential
   the SDK needs.

## 2. Install

```bash
npm install @susatest/signals
```

## 3. Initialize

```ts
import { loadWidget } from '@susatest/signals';

const signals = await loadWidget({
  project: 'proj_acme_web',
  endpoint: 'https://your-susa-host.com/signals',   // wherever SUSA hosts Signals for you
  reporter: { email: user.email, fullName: user.name },
  customData: { plan: user.plan, tenantId: user.tenantId },
  replay: { enabled: true },                          // still needs consent
});
```

## 4. Consent (required — Signals fails closed)

Nothing is captured until the user grants consent. Four independent scopes:
`screenshot`, `diagnostics`, `session_replay`, `analytics`.

```ts
signals.grantConsent(['analytics', 'screenshot', 'diagnostics', 'session_replay']);
```

Replay **masks every input by default**; `revokeConsent()` discards buffered replay
and analytics immediately rather than flushing it.

## 5. Use it

```ts
// analytics
signals.identify({ email: user.email, externalId: user.id });
signals.track('checkout_started', { cartValue: 42.5, currency: 'INR' });

// a survey (definition lives server-side — change it without shipping a release)
await signals.showSurveyById('nps');

// a bug report with an automatic screenshot (Ctrl/Cmd+Shift+K also opens it)
signals.capture();

// session replay
const sessionId = await signals.startRecording();
// … user interacts …
await signals.stopRecording();
```

## 6. Privacy

Screenshots and replays are **encrypted at rest**, expire on per-project TTLs, and
can be **erased for one person** (GDPR Art. 17) by email or your external id. Every
time a teammate views a recording, it's logged.

---

**Full guide:** <https://susatest.com/docs/signals> · **Android:**
`com.susatest:signals` (Maven Central) · **iOS:** `SusaSignals` (Swift Package
Manager). All three platforms share one wire format and one version line.
