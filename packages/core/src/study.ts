import type { Answer, AnswerValue } from './types.js';

/**
 * Study definitions — the questions a research study asks.
 *
 * Kept in `core` rather than the web package because a study is a contract
 * between the host product (which authors it), the SDK (which renders it) and
 * the dashboard (which aggregates it). All three must agree on what a question
 * means, and the aggregation in particular depends on the type: an NPS score is
 * not computable from a scale whose bounds the dashboard has to guess.
 */

export type QuestionType = 'nps' | 'rating' | 'single_choice' | 'multi_choice' | 'text';

interface BaseQuestion {
  id: string;
  prompt: string;
  /** Shown under the prompt. For clarifying what a scale's ends mean. */
  help?: string;
  /** Unanswered required questions block advancing. Default false. */
  required?: boolean;
}

/**
 * Net Promoter Score. Fixed 0–10 by definition, so the range is not
 * configurable — a "0–7 NPS" is not an NPS, and allowing it would silently
 * produce scores that cannot be compared to anything.
 */
export interface NpsQuestion extends BaseQuestion {
  type: 'nps';
  /** Labels for the extremes, e.g. ["Not at all likely", "Extremely likely"]. */
  labels?: [string, string];
}

export interface RatingQuestion extends BaseQuestion {
  type: 'rating';
  /** Inclusive upper bound, 2–10. Lower bound is always 1. */
  scale: number;
  labels?: [string, string];
}

export interface ChoiceQuestion extends BaseQuestion {
  type: 'single_choice' | 'multi_choice';
  options: string[];
}

export interface TextQuestion extends BaseQuestion {
  type: 'text';
  placeholder?: string;
  maxLength?: number;
}

export type Question = NpsQuestion | RatingQuestion | ChoiceQuestion | TextQuestion;

export interface Study {
  id: string;
  name: string;
  questions: Question[];
  /** Shown before the first question. Optional; most microsurveys skip it. */
  intro?: string;
  /** Shown after submission. */
  thanks?: string;
  active?: boolean;
}

export const MAX_TEXT_ANSWER = 2000;

/**
 * Validates a study definition.
 *
 * Runs on the SDK side before anything renders, because a malformed study is
 * far better caught as a console error at integration time than as a survey
 * that renders a blank question to a real user.
 */
export function validateStudy(study: Study): string[] {
  const problems: string[] = [];

  if (!study.id) problems.push('study.id is required');
  if (!study.questions?.length) problems.push('study must have at least one question');

  const seen = new Set<string>();

  for (const [index, question] of (study.questions ?? []).entries()) {
    const where = `question ${index + 1}`;

    if (!question.id) problems.push(`${where}: id is required`);
    // Duplicate ids would silently overwrite each other in the answer map,
    // losing a response with no error anywhere.
    else if (seen.has(question.id)) problems.push(`${where}: duplicate id "${question.id}"`);
    else seen.add(question.id);

    if (!question.prompt) problems.push(`${where}: prompt is required`);

    switch (question.type) {
      case 'rating':
        if (!Number.isInteger(question.scale) || question.scale < 2 || question.scale > 10) {
          problems.push(`${where}: scale must be an integer between 2 and 10`);
        }
        break;

      case 'single_choice':
      case 'multi_choice':
        if (!question.options?.length) problems.push(`${where}: options are required`);
        else if (new Set(question.options).size !== question.options.length) {
          // Duplicate labels make the choice breakdown ambiguous.
          problems.push(`${where}: options must be unique`);
        }
        break;

      case 'nps':
      case 'text':
        break;

      default:
        problems.push(`${where}: unknown type`);
    }
  }

  return problems;
}

/** Whether an answer satisfies its question, used to gate "Next". */
export function isAnswered(question: Question, value: AnswerValue | undefined): boolean {
  if (value === undefined || value === null) return false;

  switch (question.type) {
    case 'multi_choice':
      return Array.isArray(value) && value.length > 0;
    case 'text':
      return typeof value === 'string' && value.trim().length > 0;
    case 'nps':
    case 'rating':
      return typeof value === 'number';
    case 'single_choice':
      return typeof value === 'string' && value.length > 0;
    default:
      return false;
  }
}

/** Serializes the in-progress answer map into wire format. */
export function toAnswers(values: Map<string, AnswerValue>): Answer[] {
  return [...values.entries()].map(([questionId, value]) => ({ questionId, value }));
}

// --- aggregation ------------------------------------------------------------

export interface NpsBreakdown {
  promoters: number;
  passives: number;
  detractors: number;
  responses: number;
  /** Standard NPS: %promoters − %detractors, rounded, −100..100. */
  score: number;
}

/**
 * Standard NPS buckets: 9–10 promoter, 7–8 passive, 0–6 detractor.
 * Hard-coded because these thresholds are the definition, not a preference.
 */
export function npsBreakdown(values: number[]): NpsBreakdown {
  let promoters = 0;
  let passives = 0;
  let detractors = 0;

  for (const value of values) {
    if (value >= 9) promoters++;
    else if (value >= 7) passives++;
    else detractors++;
  }

  const responses = values.length;
  if (responses === 0) {
    return { promoters: 0, passives: 0, detractors: 0, responses: 0, score: 0 };
  }

  const score = Math.round((promoters / responses) * 100 - (detractors / responses) * 100);
  return { promoters, passives, detractors, responses, score };
}

/** Counts per option, preserving the study's declared order. */
export function countChoices(values: AnswerValue[], options: string[]): Map<string, number> {
  const counts = new Map(options.map((option) => [option, 0]));

  for (const value of values) {
    // multi_choice answers arrive as arrays; single_choice as strings.
    const selected = Array.isArray(value) ? value : [value];
    for (const choice of selected) {
      const key = String(choice);
      // Ignore answers referencing options the study no longer declares, which
      // happens when a study is edited after responses exist.
      if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return counts;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
