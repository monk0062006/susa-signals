import {
  countChoices,
  mean,
  npsBreakdown,
  type Question,
  type Study,
} from '@susatest/signals-core';
import { card, h, icons, specGrid } from './ui.js';

export interface StudyResults {
  studyId: string;
  responses: number;
  completed: number;
  medianDurationMs: number | null;
  answers: Record<string, unknown[]>;
}

/**
 * Renders a study's aggregated results.
 *
 * Scoring lives in `@susatest/signals-core`, not here. NPS bucketing in particular
 * has one correct definition, and re-implementing it in the dashboard would let
 * the number shown to a researcher drift from the number any other consumer
 * computes.
 */
export function renderStudyResults(study: Study, results: StudyResults): HTMLElement {
  const body: Array<HTMLElement | null> = [];

  body.push(
    h('header', { class: 'detail__header' }, [
      h('div', { class: 'detail__eyebrow' }, [
        h('span', { class: 'row__dot row__dot--research' }),
        h('span', { class: 'tag', text: 'Study' }),
        h('span', { class: 'tag', text: study.active === false ? 'paused' : 'active' }),
      ]),
      h('h1', { class: 'detail__title', text: study.name || study.id }),
      h('div', { class: 'detail__byline' }, [
        h('span', { text: `${results.responses} response${results.responses === 1 ? '' : 's'}` }),
        h('span', { class: 'byline__sep', text: '·' }),
        h('span', { text: `${results.completed} completed` }),
        results.medianDurationMs !== null
          ? h('span', { class: 'byline__sep', text: '·' })
          : null,
        results.medianDurationMs !== null
          ? h('span', { text: `${Math.round(results.medianDurationMs / 1000)}s median` })
          : null,
      ]),
    ]),
  );

  if (results.responses === 0) {
    body.push(
      card(
        'No responses yet',
        h('p', { class: 'prose', text: 'Present this study from the SDK and responses will aggregate here.' }),
        { iconPath: icons.inbox },
      ),
    );
    return h('div', { class: 'detail__inner' }, body);
  }

  // Completion rate is the first thing a researcher checks: a study nobody
  // finishes is measuring self-selection, not the thing it asked about.
  const completionRate = Math.round((results.completed / results.responses) * 100);
  body.push(
    card(
      'Overview',
      specGrid([
        ['Responses', String(results.responses)],
        ['Completed', `${results.completed} (${completionRate}%)`],
        ['Median time', results.medianDurationMs !== null ? `${Math.round(results.medianDurationMs / 1000)}s` : undefined],
      ]),
      { flush: true, iconPath: icons.clipboard },
    ),
  );

  for (const question of study.questions) {
    const values = results.answers[question.id] ?? [];
    body.push(questionCard(question, values, results.responses));
  }

  return h('div', { class: 'detail__inner' }, body);
}

function questionCard(question: Question, values: unknown[], totalResponses: number): HTMLElement {
  const answered = values.length;
  const note = `${answered} of ${totalResponses} answered`;

  switch (question.type) {
    case 'nps': {
      const numbers = values.filter((v): v is number => typeof v === 'number');
      const nps = npsBreakdown(numbers);

      return card(
        question.prompt,
        h('div', {}, [
          h('div', { class: 'score' }, [
            h('div', { class: 'score__value', text: String(nps.score) }),
            h('div', { class: 'score__label', text: 'NPS' }),
          ]),
          segmentBar([
            { label: 'Promoters', value: nps.promoters, className: 'seg--good' },
            { label: 'Passives', value: nps.passives, className: 'seg--neutral' },
            { label: 'Detractors', value: nps.detractors, className: 'seg--bad' },
          ], nps.responses),
        ]),
        { note, iconPath: icons.tag },
      );
    }

    case 'rating': {
      const numbers = values.filter((v): v is number => typeof v === 'number');
      const average = mean(numbers);

      const counts = new Map<number, number>();
      for (let i = 1; i <= question.scale; i++) counts.set(i, 0);
      for (const value of numbers) counts.set(value, (counts.get(value) ?? 0) + 1);

      return card(
        question.prompt,
        h('div', {}, [
          h('div', { class: 'score' }, [
            h('div', { class: 'score__value', text: average.toFixed(1) }),
            h('div', { class: 'score__label', text: `out of ${question.scale}` }),
          ]),
          barList([...counts.entries()].map(([value, count]) => ({
            label: String(value),
            count,
          })), numbers.length),
        ]),
        { note, iconPath: icons.tag },
      );
    }

    case 'single_choice':
    case 'multi_choice': {
      const counts = countChoices(values as never[], question.options);
      // multi_choice lets one person pick several, so percentages are of
      // respondents, not of selections — otherwise they sum past 100.
      const denominator = answered || 1;

      return card(
        question.prompt,
        barList(
          [...counts.entries()].map(([label, count]) => ({ label, count })),
          denominator,
        ),
        { note, iconPath: icons.tag },
      );
    }

    case 'text': {
      const texts = values.map(String).filter((t) => t.trim());
      if (texts.length === 0) {
        return card(question.prompt, h('p', { class: 'prose muted', text: 'No written answers.' }), {
          note,
          iconPath: icons.clipboard,
        });
      }

      return card(
        question.prompt,
        h('div', { class: 'verbatims' }, texts.map((text) =>
          h('blockquote', { class: 'verbatim', text }),
        )),
        { flush: true, note, iconPath: icons.clipboard },
      );
    }

    default: {
      // Narrowed to `never` by the switch, so reach for the prompt structurally
      // — a study authored against a newer SDK can carry a type we do not know.
      const unknown = question as { prompt?: string };
      return card(
        unknown.prompt ?? 'Unknown question',
        h('p', { class: 'prose muted', text: 'Unsupported question type.' }),
      );
    }
  }
}

function segmentBar(
  segments: Array<{ label: string; value: number; className: string }>,
  total: number,
): HTMLElement {
  const track = h('div', { class: 'segbar' });

  for (const segment of segments) {
    if (segment.value === 0) continue;
    const width = (segment.value / Math.max(total, 1)) * 100;
    const fill = h('div', { class: `segbar__seg ${segment.className}`, style: `width:${width}%` });
    fill.title = `${segment.label}: ${segment.value}`;
    track.append(fill);
  }

  const legend = h('div', { class: 'legend' }, segments.map((segment) =>
    h('div', { class: 'legend__item' }, [
      h('span', { class: `legend__dot ${segment.className}` }),
      h('span', { text: `${segment.label} · ${segment.value}` }),
    ]),
  ));

  return h('div', {}, [track, legend]);
}

function barList(rows: Array<{ label: string; count: number }>, denominator: number): HTMLElement {
  const max = Math.max(...rows.map((r) => r.count), 1);

  return h('div', { class: 'bars' }, rows.map((row) => {
    const percent = Math.round((row.count / Math.max(denominator, 1)) * 100);
    return h('div', { class: 'bar' }, [
      h('div', { class: 'bar__label', text: row.label }),
      h('div', { class: 'bar__track' }, [
        // Scaled to the largest bar so small differences stay visible, while
        // the printed percentage stays relative to respondents.
        h('div', { class: 'bar__fill', style: `width:${(row.count / max) * 100}%` }),
      ]),
      h('div', { class: 'bar__value', text: `${row.count} · ${percent}%` }),
    ]);
  }));
}
