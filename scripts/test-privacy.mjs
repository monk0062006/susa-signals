/**
 * Runtime proof that replay masking redacts before data leaves the browser.
 *
 * This is deliberately an end-to-end browser test rather than a unit test of the
 * config object. The claim being verified — "a password typed into a recorded
 * page is not in the transmitted bytes" — is only true if rrweb actually honours
 * the options at runtime. Asserting on the config would prove we asked nicely,
 * not that it worked.
 */
import puppeteer from 'puppeteer-core';
import { startServer } from './static-server.mjs';

/**
 * Chrome location differs per platform, so CI passes it explicitly.
 * `puppeteer-core` never downloads a browser — it always needs a real path.
 */
const CHROME =
  process.env.CHROME_PATH ??
  {
    win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: '/usr/bin/google-chrome',
  }[process.platform] ??
  '/usr/bin/google-chrome';

// Port 0 would be ideal but the fixture URL must be known up front; a high port
// keeps this from colliding with a dev server on 5173.
const PORT = Number(process.env.TEST_PORT ?? 5199);
const URL = `http://localhost:${PORT}/privacy-test.html`;

const PASSWORD = 'hunter2-SUPERSECRET';
const CARD = '4242424242424242';
const SEARCH = 'blue running shoes';

let browser;
let stopServer;
let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

try {
  // Owns its own server so the suite is runnable on a clean checkout.
  stopServer = await startServer(PORT);

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    // Required for Chrome inside CI containers, which run without user namespaces.
    args: process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
  });
  const page = await browser.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Track chunk fetches to prove the heavy dependencies really are deferred.
  const requested = [];
  page.on('request', (req) => requested.push(req.url()));

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.__ready === true', { timeout: 10_000 });

  console.log('\nLazy loading');
  const fetchedRrweb = () => requested.some((u) => /rrweb-[A-Z0-9]+\.js/i.test(u));
  check(
    'rrweb is NOT downloaded on page load',
    !fetchedRrweb(),
    requested.filter((u) => u.includes('rrweb')).join(', '),
  );

  console.log('\nConsent gate');
  const deniedSession = await page.evaluate(() => window.__test.startDenied());
  check(
    'recorder refuses to start without consent',
    deniedSession === undefined,
    `got session id ${deniedSession}`,
  );

  console.log('\nMasking');
  const grantedSession = await page.evaluate(() => window.__test.startGranted());
  check('recorder starts when consent is present', typeof grantedSession === 'string');

  // Fetched only after the consent gate passed — the ordering that makes the
  // deferral meaningful rather than incidental.
  check('rrweb IS downloaded once recording starts', fetchedRrweb());

  // Type into the fields after recording begins, so the input events are captured.
  await page.type('#password', PASSWORD);
  await page.type('#cardnum', CARD);
  await page.type('#normal', SEARCH);

  await page.evaluate(() => window.__test.stop());

  const payload = await page.evaluate(() => window.__test.serialized());

  check(
    'password value is absent from transmitted events',
    !payload.includes(PASSWORD),
    'PASSWORD LEAKED',
  );
  check(
    'card number is absent from transmitted events',
    !payload.includes(CARD),
    'CARD NUMBER LEAKED',
  );
  check(
    'data-private text is absent from transmitted events',
    !payload.includes('PRIVATE-TEXT-CANARY'),
    'PRIVATE TEXT LEAKED',
  );

  // The negative control. If this also passes, the test proves nothing —
  // it would mean nothing at all was recorded.
  check(
    'non-sensitive page text IS recorded (negative control)',
    payload.includes('PUBLIC-TEXT-CANARY'),
    'nothing was captured; masking assertions above are meaningless',
  );

  check('no uncaught page errors', errors.length === 0, errors.join('; '));

  console.log(`\npayload size: ${payload.length} bytes`);
} catch (err) {
  failures++;
  console.error('\nTest harness error:', err);
} finally {
  await browser?.close();
  await stopServer?.();
}

console.log(failures === 0 ? '\nAll privacy checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
