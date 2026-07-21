-- Partition events by month.
--
-- Events are the largest table by orders of magnitude once real traffic
-- arrives, and the two operations that matter on them both get worse as one
-- flat table grows:
--
--   * Retention becomes a mass DELETE, which leaves dead tuples for VACUUM to
--     chase and holds locks against live ingest. Dropping a partition is
--     instant and reclaims the space immediately.
--   * Range queries scan indexes covering all history rather than the month
--     being asked about.
--
-- Done now, while the table is small, because converting a populated events
-- table later means a maintenance window.

-- The attachments table also gains a storage marker, so replay frames can be
-- moved to object storage without losing track of where existing bytes live.
ALTER TABLE feedback.attachments
    ADD COLUMN storage_backend text NOT NULL DEFAULT 'postgres';

-- bytes becomes nullable: rows stored externally carry metadata only.
ALTER TABLE feedback.attachments
    ALTER COLUMN bytes DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- events -> partitioned
-- ---------------------------------------------------------------------------

ALTER TABLE feedback.events RENAME TO events_unpartitioned;

-- RENAME TO moves the table but leaves its indexes under their original names,
-- so recreating them below would collide. They are dropped rather than renamed:
-- the old table is discarded at the end of this migration anyway, and the copy
-- is faster without indexes to maintain.
DROP INDEX IF EXISTS feedback.events_project_received_idx;
DROP INDEX IF EXISTS feedback.events_project_name_received_idx;
DROP INDEX IF EXISTS feedback.events_user_idx;
DROP INDEX IF EXISTS feedback.events_session_idx;

CREATE TABLE feedback.events (
    id              uuid NOT NULL,
    project_id      text NOT NULL REFERENCES feedback.projects (id) ON DELETE CASCADE,
    name            text NOT NULL,
    properties      jsonb,
    user_id         text,
    session_id      uuid NOT NULL,
    device          jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at     timestamptz NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT now(),

    -- Partitioned on occurred_at, NOT received_at.
    --
    -- The partition key must appear in every unique constraint, so the primary
    -- key is composite — and that forces the key to be stable across
    -- redelivery. received_at is now(), which differs on every retry, so a
    -- redelivered batch would land in a different partition with a different
    -- key and ON CONFLICT would stop matching. Dedupe would silently break
    -- precisely when it is needed: during retries.
    --
    -- occurred_at is client-supplied and therefore identical on redelivery.
    -- It is untrusted, so ingest clamps it to a window around now before
    -- insert; see parseEventBatch. That bounds how far a skewed clock can
    -- scatter rows.
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX events_project_received_idx
    ON feedback.events (project_id, occurred_at DESC);

CREATE INDEX events_project_name_received_idx
    ON feedback.events (project_id, name, occurred_at DESC);

CREATE INDEX events_user_idx
    ON feedback.events (project_id, user_id, occurred_at DESC)
    WHERE user_id IS NOT NULL;

CREATE INDEX events_session_idx
    ON feedback.events (session_id);

-- Catch-all so an insert can never fail for want of a partition. Rows landing
-- here are a signal that partition creation has fallen behind, not data loss.
CREATE TABLE feedback.events_default PARTITION OF feedback.events DEFAULT;

/**
 * Creates the partition covering a given month, if absent.
 *
 * Idempotent so it can run on every boot and from a scheduler without
 * coordination.
 */
CREATE OR REPLACE FUNCTION feedback.ensure_events_partition(target date)
RETURNS text AS $$
DECLARE
    start_at  date := date_trunc('month', target)::date;
    end_at    date := (date_trunc('month', target) + interval '1 month')::date;
    part_name text := 'events_' || to_char(start_at, 'YYYY_MM');
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'feedback' AND c.relname = part_name
    ) THEN
        RETURN part_name;
    END IF;

    EXECUTE format(
        'CREATE TABLE feedback.%I PARTITION OF feedback.events FOR VALUES FROM (%L) TO (%L)',
        part_name, start_at, end_at
    );

    RETURN part_name;
END;
$$ LANGUAGE plpgsql;

-- This month and the next, so an insert at 23:59 on the last of the month does
-- not fall into the default partition.
SELECT feedback.ensure_events_partition(current_date);
SELECT feedback.ensure_events_partition((current_date + interval '1 month')::date);

-- Carry over anything already collected.
INSERT INTO feedback.events
    (id, project_id, name, properties, user_id, session_id, device, occurred_at, received_at)
SELECT id, project_id, name, properties, user_id, session_id, device, occurred_at, received_at
  FROM feedback.events_unpartitioned;

DROP TABLE feedback.events_unpartitioned;
