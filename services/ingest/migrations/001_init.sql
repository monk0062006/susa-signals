-- Core feedback schema.
--
-- Designed to be mounted inside an existing product, so it stays in its own
-- schema rather than scattering tables across `public` where it could collide
-- with the host application's own names.

CREATE SCHEMA IF NOT EXISTS feedback;

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
-- Kept even without auth: it is the tenancy boundary every query filters on,
-- and retrofitting a scoping column onto populated tables is far more painful
-- than carrying it from the start.

CREATE TABLE feedback.projects (
    id          text PRIMARY KEY,
    name        text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- submissions
-- ---------------------------------------------------------------------------
-- One user-initiated submission: a bug report or a research response.
--
-- Hot fields are real columns so they can be indexed and filtered; the variable
-- remainder stays in jsonb. Putting the whole payload in jsonb would make
-- "list open bugs for this project, newest first" a sequential scan.

CREATE TABLE feedback.submissions (
    id              uuid PRIMARY KEY,
    project_id      text NOT NULL REFERENCES feedback.projects (id) ON DELETE CASCADE,

    payload_type    text NOT NULL CHECK (payload_type IN ('bug_report', 'research_response')),
    kind            text CHECK (kind IN ('bug', 'feedback', 'question')),
    title           text NOT NULL DEFAULT '',
    description     text,

    -- Type-specific remainder: annotations, answers, logs.
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    device          jsonb NOT NULL DEFAULT '{}'::jsonb,
    reporter        jsonb,
    custom_data     jsonb,

    -- Retained verbatim: the audit trail for why this data was collected.
    consent         jsonb,

    -- Links to the replay this happened during. Intentionally NOT a foreign key:
    -- chunks may still be streaming in when the report is filed, and a report is
    -- worth more than referential tidiness.
    session_id      uuid,

    -- Subject identity, lifted out of `reporter` so erasure requests are a single
    -- indexed delete rather than a scan over jsonb.
    reporter_email      text,
    reporter_external_id text,

    -- Client clock. Untrusted; kept for ordering within a device's own timeline.
    created_at      timestamptz NOT NULL,
    -- Server clock. Authoritative for retention.
    received_at     timestamptz NOT NULL DEFAULT now()
);

-- The dashboard's primary query: newest submissions for one project.
CREATE INDEX submissions_project_received_idx
    ON feedback.submissions (project_id, received_at DESC);

-- "Show me the report attached to this session."
CREATE INDEX submissions_session_idx
    ON feedback.submissions (session_id)
    WHERE session_id IS NOT NULL;

-- Erasure by data subject.
CREATE INDEX submissions_reporter_email_idx
    ON feedback.submissions (project_id, lower(reporter_email))
    WHERE reporter_email IS NOT NULL;

CREATE INDEX submissions_reporter_external_idx
    ON feedback.submissions (project_id, reporter_external_id)
    WHERE reporter_external_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- attachments
-- ---------------------------------------------------------------------------
-- Screenshots are uploaded before the submission exists (the client needs an id
-- to reference), so submission_id is nullable and set on link. Orphans are
-- reclaimed by retention.

CREATE TABLE feedback.attachments (
    id              uuid PRIMARY KEY,
    project_id      text NOT NULL REFERENCES feedback.projects (id) ON DELETE CASCADE,
    submission_id   uuid REFERENCES feedback.submissions (id) ON DELETE CASCADE,

    kind            text NOT NULL CHECK (kind IN ('screenshot', 'screenrecording', 'file')),
    mime_type       text NOT NULL,
    byte_size       integer NOT NULL CHECK (byte_size >= 0),
    width           integer,
    height          integer,

    -- bytea keeps deployment to a single dependency. Screenshots run tens to a
    -- few hundred KB, which Postgres handles comfortably via TOAST. Swap for
    -- object storage by replacing BlobStore, not by changing callers.
    bytes           bytea NOT NULL,

    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attachments_submission_idx
    ON feedback.attachments (submission_id)
    WHERE submission_id IS NOT NULL;

-- Finds unlinked uploads for reclamation.
CREATE INDEX attachments_orphan_idx
    ON feedback.attachments (created_at)
    WHERE submission_id IS NULL;

-- ---------------------------------------------------------------------------
-- replay_sessions / replay_chunks
-- ---------------------------------------------------------------------------
-- A session row exists so retention and erasure have a single object to act on,
-- rather than having to reason about a bag of chunks.

CREATE TABLE feedback.replay_sessions (
    id              uuid PRIMARY KEY,
    project_id      text NOT NULL REFERENCES feedback.projects (id) ON DELETE CASCADE,

    started_at      timestamptz NOT NULL,
    last_chunk_at   timestamptz NOT NULL DEFAULT now(),
    -- True once a chunk marked final arrives. False means the tab was closed or
    -- the network dropped — useful signal for a researcher, not an error.
    complete        boolean NOT NULL DEFAULT false,

    chunk_count     integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
    event_count     integer NOT NULL DEFAULT 0 CHECK (event_count >= 0),
    byte_size       bigint NOT NULL DEFAULT 0 CHECK (byte_size >= 0),

    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX replay_sessions_project_idx
    ON feedback.replay_sessions (project_id, created_at DESC);

-- Drives age-based expiry.
CREATE INDEX replay_sessions_created_idx
    ON feedback.replay_sessions (created_at);

CREATE TABLE feedback.replay_chunks (
    session_id      uuid NOT NULL REFERENCES feedback.replay_sessions (id) ON DELETE CASCADE,
    seq             integer NOT NULL CHECK (seq >= 0),

    events          jsonb NOT NULL,
    started_at      timestamptz NOT NULL,
    ended_at        timestamptz NOT NULL,
    final           boolean NOT NULL DEFAULT false,
    received_at     timestamptz NOT NULL DEFAULT now(),

    -- Composite key makes redelivery idempotent: the SDK retries chunks, and a
    -- duplicate must not double-count or duplicate events on playback.
    PRIMARY KEY (session_id, seq)
);

-- ---------------------------------------------------------------------------
-- retention policy
-- ---------------------------------------------------------------------------
-- Per-project, because replay and reports warrant different lifetimes and a
-- single global constant would be wrong for everyone.

CREATE TABLE feedback.retention_policies (
    project_id          text PRIMARY KEY REFERENCES feedback.projects (id) ON DELETE CASCADE,
    -- NULL means "keep indefinitely", which is a deliberate choice a human must
    -- make rather than a default that silently accumulates recordings.
    replay_ttl_days     integer CHECK (replay_ttl_days > 0),
    submission_ttl_days integer CHECK (submission_ttl_days > 0),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
