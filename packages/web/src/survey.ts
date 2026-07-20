import {
  MAX_TEXT_ANSWER,
  isAnswered,
  toAnswers,
  validateStudy,
  type Answer,
  type AnswerValue,
  type Question,
  type Study,
} from '@markerio-usa/core';

const Z_INDEX = 2147482500; // below the annotation overlay, above host-app chrome

export interface SurveyResult {
  answers: Answer[];
  completed: boolean;
  durationMs: number;
}

/**
 * Microsurvey runner.
 *
 * A corner panel rather than a modal: research surveys interrupt someone who
 * came to the host app to do something else, and a full-screen takeover
 * converts curiosity into dismissal. One question at a time keeps the panel
 * small enough to answer without feeling like a form.
 *
 * Partial responses are returned, not discarded. Someone who answers two of
 * four questions and closes the panel has still told the researcher something,
 * and dropping that data would bias results toward people with time to finish.
 */
export class SurveyRunner {
  private root: HTMLDivElement | undefined;
  private index = 0;
  private readonly values = new Map<string, AnswerValue>();
  private readonly startedAt = Date.now();
  private resolve: ((result: SurveyResult | null) => void) | undefined;

  constructor(private readonly study: Study) {}

  /** Resolves with the response, or null if dismissed before any answer. */
  present(): Promise<SurveyResult | null> {
    const problems = validateStudy(this.study);
    if (problems.length > 0) {
      // Loudly, at integration time — better than rendering a broken question
      // to a real user.
      console.error(`[markerio] invalid study "${this.study.id}":\n  ${problems.join('\n  ')}`);
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      this.resolve = resolve;
      this.build();
    });
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKeyDown);
    this.root?.remove();
    this.root = undefined;
  }

  // --- lifecycle ------------------------------------------------------------

  private finish(completed: boolean): void {
    const answers = toAnswers(this.values);
    const resolve = this.resolve;
    this.resolve = undefined;

    this.destroy();

    // Nothing answered and dismissed: not a response, just a decline.
    if (!completed && answers.length === 0) {
      resolve?.(null);
      return;
    }

    resolve?.({ answers, completed, durationMs: Date.now() - this.startedAt });
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.finish(false);
    }
  };

  // --- rendering ------------------------------------------------------------

  private build(): void {
    const root = document.createElement('div');
    root.className = 'mio-survey';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', this.study.name);
    root.attachShadow({ mode: 'open' });

    // Shadow DOM: this panel renders inside a customer's page, whose CSS we do
    // not control and must not be affected by. Without isolation a host
    // `button { width: 100% }` silently wrecks the layout.
    const shadow = root.shadowRoot as ShadowRoot;
    shadow.append(styleSheet(), this.panel());

    document.body.appendChild(root);
    this.root = root;

    document.addEventListener('keydown', this.onKeyDown);
    this.renderStep();
  }

  private panel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="head">
        <div class="progress"><div class="progress__bar" data-bar></div></div>
        <button class="close" data-close aria-label="Dismiss survey">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <div class="body" data-body></div>
      <div class="foot">
        <span class="count" data-count></span>
        <div class="foot__actions">
          <button class="btn btn--ghost" data-skip>Skip</button>
          <button class="btn btn--primary" data-next>Next</button>
        </div>
      </div>
    `;

    panel.querySelector('[data-close]')?.addEventListener('click', () => this.finish(false));
    panel.querySelector('[data-skip]')?.addEventListener('click', () => this.advance(true));
    panel.querySelector('[data-next]')?.addEventListener('click', () => this.advance(false));

    return panel;
  }

  private get shadow(): ShadowRoot {
    return this.root?.shadowRoot as ShadowRoot;
  }

  private renderStep(): void {
    const question = this.study.questions[this.index];
    if (!question) return;

    const body = this.shadow.querySelector('[data-body]');
    const bar = this.shadow.querySelector('[data-bar]') as HTMLElement | null;
    const count = this.shadow.querySelector('[data-count]');
    const next = this.shadow.querySelector('[data-next]') as HTMLButtonElement | null;
    const skip = this.shadow.querySelector('[data-skip]') as HTMLButtonElement | null;
    if (!body) return;

    const total = this.study.questions.length;
    if (bar) bar.style.width = `${((this.index) / total) * 100}%`;
    if (count) count.textContent = `${this.index + 1} of ${total}`;
    if (next) next.textContent = this.index === total - 1 ? 'Submit' : 'Next';
    // A required question cannot be skipped, so the affordance is removed
    // rather than left visible and inert.
    if (skip) skip.style.display = question.required ? 'none' : '';

    body.replaceChildren(this.questionView(question));
    this.syncNextState();
  }

  private questionView(question: Question): DocumentFragment {
    const fragment = document.createDocumentFragment();

    const prompt = document.createElement('div');
    prompt.className = 'prompt';
    prompt.textContent = question.prompt;
    fragment.append(prompt);

    if (question.help) {
      const help = document.createElement('div');
      help.className = 'help';
      help.textContent = question.help;
      fragment.append(help);
    }

    switch (question.type) {
      case 'nps':
        fragment.append(this.scaleView(question.id, 0, 10, question.labels));
        break;
      case 'rating':
        fragment.append(this.scaleView(question.id, 1, question.scale, question.labels));
        break;
      case 'single_choice':
        fragment.append(this.choiceView(question.id, question.options, false));
        break;
      case 'multi_choice':
        fragment.append(this.choiceView(question.id, question.options, true));
        break;
      case 'text':
        fragment.append(this.textView(question));
        break;
    }

    return fragment;
  }

  private scaleView(
    questionId: string,
    from: number,
    to: number,
    labels: [string, string] | undefined,
  ): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'scale';

    const buttons = document.createElement('div');
    buttons.className = 'scale__row';

    for (let value = from; value <= to; value++) {
      const button = document.createElement('button');
      button.className = 'scale__btn';
      button.textContent = String(value);
      button.setAttribute('aria-label', `${value}`);
      if (this.values.get(questionId) === value) button.classList.add('is-on');

      button.addEventListener('click', () => {
        this.values.set(questionId, value);
        for (const sibling of buttons.children) sibling.classList.remove('is-on');
        button.classList.add('is-on');
        this.syncNextState();
      });

      buttons.append(button);
    }

    wrapper.append(buttons);

    if (labels) {
      const ends = document.createElement('div');
      ends.className = 'scale__ends';
      ends.append(
        Object.assign(document.createElement('span'), { textContent: labels[0] }),
        Object.assign(document.createElement('span'), { textContent: labels[1] }),
      );
      wrapper.append(ends);
    }

    return wrapper;
  }

  private choiceView(questionId: string, options: string[], multi: boolean): HTMLElement {
    const list = document.createElement('div');
    list.className = 'choices';

    for (const option of options) {
      const button = document.createElement('button');
      button.className = 'choice';
      button.type = 'button';

      const box = document.createElement('span');
      box.className = multi ? 'choice__box' : 'choice__radio';
      const label = document.createElement('span');
      label.textContent = option;
      button.append(box, label);

      const current = this.values.get(questionId);
      const selected = multi
        ? Array.isArray(current) && current.includes(option)
        : current === option;
      if (selected) button.classList.add('is-on');

      button.addEventListener('click', () => {
        if (multi) {
          const existing = Array.isArray(current) ? [...(this.values.get(questionId) as string[] ?? [])] : [];
          const at = existing.indexOf(option);
          if (at >= 0) existing.splice(at, 1);
          else existing.push(option);

          if (existing.length > 0) this.values.set(questionId, existing);
          else this.values.delete(questionId);

          button.classList.toggle('is-on', existing.includes(option));
        } else {
          this.values.set(questionId, option);
          for (const sibling of list.children) sibling.classList.remove('is-on');
          button.classList.add('is-on');
        }
        this.syncNextState();
      });

      list.append(button);
    }

    return list;
  }

  private textView(question: Question & { type: 'text' }): HTMLElement {
    const textarea = document.createElement('textarea');
    textarea.className = 'text';
    textarea.rows = 3;
    textarea.placeholder = question.placeholder ?? 'Type your answer…';
    textarea.maxLength = Math.min(question.maxLength ?? MAX_TEXT_ANSWER, MAX_TEXT_ANSWER);
    textarea.value = String(this.values.get(question.id) ?? '');

    textarea.addEventListener('input', () => {
      const value = textarea.value;
      if (value.trim()) this.values.set(question.id, value);
      else this.values.delete(question.id);
      this.syncNextState();
    });

    // Deferred: the element is not in the document until the fragment is
    // appended, and focusing before that is a no-op.
    setTimeout(() => textarea.focus(), 0);

    return textarea;
  }

  private syncNextState(): void {
    const question = this.study.questions[this.index];
    const next = this.shadow.querySelector('[data-next]') as HTMLButtonElement | null;
    if (!question || !next) return;

    next.disabled = Boolean(question.required) && !isAnswered(question, this.values.get(question.id));
  }

  private advance(skipped: boolean): void {
    const question = this.study.questions[this.index];
    if (question && skipped) this.values.delete(question.id);

    if (this.index >= this.study.questions.length - 1) {
      this.showThanks();
      return;
    }

    this.index++;
    this.renderStep();
  }

  private showThanks(): void {
    const body = this.shadow.querySelector('[data-body]');
    const foot = this.shadow.querySelector('.foot') as HTMLElement | null;
    const bar = this.shadow.querySelector('[data-bar]') as HTMLElement | null;

    if (bar) bar.style.width = '100%';
    if (foot) foot.style.display = 'none';

    if (body) {
      const thanks = document.createElement('div');
      thanks.className = 'thanks';
      thanks.innerHTML = `
        <div class="thanks__tick">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.2"
                  stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
      `;
      const message = document.createElement('div');
      message.className = 'thanks__text';
      message.textContent = this.study.thanks ?? 'Thanks — that helps.';
      thanks.append(message);
      body.replaceChildren(thanks);
    }

    // Resolve immediately so the host app records the response now; the panel
    // lingers only as an acknowledgement.
    const answers = toAnswers(this.values);
    const resolve = this.resolve;
    this.resolve = undefined;
    resolve?.({ answers, completed: true, durationMs: Date.now() - this.startedAt });

    setTimeout(() => this.destroy(), 1800);
  }
}

/** All panel styling, scoped by the shadow root. */
function styleSheet(): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .panel {
      position: fixed;
      right: 20px; bottom: 20px;
      width: 348px; max-width: calc(100vw - 40px);
      z-index: ${Z_INDEX};
      background: #fff;
      border: 1px solid #e4e7ec;
      border-radius: 14px;
      box-shadow: 0 20px 32px -8px rgba(16,24,40,.18), 0 6px 12px -6px rgba(16,24,40,.1);
      font: 400 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #101828;
      overflow: hidden;
      animation: rise .22s cubic-bezier(.16,1,.3,1);
    }
    @keyframes rise { from { opacity: 0; transform: translateY(10px); } }
    @media (prefers-reduced-motion: reduce) { .panel { animation: none; } }

    .head { display: flex; align-items: center; gap: 10px; padding: 12px 12px 0; }

    .progress { flex: 1; height: 3px; background: #f2f4f7; border-radius: 99px; overflow: hidden; }
    .progress__bar {
      height: 100%; width: 0%;
      background: #4f46e5; border-radius: 99px;
      transition: width .25s cubic-bezier(.16,1,.3,1);
    }

    .close {
      display: grid; place-items: center;
      width: 22px; height: 22px; flex: none;
      border: 0; border-radius: 6px;
      background: transparent; color: #98a2b3;
      cursor: pointer;
    }
    .close:hover { background: #f2f4f7; color: #475467; }

    .body { padding: 14px 16px 4px; }

    .prompt { font-size: 15px; font-weight: 600; line-height: 1.4; letter-spacing: -.01em; }
    .help { font-size: 12.5px; color: #667085; margin-top: 4px; }

    /* --- scale --- */
    .scale { margin-top: 14px; }
    .scale__row { display: flex; gap: 4px; }
    .scale__btn {
      flex: 1; height: 34px; min-width: 0;
      font: 500 13px/1 inherit;
      color: #475467;
      background: #fff;
      border: 1px solid #e4e7ec;
      border-radius: 7px;
      cursor: pointer;
      transition: background .1s, border-color .1s, color .1s, transform .06s;
    }
    .scale__btn:hover { background: #f9fafb; border-color: #d0d5dd; }
    .scale__btn.is-on {
      background: #4f46e5; border-color: #4f46e5; color: #fff;
      transform: translateY(-1px);
    }
    .scale__ends {
      display: flex; justify-content: space-between;
      margin-top: 7px; font-size: 11.5px; color: #98a2b3;
    }

    /* --- choices --- */
    .choices { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; }
    .choice {
      display: flex; align-items: center; gap: 9px;
      width: 100%; padding: 10px 12px;
      font: 400 13.5px/1.4 inherit;
      text-align: left;
      color: #344054;
      background: #fff;
      border: 1px solid #e4e7ec;
      border-radius: 8px;
      cursor: pointer;
      transition: background .1s, border-color .1s;
    }
    .choice:hover { background: #f9fafb; border-color: #d0d5dd; }
    .choice.is-on { background: #eef2ff; border-color: #4f46e5; color: #3730a3; font-weight: 500; }

    .choice__radio, .choice__box {
      width: 15px; height: 15px; flex: none;
      border: 1.5px solid #d0d5dd; background: #fff;
      display: grid; place-items: center;
    }
    .choice__radio { border-radius: 99px; }
    .choice__box { border-radius: 4px; }
    .choice.is-on .choice__radio, .choice.is-on .choice__box { border-color: #4f46e5; background: #4f46e5; }
    .choice.is-on .choice__radio::after {
      content: ''; width: 5px; height: 5px; border-radius: 99px; background: #fff;
    }
    .choice.is-on .choice__box::after {
      content: ''; width: 8px; height: 4px;
      border-left: 2px solid #fff; border-bottom: 2px solid #fff;
      transform: rotate(-45deg) translate(1px, -1px);
    }

    /* --- text --- */
    .text {
      width: 100%; margin-top: 14px; padding: 10px 11px;
      font: inherit; font-size: 13.5px;
      color: #101828;
      border: 1px solid #d0d5dd; border-radius: 8px;
      resize: vertical; min-height: 74px;
    }
    .text:focus { outline: none; border-color: #4f46e5; box-shadow: 0 0 0 3px #eef2ff; }
    .text::placeholder { color: #98a2b3; }

    /* --- foot --- */
    .foot {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px 14px;
    }
    .count { font-size: 12px; color: #98a2b3; font-variant-numeric: tabular-nums; }
    .foot__actions { display: flex; gap: 6px; }

    .btn {
      height: 32px; padding: 0 14px;
      font: 500 13px/1 inherit;
      border-radius: 7px; border: 1px solid transparent;
      cursor: pointer;
      transition: background .1s, opacity .1s;
    }
    .btn--ghost { background: transparent; color: #667085; }
    .btn--ghost:hover { background: #f2f4f7; color: #344054; }
    .btn--primary { background: #4f46e5; color: #fff; }
    .btn--primary:hover:not(:disabled) { background: #4338ca; }
    .btn--primary:disabled { opacity: .45; cursor: not-allowed; }

    /* --- thanks --- */
    .thanks { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 18px 0 22px; }
    .thanks__tick {
      display: grid; place-items: center;
      width: 40px; height: 40px; border-radius: 99px;
      background: #ecfdf3; color: #039855;
    }
    .thanks__text { font-size: 14px; color: #475467; text-align: center; }
  `;
  return style;
}
