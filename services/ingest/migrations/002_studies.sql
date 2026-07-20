-- Study definitions: the questions a research study asks.
--
-- Stored server-side rather than hard-coded into each host app so a researcher
-- can change wording, add a question, or pause a study without shipping a
-- release of the customer's product.

CREATE TABLE feedback.studies (
    id          text NOT NULL,
    project_id  text NOT NULL REFERENCES feedback.projects (id) ON DELETE CASCADE,

    name        text NOT NULL,
    -- The question list. jsonb rather than a questions table: a study is always
    -- read and written whole, question order is part of its meaning, and a
    -- normalized layout would buy nothing but joins.
    questions   jsonb NOT NULL,
    intro       text,
    thanks      text,

    -- Paused studies stay readable so existing responses keep their context,
    -- but the SDK refuses to present them.
    active      boolean NOT NULL DEFAULT true,

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    -- Study ids are chosen by the host product ("onboarding-q3"), so they are
    -- only unique within a project.
    PRIMARY KEY (project_id, id)
);

CREATE INDEX studies_project_active_idx
    ON feedback.studies (project_id, active, created_at DESC);

-- Aggregating a study's responses is the dashboard's main research query, and
-- study_id lives inside the payload jsonb.
CREATE INDEX submissions_study_idx
    ON feedback.submissions (project_id, (payload ->> 'studyId'))
    WHERE payload_type = 'research_response';
