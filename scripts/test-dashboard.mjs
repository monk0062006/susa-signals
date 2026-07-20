/**
 * Verifies the dashboard renders real submissions in a real browser.
 *
 * Asserts on rendered DOM and on whether images actually decoded, not on HTTP
 * status codes. A dashboard that returns 200 and paints an empty page is the
 * failure mode worth catching.
 */
import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH ??
  {
    win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: '/usr/bin/google-chrome',
  }[process.platform] ??
  '/usr/bin/google-chrome';

const URL = process.env.DASHBOARD_URL ?? 'http://localhost:4000/';

let browser;
let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.row', { timeout: 10_000 });

  const titles = () => page.$$eval('.row__title', (els) => els.map((el) => el.textContent ?? ''));

  console.log('\nSubmission list');
  let rows = await titles();
  check('list renders submissions', rows.length >= 3, `got ${rows.length}`);
  check('bug report appears', rows.some((t) => t.includes('Checkout button')), rows.join(' | '));
  check('research response appears', rows.some((t) => t.includes('onboarding-q3')), rows.join(' | '));
  check(
    'replay badge marks the session-linked report',
    (await page.$$('.tag--replay')).length >= 1,
  );

  console.log('\nFilter chips');
  const allCount = await page.$eval('[data-count="all"]', (el) => Number(el.textContent));
  check('counts are populated', allCount >= 3, `all=${allCount}`);

  await page.click('[data-filter="research"]');
  await pause(200);
  rows = await titles();
  check('research filter narrows the list', rows.every((t) => t.includes('Study response')), rows.join(' | '));

  await page.click('[data-filter="all"]');
  await pause(200);
  check('clearing the filter restores the list', (await titles()).length >= 3);

  console.log('\nSearch');
  // 'checkout' also matches study ids; use a phrase only the report carries.
  await page.type('#search', 'second attempt');
  await pause(350);
  rows = await titles();
  check('search narrows to matches', rows.length === 1 && rows[0].includes('Checkout'), rows.join(' | '));

  await page.$eval('#search', (el) => {
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await pause(350);
  check('clearing search restores the list', (await titles()).length >= 3);

  console.log('\nDetail view');
  // Select by content, not index: list order is a product decision this test
  // should not be coupled to.
  const bugIndex = (await titles()).findIndex((t) => t.includes('Checkout button'));
  await (await page.$$('.row'))[bugIndex].click();
  await pause(500);

  const heading = await page.$eval('.detail__title', (el) => el.textContent ?? '');
  check('detail shows the report title', heading.includes('Checkout button'), heading);

  const bodyText = await page.$eval('.detail', (el) => el.textContent ?? '');
  check('description is rendered', bodyText.includes('card is declined'));
  check('device context is rendered', bodyText.includes('Chrome'));
  check('custom data is rendered', bodyText.includes('acme-42'));
  check('consent audit trail is rendered', bodyText.includes('session_replay'));
  check('console error is rendered', bodyText.includes('Cannot read properties of null'));
  check('failing request is rendered', bodyText.includes('/api/checkout'));
  check('reporter is rendered', bodyText.includes('Dana Whitfield'));
  check('reporter avatar shows initials', (await page.$eval('.avatar', (el) => el.textContent)) === 'DW');

  console.log('\nScreenshot');
  await page.waitForSelector('.shot__img', { timeout: 5000 });
  const image = await page.$eval('.shot__img', (el) => ({
    complete: el.complete,
    width: el.naturalWidth,
  }));
  // naturalWidth > 0 is the real test: a broken src still yields an <img>.
  check('screenshot actually decoded', image.complete && image.width > 0, JSON.stringify(image));

  console.log('\nSession replay');
  await page.waitForFunction(
    () => {
      const controls = document.getElementById('replay-controls');
      return controls && getComputedStyle(controls).display !== 'none';
    },
    { timeout: 15_000 },
  );
  check('playback controls appear', true);
  check('rrweb mounted a replay surface', (await page.$$('.player__stage iframe')).length >= 1);

  const before = await page.$eval('#replay-time', (el) => el.textContent ?? '');
  await page.click('#replay-play');
  await pause(1500);
  const after = await page.$eval('#replay-time', (el) => el.textContent ?? '');
  check('playback advances the clock', before !== after, `${before} -> ${after}`);

  console.log('\nKeyboard navigation');
  await page.evaluate(() => document.activeElement?.blur());
  const beforeKey = await page.$eval('.row.is-selected .row__title', (el) => el.textContent ?? '');
  await page.keyboard.press('j');
  await pause(400);
  const afterKey = await page.$eval('.row.is-selected .row__title', (el) => el.textContent ?? '');
  check('j moves the selection', beforeKey !== afterKey, `${beforeKey} -> ${afterKey}`);

  await page.keyboard.press('/');
  await pause(200);
  check(
    '/ focuses search',
    await page.evaluate(() => document.activeElement?.id === 'search'),
  );

  console.log('\nTheme');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await pause(300);
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await pause(300);
  const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('dark and light themes differ', darkBg !== lightBg, `${darkBg} vs ${lightBg}`);

  console.log('\nEmpty state');
  await page.type('#search', 'zzzzz-no-such-thing');
  await pause(350);
  check(
    'no-match shows an empty state, not a blank panel',
    (await page.$$('.state')).length >= 1,
  );

  console.log('\nRuntime');
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));
} catch (err) {
  failures++;
  console.error('\nHarness error:', err);
} finally {
  await browser?.close();
}

console.log(failures === 0 ? '\nAll dashboard checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
