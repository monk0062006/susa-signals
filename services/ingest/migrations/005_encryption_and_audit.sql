-- Encryption at rest, and an audit trail for reads.
--
-- Two controls that an enterprise security review asks about by name, and that
-- this service had neither of.

-- ---------------------------------------------------------------------------
-- encryption at rest
-- ---------------------------------------------------------------------------
-- Screenshots and replay frames are the most sensitive things stored here: a
-- screenshot is whatever was on the user's screen, and a replay is that
-- hundreds of times over. Redaction protects against what the *user* knew was
-- sensitive; it does nothing about a stolen backup or a misconfigured replica.
--
-- The key id is stored per row rather than globally so keys can be rotated
-- without rewriting existing data, and so rows written before encryption was
-- enabled ('plaintext') stay readable.

ALTER TABLE feedback.attachments
    ADD COLUMN encryption_key_id text NOT NULL DEFAULT 'plaintext';

ALTER TABLE feedback.replay_chunks
    ADD COLUMN encryption_key_id text NOT NULL DEFAULT 'plaintext';

-- Replay events move from jsonb to bytea when encrypted. The column is added
-- rather than converted so existing rows keep working: a read prefers
-- events_encrypted when present and falls back to events otherwise.
ALTER TABLE feedback.replay_chunks
    ADD COLUMN events_encrypted bytea;

ALTER TABLE feedback.replay_chunks
    ALTER COLUMN events DROP NOT NULL;

-- Finds rows still needing a backfill after encryption is switched on.
CREATE INDEX attachments_unencrypted_idx
    ON feedback.attachments (created_at)
    WHERE encryption_key_id = 'plaintext';

-- ---------------------------------------------------------------------------
-- audit log
-- ---------------------------------------------------------------------------
-- Who read what, when. Writes are already reconstructable from the submissions
-- themselves; reads are not, and reads are what matters here — session replay
-- is a recording of a person, and "which of our staff watched this" is a
-- question a customer is entitled to have answered.

CREATE TABLE feedback.audit_log (
    id              bigserial PRIMARY KEY,
    project_id      text NOT NULL,

    -- What happened: replay.read, attachment.read, submission.list, erasure...
    action          text NOT NULL,
    -- What it happened to. Nullable because list actions have no single target.
    subject_type    text,
    subject_id      text,

    -- Supplied by the host product, which owns identity. Null means the call
    -- arrived without one, which is itself worth being able to search for.
    actor           text,
    request_id      text,
    ip              inet,

    -- Free-form detail: result counts, erasure totals, query parameters.
    detail          jsonb,

    occurred_at     timestamptz NOT NULL DEFAULT now()
);

-- "Everything that touched this project last week", the shape of an audit
-- request.
CREATE INDEX audit_log_project_time_idx
    ON feedback.audit_log (project_id, occurred_at DESC);

-- "Who accessed this specific recording."
CREATE INDEX audit_log_subject_idx
    ON feedback.audit_log (subject_type, subject_id, occurred_at DESC)
    WHERE subject_id IS NOT NULL;

-- "Everything this person did."
CREATE INDEX audit_log_actor_idx
    ON feedback.audit_log (actor, occurred_at DESC)
    WHERE actor IS NOT NULL;

-- Deliberately NOT foreign-keyed to projects: an audit record must outlive the
-- thing it describes. If deleting a project erased the evidence of who read it
-- first, the log would be useless in exactly the situation it exists for.
