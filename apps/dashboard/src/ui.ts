/**
 * Small DOM builders.
 *
 * Everything goes through `text`/`textContent` and never innerHTML: report
 * titles, log messages and custom data are attacker-controlled — they arrive
 * from an SDK embedded in a page we do not run — and this dashboard renders them
 * for an operator who is by definition privileged.
 */

export type Attrs = Record<string, string | number | boolean | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (key.startsWith('data-')) el.setAttribute(key, String(value));
    else el.setAttribute(key, String(value));
  }

  for (const child of children) {
    if (child === null || child === undefined) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  return el;
}

/** Inline SVG so icons need no network request and inherit currentColor. */
export function icon(path: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  el.setAttribute('d', path);
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.7');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  svg.append(el);

  return svg;
}

export const icons = {
  inbox: 'M3 12h4l2 3h6l2-3h4M4 5h16v14H4z',
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M8 5v14M16 5v14',
  alert: 'M12 8v5M12 16.5v.5M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  image: 'M4 5h16v14H4zM8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4 16l4.5-4 4 3.5L16 12l4 4',
  film: 'M4 5h16v14H4zM4 9h16M4 15h16M9 5v14M15 5v14',
  device: 'M7 3h10v18H7zM11 18.5h2',
  shield: 'M12 3l7 3v5.5c0 4.3-2.9 8.2-7 9.5-4.1-1.3-7-5.2-7-9.5V6l7-3z',
  tag: 'M3 3h7.5L21 13.5 13.5 21 3 10.5V3zM7 7h.01',
  clipboard: 'M9 4h6v3H9zM7 5H5v15h14V5h-2',
};

export function relativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Two-letter monogram for the reporter avatar. */
export function initials(name: string | undefined, email: string | undefined): string {
  const source = (name ?? email ?? '?').trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);

  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

export function card(
  title: string,
  body: HTMLElement,
  // `| undefined` on each, so callers can pass a conditional value directly
  // instead of building the options object twice.
  options: {
    note?: string | undefined;
    iconPath?: string | undefined;
    flush?: boolean | undefined;
  } = {},
): HTMLElement {
  const head = h('div', { class: 'card__head' }, [
    options.iconPath ? icon(options.iconPath, 15) : null,
    h('h2', { class: 'card__title', text: title }),
    options.note ? h('span', { class: 'card__note', text: options.note }) : null,
  ]);

  return h('section', { class: 'card' }, [
    head,
    h('div', { class: options.flush ? 'card__body card__body--flush' : 'card__body' }, [body]),
  ]);
}

export function specGrid(rows: Array<[string, string | undefined]>, mono = false): HTMLElement {
  const grid = h('div', { class: 'spec' });

  for (const [key, value] of rows) {
    if (!value) continue;
    grid.append(
      h('div', { class: 'spec__k', text: key }),
      h('div', { class: mono ? 'spec__v spec__v--mono' : 'spec__v', text: value }),
    );
  }

  return grid;
}

export function emptyState(
  title: string,
  body: string,
  options: { iconPath?: string; variant?: 'error' } = {},
): HTMLElement {
  return h('div', { class: options.variant === 'error' ? 'state state--error' : 'state' }, [
    h('div', { class: 'state__icon' }, [icon(options.iconPath ?? icons.inbox, 20)]),
    h('div', { class: 'state__title', text: title }),
    h('div', { class: 'state__body', text: body }),
  ]);
}

/**
 * Loading placeholder shaped like the content it precedes, rather than a
 * spinner — the layout does not jump when real rows arrive.
 */
export function listSkeleton(count = 6): DocumentFragment {
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < count; i++) {
    fragment.append(
      h('div', { class: 'skeleton' }, [
        h('div', { class: 'skeleton__line', style: 'width: 62%' }),
        h('div', { class: 'skeleton__line', style: 'width: 88%' }),
        h('div', { class: 'skeleton__line', style: 'width: 34%; height: 7px' }),
      ]),
    );
  }

  return fragment;
}
