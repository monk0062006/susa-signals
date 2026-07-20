-- Product analytics events.
--
-- Kept in its own table rather than reusing `submissions` because the two have
-- opposite shapes. A project produces a handful of submissions per user; it
-- produces thousands of events per user. Sharing a table would put a
-- high-churn, append-only workload behind indexes tuned for a low-volume,
-- read-often one, and would make retention for either impossible to reason
-- about separately.

CREATE TABLE feedback.events (
    -- Client-generated, so a retried batch is idempotent rather than duplicated.
    id              uuid PRIMARY KEY,
    project_id      text NOT NULL REFERENCES feedback.projects (id) ON DELETE CASCADE,

    name            text NOT NULL,
    properties      jsonb,

    -- Lifted out of properties so erasure by subject is an indexed delete
    -- rather than a scan, exactly as on submissions.
    user_id         text,
    -- Groups events from one app session. Distinct from a replay session id.
    session_id      uuid NOT NULL,

    -- Snapshot at capture time. Denormalized on purpose: a device's attributes
    -- at the moment of an event are part of the event, and joining to a
    -- mutable device row would silently rewrite history.
    device          jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- Client clock, untrusted. Kept for ordering within one device's timeline.
    occurred_at     timestamptz NOT NULL,
    -- Server clock, authoritative for retention and for range queries.
    received_at     timestamptz NOT NULL DEFAULT now()
);

-- The shape of nearly every analytics query: one project, one time window,
-- newest first.
CREATE INDEX events_project_received_idx
    ON feedback.events (project_id, received_at DESC);

-- "How many times did X happen this week."
CREATE INDEX events_project_name_received_idx
    ON feedback.events (project_id, name, received_at DESC);

-- Per-user timelines, and the erasure path.
CREATE INDEX events_user_idx
    ON feedback.events (project_id, user_id, received_at DESC)
    WHERE user_id IS NOT NULL;

CREATE INDEX events_session_idx
    ON feedback.events (session_id);

-- Analytics accumulates faster than anything else here, so it gets its own TTL
-- rather than inheriting the submission one.
ALTER TABLE feedback.retention_policies
    ADD COLUMN event_ttl_days integer CHECK (event_ttl_days > 0);
