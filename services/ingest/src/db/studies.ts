import type { Pool } from 'pg';
import { ValidationError } from '../validate.js';

export interface StudyRecord {
  id: string;
  projectId: string;
  name: string;
  questions: unknown[];
  intro?: string;
  thanks?: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

/** One study's responses, reduced to what a researcher actually reads. */
export interface StudyResults {
  studyId: string;
  responses: number;
  completed: number;
  /** Median is reported instead of mean: a single 40-minute abandoned tab
   *  drags the average far past anything representative. */
  medianDurationMs: number | null;
  /** questionId → every answer given, in submission order. */
  answers: Record<string, unknown[]>;
}

export class Studies {
  constructor(private readonly pool: Pool) {}

  async upsert(study: {
    id: string;
    projectId: string;
    name: string;
    questions: unknown[];
    intro?: string | undefined;
    thanks?: string | undefined;
    active?: boolean | undefined;
  }): Promise<StudyRecord> {
    if (!study.id) throw new ValidationError('study id is required');
    if (!Array.isArray(study.questions) || study.questions.length === 0) {
      throw new ValidationError('study must have at least one question');
    }

    await this.pool.query(
      `INSERT INTO feedback.projects (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [study.projectId],
    );

    const { rows } = await this.pool.query(
      `
      INSERT INTO feedback.studies (id, project_id, name, questions, intro, thanks, active)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, COALESCE($7, true))
      ON CONFLICT (project_id, id) DO UPDATE
        SET name       = EXCLUDED.name,
            questions  = EXCLUDED.questions,
            intro      = EXCLUDED.intro,
            thanks     = EXCLUDED.thanks,
            active     = EXCLUDED.active,
            updated_at = now()
      RETURNING id, project_id, name, questions, intro, thanks, active,
                extract(epoch FROM created_at) * 1000 AS created_ms,
                extract(epoch FROM updated_at) * 1000 AS updated_ms
      `,
      [
        study.id,
        study.projectId,
        study.name || study.id,
        JSON.stringify(study.questions),
        study.intro ?? null,
        study.thanks ?? null,
        study.active ?? null,
      ],
    );

    return toStudy(rows[0]);
  }

  async get(projectId: string, id: string): Promise<StudyRecord | null> {
    const { rows } = await this.pool.query(
      `
      SELECT id, project_id, name, questions, intro, thanks, active,
             extract(epoch FROM created_at) * 1000 AS created_ms,
             extract(epoch FROM updated_at) * 1000 AS updated_ms
        FROM feedback.studies
       WHERE project_id = $1 AND id = $2
      `,
      [projectId, id],
    );

    return rows[0] ? toStudy(rows[0]) : null;
  }

  async list(projectId: string): Promise<StudyRecord[]> {
    const { rows } = await this.pool.query(
      `
      SELECT id, project_id, name, questions, intro, thanks, active,
             extract(epoch FROM created_at) * 1000 AS created_ms,
             extract(epoch FROM updated_at) * 1000 AS updated_ms
        FROM feedback.studies
       WHERE project_id = $1
       ORDER BY created_at DESC
      `,
      [projectId],
    );

    return rows.map(toStudy);
  }

  async delete(projectId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM feedback.studies WHERE project_id = $1 AND id = $2`,
      [projectId, id],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Aggregates every response to a study.
   *
   * Returns raw answers grouped by question rather than pre-computed
   * statistics. The scoring rules — NPS buckets, rating means, choice counts —
   * live in `core` so the dashboard, the SDK and any future consumer compute
   * them identically. Doing the arithmetic here would fork that logic into SQL,
   * where it would silently drift.
   */
  async results(projectId: string, studyId: string): Promise<StudyResults> {
    const { rows } = await this.pool.query<{
      payload: { answers?: Array<{ questionId: string; value: unknown }>; completed?: boolean; durationMs?: number };
    }>(
      `
      SELECT payload
        FROM feedback.submissions
       WHERE project_id = $1
         AND payload_type = 'research_response'
         AND payload ->> 'studyId' = $2
       ORDER BY received_at ASC
      `,
      [projectId, studyId],
    );

    const answers: Record<string, unknown[]> = {};
    const durations: number[] = [];
    let completed = 0;

    for (const row of rows) {
      if (row.payload.completed) completed++;
      if (typeof row.payload.durationMs === 'number') durations.push(row.payload.durationMs);

      for (const answer of row.payload.answers ?? []) {
        if (!answer?.questionId) continue;
        (answers[answer.questionId] ??= []).push(answer.value);
      }
    }

    return {
      studyId,
      responses: rows.length,
      completed,
      medianDurationMs: median(durations),
      answers,
    };
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? null);
}

function toStudy(row: Record<string, unknown>): StudyRecord {
  const study: StudyRecord = {
    id: row.id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    questions: row.questions as unknown[],
    active: row.active as boolean,
    createdAt: Number(row.created_ms),
    updatedAt: Number(row.updated_ms),
  };

  // Conditional, so NULL columns are absent rather than `"intro": null`.
  if (row.intro) study.intro = row.intro as string;
  if (row.thanks) study.thanks = row.thanks as string;

  return study;
}
