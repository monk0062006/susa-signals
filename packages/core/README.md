# @susatest/signals-core

Framework-agnostic core client for [Susa Signals](https://susatest.com/docs/signals)
— the transport, queue, consent gate, and wire encoder shared by the Signals web
SDK. It has no UI.

**Most apps should install [`@susatest/signals`](https://www.npmjs.com/package/@susatest/signals)
instead**, which wraps this core with the feedback composer, survey UI, screenshot
and session-replay engines. Use `@susatest/signals-core` directly only when you are
building your own UI on top of the Signals ingest API.

```bash
npm install @susatest/signals-core
```

You still need a **`project` id** created in your SUSA dashboard (Signals → New
project, bound to your app). See the full guide:
<https://susatest.com/docs/signals>.
