import { Api, type LogEntry, type NetworkEntry, type Submission } from './api.js';
import { ReplayPlayer, formatDuration } from './replay.js';
import {
  card,
  emptyState,
  formatBytes,
  h,
  icon,
  icons,
  initials,
  listSkeleton,
  relativeTime,
  specGrid,
} from './ui.js';

const DEFAULT_PROJECT = 'proj_demo';
const PROJECT_KEY = 'markerio.dashboard.project';

// Same origin: the dashboard is served by the ingest service itself.
const api = new Api('', localStorage.getItem(PROJECT_KEY) ?? DEFAULT_PROJECT);

const dom = {
  project: byId<HTMLInputElement>('project'),
  refresh: byId<HTMLButtonElement>('refresh'),
  search: byId<HTMLInputElement>('search'),
  filters: byId<HTMLElement>('filters'),
  list: byId<HTMLElement>('list'),
  detail: byId<HTMLElement>('detail'),
};

type Filter = 'all' | 'bug' | 'feedback' | 'research';

let all: Submission[] = [];
let visible: Submission[] = [];
let selectedId: string | undefined;
let filter: Filter = 'all';
let query = '';
let player: ReplayPlayer | undefined;

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

// --- data -------------------------------------------------------------------

async function load(): Promise<void> {
  dom.list.replaceChildren(listSkeleton());

  try {
    all = await api.listSubmissions();
    applyFilters();

    // Preserve selection across a refresh when the row still exists.
    if (!selectedId || !visible.some((s) => s.id === selectedId)) {
      selectedId = visible[0]?.id;
    }
    if (selectedId) select(selectedId);
    else renderDetailPlaceholder();
  } catch (err) {
    dom.list.replaceChildren(
      emptyState(
        'Could not load',
        err instanceof Error ? err.message : 'The ingest service did not respond.',
        { iconPath: icons.alert, variant: 'error' },
      ),
    );
    renderDetailPlaceholder();
  }
}

function matchesFilter(submission: Submission): boolean {
  if (filter === 'all') return true;
  if (filter === 'research') return submission.payload.type === 'research_response';
  if (submission.payload.type !== 'bug_report') return false;
  return (submission.payload.kind ?? 'bug') === filter;
}

function matchesQuery(submission: Submission): boolean {
  if (!query) return true;
  const haystack = [
    submission.payload.title,
    submission.payload.description,
    submission.payload.studyId,
    submission.reporter?.fullName,
    submission.reporter?.email,
    submission.device.platform,
    submission.device.deviceModel,
    submission.device.browserName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return haystack.includes(query);
}

function applyFilters(): void {
  visible = all.filter((s) => matchesFilter(s) && matchesQuery(s));
  renderCounts();
  renderList();
}

function renderCounts(): void {
  const counts: Record<Filter, number> = { all: 0, bug: 0, feedback: 0, research: 0 };

  for (const submission of all) {
    if (!matchesQuery(submission)) continue;
    counts.all++;
    if (submission.payload.type === 'research_response') counts.research++;
    else if ((submission.payload.kind ?? 'bug') === 'feedback') counts.feedback++;
    else counts.bug++;
  }

  for (const [key, value] of Object.entries(counts)) {
    const node = dom.filters.querySelector(`[data-count="${key}"]`);
    if (node) node.textContent = String(value);
  }
}

// --- list -------------------------------------------------------------------

function renderList(): void {
  if (visible.length === 0) {
    dom.list.replaceChildren(
      all.length === 0
        ? emptyState('No submissions yet', 'File one from the demo app and it will appear here.')
        : emptyState('Nothing matches', 'Try a different search or filter.'),
    );
    return;
  }

  dom.list.replaceChildren(...visible.map(listRow));
}

function listRow(submission: Submission): HTMLElement {
  const isResearch = submission.payload.type === 'research_response';
  const kind = isResearch ? 'research' : (submission.payload.kind ?? 'bug');

  const title = isResearch
    ? `Study response · ${submission.payload.studyId ?? 'unknown'}`
    : (submission.payload.title || 'Untitled report');

  const snippet = isResearch
    ? (submission.payload.answers?.[0]?.value ?? '')
    : (submission.payload.description ?? '');

  const row = h(
    'button',
    {
      class: submission.id === selectedId ? 'row is-selected' : 'row',
      'data-id': submission.id,
      role: 'listitem',
      type: 'button',
    },
    [
      h('div', { class: 'row__head' }, [
        h('span', { class: `row__dot row__dot--${kind}` }),
        h('span', { class: 'row__title', text: title }),
        h('span', { class: 'row__time', text: relativeTime(submission.createdAt) }),
      ]),
      snippet ? h('div', { class: 'row__snippet', text: String(snippet) }) : null,
      h('div', { class: 'row__meta' }, [
        h('span', { class: 'tag', text: submission.device.platform ?? 'unknown' }),
        submission.reporter?.fullName || submission.reporter?.email
          ? h('span', {
              class: 'tag',
              text: submission.reporter.fullName ?? submission.reporter.email ?? '',
            })
          : null,
        submission.sessionId ? h('span', { class: 'tag tag--replay', text: 'Replay' }) : null,
      ]),
    ],
  );

  row.addEventListener('click', () => select(submission.id));
  return row;
}

function select(id: string): void {
  selectedId = id;

  for (const row of dom.list.querySelectorAll<HTMLElement>('.row')) {
    row.classList.toggle('is-selected', row.dataset.id === id);
  }

  const submission = all.find((s) => s.id === id);
  if (!submission) return;

  renderDetail(submission);
  dom.detail.scrollTop = 0;

  if (submission.sessionId) void mountReplay(submission.sessionId);
}

// --- detail -----------------------------------------------------------------

function renderDetailPlaceholder(): void {
  player?.destroy();
  player = undefined;
  dom.detail.replaceChildren(
    emptyState('Nothing selected', 'Choose a submission from the list to see the full report.'),
  );
}

function renderDetail(submission: Submission): void {
  player?.destroy();
  player = undefined;

  const payload = submission.payload;
  const isResearch = payload.type === 'research_response';
  const kind = isResearch ? 'research' : (payload.kind ?? 'bug');

  const body: Array<HTMLElement | null> = [];

  // --- header
  const reporterName = submission.reporter?.fullName ?? submission.reporter?.email;

  body.push(
    h('header', { class: 'detail__header' }, [
      h('div', { class: 'detail__eyebrow' }, [
        h('span', { class: `row__dot row__dot--${kind}` }),
        h('span', { class: 'tag', text: isResearch ? 'Research' : kind }),
        h('span', { class: 'tag', text: submission.device.platform ?? 'unknown' }),
        submission.sessionId ? h('span', { class: 'tag tag--replay', text: 'Replay' }) : null,
      ]),
      h('h1', {
        class: 'detail__title',
        text: isResearch
          ? `Study response · ${payload.studyId ?? 'unknown'}`
          : payload.title || 'Untitled report',
      }),
      h('div', { class: 'detail__byline' }, [
        reporterName ? h('span', { class: 'avatar', text: initials(submission.reporter?.fullName, submission.reporter?.email) }) : null,
        reporterName ? h('span', { text: reporterName }) : h('span', { text: 'Anonymous reporter' }),
        h('span', { class: 'byline__sep', text: '·' }),
        h('span', { text: new Date(submission.createdAt).toLocaleString() }),
        h('span', { class: 'byline__sep', text: '·' }),
        h('span', { text: deviceSummary(submission) }),
      ]),
    ]),
  );

  // --- description
  if (payload.description) {
    body.push(card('Description', h('p', { class: 'prose', text: payload.description }), {
      iconPath: icons.clipboard,
    }));
  }

  // --- research answers
  if (isResearch && payload.answers?.length) {
    const list = h('div', {}, payload.answers.map((answer) =>
      h('div', { class: 'answer' }, [
        h('div', { class: 'answer__q', text: answer.questionId }),
        h('div', { class: 'answer__a', text: String(answer.value) }),
      ]),
    ));

    body.push(
      card('Answers', list, {
        flush: true,
        iconPath: icons.clipboard,
        note: payload.completed === false ? 'Abandoned partway' : undefined,
      }),
    );
  }

  // --- screenshot
  const screenshot = submission.attachments.find((a) => a.kind === 'screenshot');
  if (screenshot) {
    const image = h('img', {
      src: api.attachmentUrl(screenshot.id),
      alt: 'Screenshot with the reporter’s annotations and redactions burned in',
      loading: 'lazy',
      class: 'shot__img',
    });

    body.push(
      card('Screenshot', h('div', { class: 'shot' }, [image]), {
        flush: true,
        iconPath: icons.image,
        note: `${screenshot.width ?? '?'}×${screenshot.height ?? '?'} · ${formatBytes(screenshot.byteSize)}`,
      }),
    );
  }

  // --- replay
  if (submission.sessionId) body.push(replayCard());

  // --- console
  if (payload.consoleLogs?.length) {
    body.push(
      card('Console', consoleList(payload.consoleLogs), {
        flush: true,
        iconPath: icons.alert,
        note: `${payload.consoleLogs.length} entries`,
      }),
    );
  }

  // --- network
  if (payload.networkLogs?.length) {
    const failed = payload.networkLogs.filter((e) => e.status === undefined || e.status >= 400).length;
    body.push(
      card('Network', networkList(payload.networkLogs), {
        flush: true,
        iconPath: icons.film,
        note: failed > 0 ? `${failed} failed of ${payload.networkLogs.length}` : `${payload.networkLogs.length} requests`,
      }),
    );
  }

  // --- device
  const device = submission.device;
  body.push(
    card(
      'Device',
      specGrid([
        ['Platform', device.platform],
        ['OS', [device.osName, device.osVersion].filter(Boolean).join(' ') || undefined],
        ['Model', device.deviceModel],
        ['Browser', [device.browserName, device.browserVersion].filter(Boolean).join(' ') || undefined],
        ['App version', [device.appVersion, device.appBuild && `(${device.appBuild})`].filter(Boolean).join(' ') || undefined],
        ['Screen', device.screen ? `${device.screen.width}×${device.screen.height} @${device.screen.pixelRatio}x` : undefined],
        ['URL', device.url],
        ['Route', device.route],
        ['Locale', device.locale],
        ['Time zone', device.timezone],
        ['Network', device.networkType],
        ['SDK', device.sdkVersion],
      ]),
      { flush: true, iconPath: icons.device },
    ),
  );

  // --- custom data
  if (submission.customData && Object.keys(submission.customData).length > 0) {
    body.push(
      card(
        'Custom data',
        specGrid(Object.entries(submission.customData).map(([k, v]) => [k, String(v)]), true),
        { flush: true, iconPath: icons.tag },
      ),
    );
  }

  // --- consent, shown because it is the audit trail for why this data exists
  if (submission.consent) {
    body.push(
      card(
        'Consent',
        specGrid([
          ['Scopes', (submission.consent.scopes ?? []).join(', ') || '—'],
          ['Policy version', submission.consent.policyVersion],
          ['Source', submission.consent.source],
          ['Granted', submission.consent.grantedAt ? new Date(submission.consent.grantedAt).toLocaleString() : undefined],
        ]),
        { flush: true, iconPath: icons.shield },
      ),
    );
  }

  body.push(
    card('Reference', specGrid([
      ['Submission ID', submission.id],
      ['Session ID', submission.sessionId],
      ['Received', new Date(submission.receivedAt).toLocaleString()],
    ], true), { flush: true }),
  );

  dom.detail.replaceChildren(h('div', { class: 'detail__inner' }, body));
}

function deviceSummary(submission: Submission): string {
  const device = submission.device;
  return (
    device.deviceModel ??
    [device.browserName, device.osName].filter(Boolean).join(' on ') ??
    device.platform ??
    'unknown device'
  );
}

function consoleList(logs: LogEntry[]): HTMLElement {
  return h('div', { class: 'logs' }, logs.map((log) =>
    h('div', { class: `logline logline--${log.level}` }, [
      h('span', { class: 'logline__lvl', text: log.level }),
      h('span', { class: 'logline__msg', text: log.message }),
      h('span', {
        class: 'logline__status',
        text: new Date(log.timestamp).toLocaleTimeString(),
      }),
    ]),
  ));
}

function networkList(entries: NetworkEntry[]): HTMLElement {
  return h('div', { class: 'logs' }, entries.map((entry) => {
    const failed = entry.status === undefined || entry.status >= 400;
    return h('div', { class: failed ? 'logline logline--error' : 'logline' }, [
      h('span', { class: 'logline__lvl', text: entry.method }),
      h('span', { class: 'logline__msg', text: entry.url }),
      h('span', {
        class: 'logline__status',
        text: entry.status ? `${entry.status} · ${entry.durationMs ?? '?'}ms` : 'failed',
      }),
    ]);
  }));
}

// --- replay -----------------------------------------------------------------

function replayCard(): HTMLElement {
  const stage = h('div', { class: 'player__stage', id: 'replay-stage' }, [
    h('div', { class: 'state', id: 'replay-status' }, [
      h('div', { class: 'state__body', text: 'Loading replay…' }),
    ]),
  ]);

  const playButton = h('button', {
    class: 'player__play',
    id: 'replay-play',
    type: 'button',
    'aria-label': 'Play or pause the replay',
  }, [icon(icons.play, 15)]);

  const scrubber = h('input', {
    type: 'range', min: '0', max: '1000', value: '0',
    class: 'player__scrub', id: 'replay-scrubber',
    'aria-label': 'Seek within the replay',
  });

  const time = h('span', { class: 'player__time', id: 'replay-time', text: '0:00 / 0:00' });

  const controls = h('div', {
    class: 'player__controls', id: 'replay-controls', style: 'display: none',
  }, [playButton, scrubber, time]);

  const wrapper = h('div', {}, [stage, controls]);
  const section = card('Session replay', wrapper, { flush: true, iconPath: icons.film });
  section.id = 'replay-card';
  return section;
}

async function mountReplay(sessionId: string): Promise<void> {
  const stage = document.getElementById('replay-stage');
  const status = document.getElementById('replay-status');
  const controls = document.getElementById('replay-controls');
  if (!stage || !status || !controls) return;

  let session;
  try {
    session = await api.getReplay(sessionId);
  } catch (err) {
    status.replaceChildren(
      emptyState('Replay unavailable', err instanceof Error ? err.message : 'Failed to load.', {
        iconPath: icons.alert,
        variant: 'error',
      }),
    );
    return;
  }

  if (!session) {
    status.replaceChildren(
      emptyState('No replay stored', 'This session was linked but no events were received.', {
        iconPath: icons.film,
      }),
    );
    return;
  }

  const time = document.getElementById('replay-time');
  const scrubber = document.getElementById('replay-scrubber') as HTMLInputElement | null;
  const playButton = document.getElementById('replay-play');

  player = new ReplayPlayer(stage, (current, duration, playing) => {
    if (time) time.textContent = `${formatDuration(current)} / ${formatDuration(duration)}`;
    if (playButton) {
      playButton.replaceChildren(icon(playing ? icons.pause : icons.play, 15));
    }
    // Skip while dragging, or the scrubber fights the user's thumb.
    if (scrubber && !scrubber.matches(':active') && duration > 0) {
      scrubber.value = String(Math.round((current / duration) * 1000));
    }
  });

  // Exposed for debugging playback from the console or an automated check.
  (window as unknown as { __player?: ReplayPlayer }).__player = player;

  if (!player.load(session.events)) {
    status.replaceChildren(
      emptyState('Too short to play', `Only ${session.events.length} event(s) were recorded.`, {
        iconPath: icons.film,
      }),
    );
    return;
  }

  status.remove();
  controls.setAttribute(
    'data-summary',
    `${session.events.length} events · ${session.chunks} chunk(s)${session.final ? '' : ' · ended abruptly'}`,
  );
  controls.style.display = 'flex';

  const replayCardEl = document.getElementById('replay-card');
  const note = replayCardEl?.querySelector('.card__note');
  const summary = `${session.events.length} events${session.final ? '' : ' · ended abruptly'}`;
  if (note) note.textContent = summary;
  else replayCardEl?.querySelector('.card__head')?.append(h('span', { class: 'card__note', text: summary }));

  playButton?.addEventListener('click', () => player?.toggle());
  scrubber?.addEventListener('input', () => {
    player?.seekFraction(Number(scrubber.value) / 1000);
  });
}

// --- wiring -----------------------------------------------------------------

dom.project.value = api.getProject();
dom.project.addEventListener('change', () => {
  const value = dom.project.value.trim() || DEFAULT_PROJECT;
  api.setProject(value);
  localStorage.setItem(PROJECT_KEY, value);
  selectedId = undefined;
  void load();
});

dom.refresh.addEventListener('click', () => void load());

let searchTimer: ReturnType<typeof setTimeout> | undefined;
dom.search.addEventListener('input', () => {
  // Debounced: filtering is local, but re-rendering the list on every keystroke
  // of a long query is wasted work on a large inbox.
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    query = dom.search.value.trim().toLowerCase();
    applyFilters();
  }, 120);
});

dom.filters.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-filter]');
  if (!button) return;

  filter = button.dataset.filter as Filter;
  for (const chip of dom.filters.querySelectorAll('.chip')) {
    chip.classList.toggle('is-active', chip === button);
  }
  applyFilters();
});

// Keyboard navigation: j/k and arrows move through the inbox, / focuses search.
document.addEventListener('keydown', (event) => {
  const typing =
    event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;

  if (event.key === '/' && !typing) {
    event.preventDefault();
    dom.search.focus();
    return;
  }
  if (event.key === 'Escape' && typing) {
    (event.target as HTMLElement).blur();
    return;
  }
  if (typing) return;

  const isNext = event.key === 'j' || event.key === 'ArrowDown';
  const isPrev = event.key === 'k' || event.key === 'ArrowUp';
  if (!isNext && !isPrev) return;

  event.preventDefault();
  const index = visible.findIndex((s) => s.id === selectedId);
  const next = Math.min(Math.max(index + (isNext ? 1 : -1), 0), visible.length - 1);
  const target = visible[next];

  if (target) {
    select(target.id);
    dom.list
      .querySelector<HTMLElement>(`[data-id="${target.id}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }
});

void load();
