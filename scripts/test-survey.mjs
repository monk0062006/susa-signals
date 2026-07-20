/**
 * End-to-end proof that the survey path works: define a study, present it in a
 * real browser, answer it, and confirm the response aggregates in the dashboard.
 *
 * This is the path that did not exist until now — the schema, API and dashboard
 * all handled research responses, but nothing asked a user a question.
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
const PROJECT = 'proj_demo';
// Unique per run: the previous fixed id accumulated responses across runs, so
// absolute assertions ("completed === 1") drifted every time the suite ran.
const STUDY_ID = `checkout-nps-test-${Date.now()}`;
const PORT = 5196;

let browser;
let stopServer;
let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reaches into the survey's shadow root, which querySelector cannot pierce. */
async function inPanel(page, selector, action = 'click') {
  return page.evaluate(
    (sel, act) => {
      const host = document.querySelector('.mio-survey');
      const node = host?.shadowRoot?.querySelector(sel);
      if (!node) return false;
      if (act === 'click') node.click();
      else if (act === 'text') return node.textContent;
      return true;
    },
    selector,
    action,
  );
}

try {
  const health = await fetch(`${INGEST}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`Ingest not reachable at ${INGEST}. Run: npm run ingest`);
    process.exit(1);
  }

  // --- define the study ------------------------------------------------------
  const study = {
    name: 'Checkout experience',
    questions: [
      {
        id: 'nps',
        type: 'nps',
        prompt: 'How likely are you to recommend Meridian?',
        labels: ['Not likely', 'Very likely'],
        required: true,
      },
      {
        id: 'blocker',
        type: 'single_choice',
        prompt: 'What got in your way today?',
        options: ['Payment failed', 'Confusing pricing', 'Missing feature', 'Nothing'],
      },
      { id: 'why', type: 'text', prompt: 'Anything else?', placeholder: 'Optional' },
    ],
    thanks: 'Thanks — that helps.',
  };

  const put = await fetch(`${INGEST}/v1/studies/${STUDY_ID}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-project-id': PROJECT },
    body: JSON.stringify(study),
  });
  check('study can be defined via the API', put.ok, `status ${put.status}`);

  stopServer = await startServer(PORT);
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });

  console.log('\nPresenting the survey');
  // Deliberately not awaited inside the page: showSurveyById resolves only once
  // the user finishes or dismisses, so returning it to page.evaluate would block
  // until the test itself answered — which it cannot do while blocked.
  await page.evaluate((id) => {
    void window.__demo.widget.showSurveyById(id);
  }, STUDY_ID);
  await page.waitForSelector('.mio-survey', { timeout: 8000 });
  check('survey panel appears', true);

  const prompt = await inPanel(page, '.prompt', 'text');
  check('first question renders', String(prompt).includes('recommend Meridian'), String(prompt));

  // Required question: Next must be blocked until answered.
  const blocked = await page.evaluate(() => {
    const host = document.querySelector('.mio-survey');
    return host?.shadowRoot?.querySelector('[data-next]')?.disabled;
  });
  check('required question blocks Next until answered', blocked === true);

  console.log('\nAnswering');
  // NPS row is 0..10, so index 9 is a score of 9 — a promoter.
  await page.evaluate(() => {
    const host = document.querySelector('.mio-survey');
    host?.shadowRoot?.querySelectorAll('.scale__btn')[9]?.click();
  });
  await pause(150);

  const unblocked = await page.evaluate(() => {
    const host = document.querySelector('.mio-survey');
    return host?.shadowRoot?.querySelector('[data-next]')?.disabled;
  });
  check('answering unblocks Next', unblocked === false);

  await inPanel(page, '[data-next]');
  await pause(250);

  const second = await inPanel(page, '.prompt', 'text');
  check('advances to the second question', String(second).includes('got in your way'), String(second));

  await page.evaluate(() => {
    const host = document.querySelector('.mio-survey');
    const choices = host?.shadowRoot?.querySelectorAll('.choice');
    for (const choice of choices ?? []) {
      if (choice.textContent?.includes('Payment failed')) choice.click();
    }
  });
  await pause(150);
  await inPanel(page, '[data-next]');
  await pause(250);

  await page.evaluate(() => {
    const host = document.querySelector('.mio-survey');
    const textarea = host?.shadowRoot?.querySelector('.text');
    if (textarea) {
      textarea.value = 'The pay button stopped responding after a decline.';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await pause(150);
  await inPanel(page, '[data-next]');
  await pause(400);

  const thanks = await inPanel(page, '.thanks__text', 'text');
  check('shows the thank-you state', String(thanks).includes('Thanks'), String(thanks));

  console.log('\nDelivery');
  await pause(1200);

  const res = await fetch(`${INGEST}/v1/studies/${STUDY_ID}/results`, {
    headers: { 'x-project-id': PROJECT },
  });
  const { results } = await res.json();

  check('response reached the server', results.responses >= 1, JSON.stringify(results));
  check('marked completed', results.completed >= 1);
  check('NPS answer stored', (results.answers.nps ?? []).includes(9), JSON.stringify(results.answers.nps));
  check(
    'choice answer stored',
    (results.answers.blocker ?? []).includes('Payment failed'),
    JSON.stringify(results.answers.blocker),
  );
  check(
    'verbatim stored',
    (results.answers.why ?? []).some((t) => String(t).includes('stopped responding')),
    JSON.stringify(results.answers.why),
  );

  console.log('\nPartial responses');
  await page.reload({ waitUntil: 'networkidle0' });
  // Deliberately not awaited inside the page: showSurveyById resolves only once
  // the user finishes or dismisses, so returning it to page.evaluate would block
  // until the test itself answered — which it cannot do while blocked.
  await page.evaluate((id) => {
    void window.__demo.widget.showSurveyById(id);
  }, STUDY_ID);
  await page.waitForSelector('.mio-survey', { timeout: 8000 });
  await page.evaluate(() => {
    const host = document.querySelector('.mio-survey');
    host?.shadowRoot?.querySelectorAll('.scale__btn')[2]?.click();
  });
  await pause(150);
  // Dismiss after one answer.
  await inPanel(page, '[data-close]');
  await pause(1200);

  const res2 = await fetch(`${INGEST}/v1/studies/${STUDY_ID}/results`, {
    headers: { 'x-project-id': PROJECT },
  });
  const { results: r2 } = await res2.json();

  // Discarding partials would bias results toward people with time to finish.
  check('partial response is kept', r2.responses >= 2, JSON.stringify(r2.responses));
  check('partial is not counted as completed', r2.completed === 1, JSON.stringify(r2.completed));

  console.log('\nRuntime');
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));
} catch (err) {
  failures++;
  console.error('\nHarness error:', err);
} finally {
  await browser?.close();
  await stopServer?.();
}

console.log(failures === 0 ? '\nAll survey checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
