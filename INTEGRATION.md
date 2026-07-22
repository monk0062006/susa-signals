# Integrating Susa Signals

How to mount this into an existing product — the ingest core, the database, the
client SDKs, and the dashboard.

The core ships as an **Express router**, not a server. It has no auth, no
identity, and no issue-tracker integrations, because the host product already
has all three. Everything below assumes it is being mounted behind something
that does.

---

## 1. Architecture

```
   web / iOS / Android SDK
              │  HTTPS, one wire format, shared sessionId
              ▼
   your app  ──►  requireAuth  ──►  createIngestApp()  ──►  Postgres
                                                            (feedback schema)
```

Four data types share one pipeline and one `sessionId`, so a bug report links
to the replay that produced it and to the events around it:

| Type | Transport | Durability |
| --- | --- | --- |
| Bug reports | Durable outbox, retries for days | Persisted before any network call |
| Survey responses | Same outbox | Same |
| Session replay | Streamed ~48KB chunks | Dropped on failure, never queued |
| Analytics events | In-memory batches | Dropped on failure |

The split is deliberate. Replay and analytics are continuous and high-volume;
letting them share the durable queue would exhaust the storage quota and evict
the hand-typed bug reports the queue exists to protect.

---

## 2. Database

Everything lives in a dedicated `feedback` schema, so it cannot collide with
existing tables. **Use your existing Postgres** — no separate instance.

```bash
psql "$DATABASE_URL" -f services/ingest/migrations/001_init.sql
psql "$DATABASE_URL" -f services/ingest/migrations/002_studies.sql
psql "$DATABASE_URL" -f services/ingest/migrations/003_events.sql
psql "$DATABASE_URL" -f services/ingest/migrations/004_partition_events.sql
psql "$DATABASE_URL" -f services/ingest/migrations/005_encryption_and_audit.sql
```

Run them in order; `npm run migrate` does the same thing.

| Table | Holds |
| --- | --- |
| `feedback.submissions` | Bug reports and survey responses |
| `feedback.attachments` | Screenshots (`bytea`, encrypted) |
| `feedback.replay_chunks` | Session replay (encrypted) |
| `feedback.events` | Analytics, partitioned monthly |
| `feedback.studies` | Survey definitions |
| `feedback.retention_policies` | Per-project TTLs |
| `feedback.audit_log` | Who read what |

Notes that matter operationally:

- **Events are partitioned by `occurred_at`**, the client timestamp clamped to
  ±30 days, not by arrival. Partitioning on arrival broke idempotency: a
  redelivered batch landed in a different partition and `ON CONFLICT` stopped
  matching, so retries duplicated.
- **Listing orders by `received_at`** (server clock), not client time. A device
  with a skewed clock would otherwise pin itself to the top of every triage
  queue.
- **Keyset pagination, not OFFSET.** Submissions arrive continuously; OFFSET
  skips and repeats rows as the list shifts under the reader.
- **Screenshots are `bytea`.** At tens-to-hundreds of KB, Postgres handles these
  through TOAST. Swap for object storage by replacing the blob accessors, not by
  changing callers.

---

## 3. Mounting the router

```ts
import { createIngestApp, createRetention } from '@susatest/signals-ingest/app';

app.use('/signals', requireAuth, createIngestApp({
  pool,                                   // your existing pg Pool
  actorFor: (req) => req.user.id,         // your session -> audit trail
  allowedOrigins: ['https://customer-app.example.com'],
  logger: yourLogger,
}));

// Expire past-TTL data from your existing scheduler.
setInterval(() => void createRetention(pool).sweep(), 60 * 60 * 1000);
```

### Options

| Option | Default | Notes |
| --- | --- | --- |
| `pool` | required | Your `pg` Pool |
| `actorFor` | `() => undefined` | Maps a request to a user id for the audit log |
| `allowedOrigins` | none | Browser origins allowed to post. `true` allows any — local development only |
| `serveDashboard` | `false` | Off because the host product owns the UI |
| `rateLimits` | see below | `false` if you already throttle upstream |
| `encryptor` | from env | Reads `SIGNALS_ENCRYPTION_KEY` |
| `logger` | console | Route into your own stack |

`allowedOrigins: true` in production means any site that can name a project id
can write into it. The SDK runs on customer pages, so this is a real exposure,
not a theoretical one.

### Rate limits

Per project, budgeted per traffic class so an analytics flood cannot starve bug
reports:

| Class | Per second | Burst |
| --- | --- | --- |
| `reports` | 5 | 50 |
| `events` | 50 | 500 |
| `replay` | 20 | 200 |
| `uploads` | 10 | 100 |

---

## 4. Encryption at rest

Screenshots and replay frames are the most sensitive data here — a screenshot is
whatever was on the user's screen, and a replay is that hundreds of times over.
Redaction covers what the *user* knew was sensitive; encryption covers the
stolen backup and the misconfigured replica.

```bash
SIGNALS_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

- AES-256-GCM. GCM rather than CBC because it authenticates: tampered ciphertext
  fails loudly instead of decrypting to garbage that downstream code parses.
- Key ids are stored **per row**, so keys rotate without rewriting existing data.
- **Off when the key is unset**, and every read path tolerates plaintext rows.
  Defaulting it on would make existing data permanently unreadable on deploy.
- `GET /health` reports `encryptionAtRest: true|false` — assert it in production
  rather than assuming it.

Losing the key makes existing screenshots and replays unrecoverable. Store it
wherever the rest of your production secrets live.

---

## 5. Client SDKs

All three are published. `endpoint` points at wherever the router is mounted.

### Create a project first (dashboard)

Every SDK needs one credential: a **`project` id**, and a project is bound to **one
app**. Create it in the SUSA dashboard before wiring any SDK:

1. **Signals → New project.**
2. **Pick the app.** The picker lists the apps the org runs a strategist for, each
   labelled by platform — `Android — com.acme.app`, `iOS — com.acme.app`,
   `Web — acme.com`. An Android package id and an iOS bundle id can be the *same*
   string, so the platform label is what keeps them distinct; the same label shows
   next to the project throughout the dashboard. If the app isn't listed, create a
   strategist for it first.
3. **Name it** (web projects add their allowed origins here).
4. Copy the `project` id (e.g. `proj_acme_web`).

The binding means real-user reports route to exactly the right strategist — App B's
reports never reach App A's brain — and one app+platform = one project. Signals is a
**Pro / Team** feature; a free-plan org sees an upgrade prompt on New project.

### Web

```bash
npm install @susatest/signals
```

```ts
import { loadWidget } from '@susatest/signals';

const widget = await loadWidget({
  project: 'proj_acme',
  endpoint: 'https://yourapp.com/signals',
  reporter: { email: user.email, fullName: user.name },
  customData: { plan: user.plan, tenantId: user.tenantId },
  replay: { enabled: true },
});

widget.grantConsent(['screenshot', 'diagnostics', 'session_replay']);
widget.track('checkout_started', { cartValue: 42.5 });
```

Initial bundle is ~11.6KB gzipped; html2canvas and rrweb load lazily, and rrweb
only *after* the consent gate.

### Android

```kotlin
implementation("com.susatest:signals:0.1.0")
```

```kotlin
val sdk = FeedbackSdk.init(context, FeedbackConfig(
    projectId = "proj_acme",
    endpoint = "https://yourapp.com/signals",
))
sdk.grantConsent(setOf(ConsentScope.SCREENSHOT, ConsentScope.SESSION_REPLAY))
```

Zero third-party dependencies — deliberate. This library is embedded in other
companies' apps, and a version conflict caused by an SDK is debugged by the
customer, not by us.

### iOS

```swift
.package(url: "https://github.com/monk0062006/susa-signals", from: "0.1.0")
```

```swift
// Argument order matters in Swift: projectId is declared first.
SusaSignals.start(config: SusaSignalsConfig(
    projectId: "proj_acme",
    endpoint: "https://yourapp.com/signals"
))
```

Also zero dependencies.

---

## 6. Consent

Four scopes, each a separate legal basis. Consent **fails closed** — no grant
means no capture, and passing replay options is a capability, not a grant.

| Scope | Covers |
| --- | --- |
| `screenshot` | Screenshot when a report is filed |
| `diagnostics` | Console and network buffers |
| `session_replay` | Continuous recording — the consequential one |
| `analytics` | Product analytics; separate basis under GDPR/ePrivacy |

- Bug reports carry **implicit** consent: the user opened the widget, sees what
  will be sent, and can redact before sending. Replay has no such moment, so it
  needs an explicit grant.
- **Masking defaults to on.** Every input is masked unless explicitly unmasked.
  The failure mode becomes "we recorded less than we could have", which is
  recoverable — the inverse ships a password to your servers silently.
- **Revocation is immediate**: buffered events are discarded, not flushed.
- **Consent is versioned.** Bump `CONSENT_POLICY_VERSION` when the copy changes
  materially; grants against superseded terms stop counting.

Analytics consent is checked at **flush**, not at `track()`, so revoking discards
everything still buffered.

---

## 7. Retention and erasure

Session recordings are personal data. Storing them with no defined lifetime and
no way to delete one person's data is not a missing feature — it is a state you
cannot lawfully operate in.

```http
PUT  /v1/retention        { "replayTtlDays": 30, "submissionTtlDays": 365 }
GET  /v1/retention
POST /v1/erasure          { "email": "user@example.com" }
```

- No policy means keep indefinitely — a decision someone makes, never a silent
  default.
- `sweep()` expires data in bounded batches so it can run on a schedule without
  taking long locks against live ingest.
- Erasure deletes submissions, screenshots **and replay sessions**, matched by
  email (case-insensitive) or your external id. Deleting the report while
  keeping the recording would defeat the request.
- Abandoned uploads are reclaimed after 24h.

---

## 8. Dashboard

Deliberately plain: **5 TypeScript files, no framework**, bundled with esbuild.
Only dependencies are `rrweb` and the core package.

| Approach | Effort | When |
| --- | --- | --- |
| Rebuild views in your UI | 1–2 weeks | Best long-term fit; the API is complete |
| Port `apps/dashboard/src` | Days | No framework to fight — it is DOM manipulation |
| `serveDashboard: true` + iframe | Hours | Fastest; looks bolted on |

Worth lifting rather than rewriting: `replay.ts`. rrweb playback has real
subtleties — `getCurrentTime()` returns a large negative number before playback
starts, which is already handled there.

**Known gap:** the dashboard cannot currently display analytics events or play
native (frame-based) replay. Both are captured and stored; neither has a reader
yet.

---

## 9. API reference

All routes take a project via `x-project-id` header, except attachments which
are path-scoped (an `<img src>` cannot send headers).

### Ingest

| Method | Path |
| --- | --- |
| `POST` | `/v1/reports` |
| `POST` | `/v1/uploads` |
| `POST` | `/v1/replay/chunks` |

### Read

| Method | Path |
| --- | --- |
| `GET` | `/v1/reports` |
| `GET` | `/v1/reports/:id` |
| `GET` | `/v1/projects/:projectId/attachments/:id` |
| `GET` | `/v1/replay/:sessionId` |
| `GET` | `/v1/events`, `/v1/events/counts`, `/v1/events/timeseries` |
| `GET` | `/v1/studies`, `/v1/studies/:id`, `/v1/studies/:id/results` |
| `GET` | `/v1/audit` |

### Manage

| Method | Path |
| --- | --- |
| `PUT` / `GET` | `/v1/retention` |
| `PUT` / `DELETE` | `/v1/studies/:id` |
| `DELETE` | `/v1/replay/:sessionId` |
| `POST` | `/v1/erasure` |
| `GET` | `/health`, `/metrics` |

Limits: uploads 10MB, replay 25MB per session.

---

## 10. Audit trail

Reads are logged, not writes. Writes are reconstructable from the data itself;
reads leave no trace, and reads are what matters — a replay is a recording of a
person, and "which of your staff watched this" is a question customers are
entitled to have answered.

```http
GET /v1/audit?subjectId=<sessionId>
GET /v1/audit?actor=<userId>
```

Writes are fire-and-forget and never block the request that triggered them: an
audit system that can take down the service it observes gets switched off, and
then there is no audit system. Failures are logged so the gap is visible.

The table is deliberately **not** foreign-keyed to projects, so deleting a
project cannot erase the evidence of who read it first.

---

## 11. Deployment checklist

- [ ] Migrations run against the target database
- [ ] `SIGNALS_ENCRYPTION_KEY` set — verify with `GET /health`
- [ ] `allowedOrigins` set to real customer origins, not `true`
- [ ] `actorFor` wired to your session
- [ ] Retention sweep scheduled
- [ ] Rate limits reviewed, or `false` if throttled upstream
- [ ] Project ids provisioned and mapped to your tenants
- [ ] Backups cover the `feedback` schema
- [ ] `/metrics` scraped

---

## 12. Known gaps

1. **Dashboard cannot render analytics or native replay.** Two producers with no
   consumer.
2. **Three hand-maintained schema copies** (TS/Kotlin/Swift). `core` is
   TypeScript, so Swift and Kotlin cannot reuse it — a field renamed in one place
   fails as a malformed payload in production rather than as a compile error.
   Mitigated by mirrored test suites and shared-constant comments; the real fix
   is generating all three from one schema definition.
3. **No hosted deployment yet.** The ingest service has only run locally.

---

## Measured capacity

Single instance, local Postgres, concurrency 50:

| | Throughput | p95 |
| --- | --- | --- |
| Event batches | 278/s (13.9k events/s) | 236ms |
| Reports | 296/s | 49ms |

Re-measure against your own infrastructure before relying on these — they are a
floor from a laptop, not a capacity plan.
