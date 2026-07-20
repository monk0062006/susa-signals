import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { Repository } from '../src/db/repository.js';
import { Studies } from '../src/db/studies.js';
import { bugReport, setupSchema, testPool, truncateAll } from './helpers.js';

let pool: Pool;
let studies: Studies;
let repo: Repository;

before(async () => {
  pool = testPool();
  await setupSchema(pool);
  studies = new Studies(pool);
  repo = new Repository(pool);
});

beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE feedback.studies CASCADE');
});

after(async () => {
  await pool.end();
});

const QUESTIONS = [
  { id: 'nps', type: 'nps', prompt: 'How likely are you to recommend us?' },
  { id: 'why', type: 'text', prompt: 'What is the main reason for your score?' },
];

function response(studyId: string, answers: Array<{ questionId: string; value: unknown }>, completed = true, durationMs?: number) {
  return bugReport({
    payload: {
      type: 'research_response',
      studyId,
      answers,
      completed,
      ...(durationMs !== undefined ? { durationMs } : {}),
    },
  });
}

describe('study definitions', () => {
  it('creates and reads back a study', async () => {
    await studies.upsert({
      id: 'onboarding-q3',
      projectId: 'proj_test',
      name: 'Onboarding Q3',
      questions: QUESTIONS,
      thanks: 'Appreciated.',
    });

    const study = await studies.get('proj_test', 'onboarding-q3');
    assert.equal(study?.name, 'Onboarding Q3');
    assert.equal(study?.questions.length, 2);
    assert.equal(study?.active, true);
  });

  it('updates in place rather than duplicating', async () => {
    await studies.upsert({ id: 's1', projectId: 'proj_test', name: 'First', questions: QUESTIONS });
    await studies.upsert({ id: 's1', projectId: 'proj_test', name: 'Renamed', questions: QUESTIONS });

    const list = await studies.list('proj_test');
    assert.equal(list.length, 1);
    assert.equal(list[0]?.name, 'Renamed');
  });

  it('scopes study ids per project', async () => {
    // Host products choose their own ids, so "nps" will collide across tenants.
    await studies.upsert({ id: 'nps', projectId: 'project_a', name: 'A', questions: QUESTIONS });
    await studies.upsert({ id: 'nps', projectId: 'project_b', name: 'B', questions: QUESTIONS });

    assert.equal((await studies.get('project_a', 'nps'))?.name, 'A');
    assert.equal((await studies.get('project_b', 'nps'))?.name, 'B');
  });

  it('rejects a study with no questions', async () => {
    await assert.rejects(() =>
      studies.upsert({ id: 'empty', projectId: 'proj_test', name: 'Empty', questions: [] }),
    );
  });

  it('omits null optional fields rather than emitting them', async () => {
    await studies.upsert({ id: 's1', projectId: 'proj_test', name: 'S', questions: QUESTIONS });
    const study = await studies.get('proj_test', 's1');

    assert.equal('intro' in (study ?? {}), false);
    assert.equal('thanks' in (study ?? {}), false);
  });
});

describe('study results', () => {
  it('groups answers by question across responses', async () => {
    await studies.upsert({ id: 'nps-q3', projectId: 'proj_test', name: 'NPS', questions: QUESTIONS });

    await repo.saveSubmission(response('nps-q3', [
      { questionId: 'nps', value: 9 },
      { questionId: 'why', value: 'Fast support' },
    ]));
    await repo.saveSubmission(response('nps-q3', [
      { questionId: 'nps', value: 4 },
      { questionId: 'why', value: 'Too slow' },
    ]));

    const results = await studies.results('proj_test', 'nps-q3');

    assert.equal(results.responses, 2);
    assert.deepEqual(results.answers.nps, [9, 4]);
    assert.deepEqual(results.answers.why, ['Fast support', 'Too slow']);
  });

  it('counts partial responses but distinguishes them', async () => {
    await studies.upsert({ id: 's1', projectId: 'proj_test', name: 'S', questions: QUESTIONS });

    await repo.saveSubmission(response('s1', [{ questionId: 'nps', value: 8 }], true));
    // Someone who answered one question and closed the panel still told the
    // researcher something.
    await repo.saveSubmission(response('s1', [{ questionId: 'nps', value: 3 }], false));

    const results = await studies.results('proj_test', 's1');
    assert.equal(results.responses, 2);
    assert.equal(results.completed, 1);
  });

  it('reports median duration, not mean', async () => {
    await studies.upsert({ id: 's1', projectId: 'proj_test', name: 'S', questions: QUESTIONS });

    for (const duration of [10_000, 12_000, 14_000]) {
      await repo.saveSubmission(response('s1', [{ questionId: 'nps', value: 7 }], true, duration));
    }
    // One abandoned tab left open for 40 minutes.
    await repo.saveSubmission(response('s1', [{ questionId: 'nps', value: 7 }], true, 2_400_000));

    const results = await studies.results('proj_test', 's1');
    // Mean would be ~609s; median stays representative of real behaviour.
    assert.ok(results.medianDurationMs !== null && results.medianDurationMs < 20_000,
      `median was ${results.medianDurationMs}`);
  });

  it('does not mix responses from another study', async () => {
    await studies.upsert({ id: 'a', projectId: 'proj_test', name: 'A', questions: QUESTIONS });
    await studies.upsert({ id: 'b', projectId: 'proj_test', name: 'B', questions: QUESTIONS });

    await repo.saveSubmission(response('a', [{ questionId: 'nps', value: 10 }]));
    await repo.saveSubmission(response('b', [{ questionId: 'nps', value: 1 }]));

    assert.deepEqual((await studies.results('proj_test', 'a')).answers.nps, [10]);
    assert.deepEqual((await studies.results('proj_test', 'b')).answers.nps, [1]);
  });

  it('does not mix responses from another project', async () => {
    await studies.upsert({ id: 'nps', projectId: 'project_a', name: 'A', questions: QUESTIONS });

    await repo.saveSubmission({ ...response('nps', [{ questionId: 'nps', value: 10 }]), projectId: 'project_a' });
    await repo.saveSubmission({ ...response('nps', [{ questionId: 'nps', value: 0 }]), projectId: 'project_b' });

    const results = await studies.results('project_a', 'nps');
    assert.deepEqual(results.answers.nps, [10]);
  });

  it('returns an empty result for a study with no responses', async () => {
    await studies.upsert({ id: 'fresh', projectId: 'proj_test', name: 'Fresh', questions: QUESTIONS });

    const results = await studies.results('proj_test', 'fresh');
    assert.equal(results.responses, 0);
    assert.equal(results.medianDurationMs, null);
    assert.deepEqual(results.answers, {});
  });
});
