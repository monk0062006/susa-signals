/**
 * Seeds the ingest service with realistic submissions so the dashboard has
 * something to render.
 *
 * Uses a real browser to produce a real screenshot and real rrweb events rather
 * than hand-written fixtures. Fixtures would prove the dashboard can render
 * fixtures; this proves it can render what the SDK actually emits.
 */
import puppeteer from 'puppeteer-core';
import { startServer } from './static-server.mjs';

const CHROME =
  process.env.CHROME_PATH ??
  {
    win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: '/usr/bin/google-chrome',
  }[process.platform] ??
  '/usr/bin/google-chrome';

const INGEST = process.env.INGEST ?? 'http://localhost:4000';
const PROJECT = process.env.PROJECT ?? 'proj_demo';
const PORT = 5198;

const uuid = () => crypto.randomUUID();

async function post(path, body, extraHeaders = {}) {
  const res = await fetch(`${INGEST}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-project-id': PROJECT, ...extraHeaders },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json().catch(() => ({}));
}

let browser;
let stopServer;

try {
  // Fail fast with a clear message rather than a confusing fetch error.
  const health = await fetch(`${INGEST}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`Ingest not reachable at ${INGEST}. Run: npm run ingest`);
    process.exit(1);
  }

  stopServer = await startServer(PORT);
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });

  // --- 1. real rrweb events -------------------------------------------------
  console.log('recording a session…');

  const sessionId = uuid();
  await page.evaluate(async () => {
    const { ReplayRecorder } = await import('./sdk.js');
    const captured = [];
    const fakeClient = { sendReplayChunk: async (chunk) => captured.push(chunk) };
    const consent = { has: async () => true, load: async () => null };

    const recorder = new ReplayRecorder(fakeClient, consent, 'proj_demo', {});
    await recorder.start();

    window.__captured = captured;
    window.__recorder = recorder;
  });

  // Generate activity worth watching back.
  //
  // Paced deliberately: rrweb's duration comes from event timestamps, so a burst
  // of interactions with no pauses produces a sub-second recording that is
  // useless to a researcher and indistinguishable from a broken one.
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  // Walks the actual bug: pick a plan, attempt payment, get declined, then find
  // the button dead on retry. The recording therefore shows the defect the
  // seeded report describes, rather than arbitrary mouse movement.
  await pause(700);
  await page.click('.plan[data-plan="enterprise"]');
  await pause(900);

  await page.click('.plan[data-plan="business"]');
  await pause(700);

  // Password field: masked in the recording, which is the point.
  await page.type('#pw', 'hunter2-SUPERSECRET', { delay: 70 });
  await pause(700);

  await page.click('#pay');
  await pause(1800); // decline lands

  await page.evaluate(() => window.scrollBy({ top: 220, behavior: 'smooth' }));
  await pause(800);

  // The retry that does nothing.
  await page.click('#pay');
  await pause(900);
  await page.click('#pay');
  await pause(1100);

  const events = await page.evaluate(async () => {
    await window.__recorder.stop();
    return window.__captured.flatMap((chunk) => chunk.events);
  });

  console.log(`  captured ${events.length} rrweb events`);

  // --- 2. real screenshot ---------------------------------------------------
  const screenshot = await page.screenshot({ type: 'png' });

  const form = new FormData();
  form.append('file', new Blob([screenshot], { type: 'image/png' }), 'screenshot.png');
  form.append('kind', 'screenshot');

  const uploadRes = await fetch(`${INGEST}/v1/uploads`, {
    method: 'POST',
    headers: { 'x-project-id': PROJECT },
    body: form,
  });
  if (!uploadRes.ok) throw new Error(`upload -> ${uploadRes.status}`);
  const { id: attachmentId } = await uploadRes.json();
  console.log(`  uploaded screenshot ${attachmentId} (${(screenshot.length / 1024).toFixed(1)} KB)`);

  // --- 3. replay chunks -----------------------------------------------------
  // Chunked the way the SDK does, so the dashboard exercises reassembly rather
  // than receiving one convenient blob.
  const CHUNK = 40;
  let seq = 0;
  for (let i = 0; i < events.length; i += CHUNK) {
    const slice = events.slice(i, i + CHUNK);
    await post('/v1/replay/chunks', {
      sessionId,
      projectId: PROJECT,
      seq: seq++,
      events: slice,
      startedAt: Date.now() - 10_000,
      endedAt: Date.now(),
      final: i + CHUNK >= events.length,
    });
  }
  console.log(`  sent ${seq} replay chunk(s)`);

  // --- 4. submissions -------------------------------------------------------
  const device = {
    platform: 'web',
    sdkVersion: '0.0.0',
    osName: 'Windows',
    browserName: 'Chrome',
    browserVersion: '120.0',
    locale: 'en-US',
    timezone: 'America/New_York',
    screen: { width: 1200, height: 800, pixelRatio: 1 },
    url: `http://localhost:${PORT}/`,
  };

  const consent = {
    scopes: ['screenshot', 'diagnostics', 'session_replay'],
    policyVersion: '1',
    grantedAt: Date.now() - 60_000,
    source: 'explicit_prompt',
  };

  // Seeded oldest-first. The API orders by arrival time (server clock), so
  // inserting in chronological order makes the demo list read chronologically
  // instead of backwards.
  await post('/v1/reports', {
    id: uuid(),
    projectId: PROJECT,
    payload: {
      type: 'bug_report',
      kind: 'feedback',
      title: 'Export dialog is confusing',
      description: 'Not a bug exactly — I could not tell whether "Export" meant CSV or PDF until I clicked it.',
      annotations: [],
    },
    device: { ...device, platform: 'ios', osName: 'iOS', osVersion: '17.2', deviceModel: 'iPhone15,2' },
    createdAt: Date.now() - 600_000,
  });
  console.log('  seeded feedback item');

  await post('/v1/reports', {
    id: uuid(),
    projectId: PROJECT,
    payload: {
      type: 'research_response',
      studyId: 'onboarding-q3',
      answers: [
        { questionId: 'How easy was setup?', value: 'Somewhat difficult' },
        { questionId: 'What almost stopped you?', value: 'Could not find where to add teammates.' },
      ],
      completed: true,
      durationMs: 62_000,
    },
    device: { ...device, platform: 'android', osName: 'Android', osVersion: '14', deviceModel: 'Google Pixel 8' },
    reporter: { email: 'sam@acme-corp.com', fullName: 'Sam Okafor' },
    customData: { plan: 'trial' },
    createdAt: Date.now() - 300_000,
  });
  console.log('  seeded research response');

  await post('/v1/reports', {
    id: uuid(),
    projectId: PROJECT,
    payload: {
      type: 'bug_report',
      kind: 'bug',
      title: 'Checkout button does nothing on second attempt',
      description:
        'Tapping Pay works the first time. If the card is declined and I retry, the button stops responding entirely. Had to reload.',
      annotations: [
        { type: 'rect', origin: { x: 0.12, y: 0.3 }, width: 0.4, height: 0.12, color: '#ff3b30' },
        { type: 'blur', origin: { x: 0.1, y: 0.55 }, width: 0.5, height: 0.06 },
      ],
      consoleLogs: [
        { level: 'warn', message: 'Cart total recalculated unexpectedly {"total":42.5}', timestamp: Date.now() - 8000 },
        { level: 'error', message: 'TypeError: Cannot read properties of null (reading "submit")', timestamp: Date.now() - 5000 },
      ],
      networkLogs: [
        { method: 'POST', url: '/api/checkout', status: 500, durationMs: 812, timestamp: Date.now() - 6000 },
        { method: 'GET', url: '/api/cart', status: 200, durationMs: 94, timestamp: Date.now() - 9000 },
      ],
    },
    device,
    reporter: { email: 'dana@acme-corp.com', fullName: 'Dana Whitfield' },
    attachments: [
      { id: attachmentId, kind: 'screenshot', mimeType: 'image/png', byteSize: screenshot.length, width: 1200, height: 800 },
    ],
    customData: { plan: 'enterprise', tenantId: 'acme-42', featureFlags: 'new-checkout' },
    sessionId,
    consent,
    createdAt: Date.now() - 120_000,
  });
  console.log('  seeded bug report (with replay + screenshot)');

  console.log(`\nDone. Open ${INGEST}/ to view the dashboard.`);
} catch (err) {
  console.error('\nSeed failed:', err);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stopServer?.();
}
