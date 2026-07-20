import { loadWidget } from './sdk.js';

const INGEST = 'http://localhost:4000';
const PROJECT = 'proj_demo';

const $ = (id) => document.getElementById(id);

// --- plan selection ---------------------------------------------------------

let plan = { name: 'Business', price: 149 };

const PRORATION = 18.4;
const TAX_RATE = 0.2;

function money(value) {
  return `$${value.toFixed(2)}`;
}

function renderSummary() {
  const subtotal = plan.price - PRORATION;
  const tax = subtotal * TAX_RATE;
  const total = subtotal + tax;

  $('summary-plan').textContent = `${plan.name} plan`;
  $('summary-price').textContent = money(plan.price);
  $('summary-tax').textContent = money(tax);
  $('summary-total').textContent = money(total);
  $('pay').textContent = `Pay ${money(total)}`;
}

$('plans').addEventListener('click', (event) => {
  const node = event.target.closest('.plan');
  if (!node) return;

  for (const el of document.querySelectorAll('.plan')) {
    el.classList.toggle('is-selected', el === node);
  }

  plan = {
    name: node.dataset.plan.replace(/^./, (c) => c.toUpperCase()),
    price: Number(node.dataset.price),
  };
  renderSummary();
});

renderSummary();

// --- checkout ---------------------------------------------------------------

function alertBox(kind, title, body) {
  const wrapper = document.createElement('div');
  wrapper.className = `alert alert--${kind}`;

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('width', '16');
  icon.setAttribute('height', '16');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.classList.add('alert__icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 8v5M12 16.5v.5M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.7');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  icon.append(path);

  const text = document.createElement('div');
  text.append(Object.assign(document.createElement('strong'), { textContent: title }), ' ', body);

  wrapper.append(icon, text);
  return wrapper;
}

/**
 * THE BUG (deliberate).
 *
 * `submitting` guards against double-charging, which is correct. But the
 * decline path returns early without clearing it, so after one declined attempt
 * the button is dead for the rest of the session — no error, no feedback, the
 * click just does nothing.
 *
 * This is the exact defect described in the seeded bug report, so the demo and
 * the dashboard tell one coherent story.
 */
let submitting = false;

$('pay').addEventListener('click', async () => {
  if (submitting) return;
  submitting = true;

  const button = $('pay');
  const original = button.textContent;
  button.disabled = true;
  button.replaceChildren(
    Object.assign(document.createElement('span'), { className: 'spinner' }),
    document.createTextNode(' Processing…'),
  );
  $('alert-slot').replaceChildren();

  const card = $('card').value.replace(/\s/g, '');

  // A real request the SDK's fetch instrumentation will capture and attach.
  await fetch(`${INGEST}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan: plan.name, last4: card.slice(-4) }),
  }).catch(() => {});

  await new Promise((r) => setTimeout(r, 900));

  button.disabled = false;
  button.textContent = original;

  if (card === '4242424242424242') {
    submitting = false;
    $('alert-slot').replaceChildren(
      alertBox('warn', 'Payment approved.', 'This demo stops short of charging anything.'),
    );
    console.info('[checkout] approved', { plan: plan.name });
    return;
  }

  console.warn('[checkout] card declined', { last4: card.slice(-4), plan: plan.name });
  console.error('TypeError: Cannot read properties of null (reading "submit")');

  $('alert-slot').replaceChildren(
    alertBox(
      'error',
      'Your card was declined.',
      'Check the number and try again, or use a different payment method.',
    ),
  );

  // ← `submitting` is never reset here. Every later click is swallowed above.
});

// --- SDK --------------------------------------------------------------------

const widget = await loadWidget({
  project: PROJECT,
  endpoint: INGEST,
  replay: { enabled: true },
});

widget.setReporter({ email: 'dana@acme-corp.com', fullName: 'Dana Whitfield' });
widget.setCustomData({ plan: 'enterprise', tenantId: 'acme-42', featureFlags: 'new-checkout' });

function setRecording(sessionId) {
  const recording = Boolean(sessionId);
  $('rec-dot').className = recording ? 'dot dot--live' : 'dot';
  $('rec-status').textContent = recording ? 'Recording this session' : 'Not recording';
  $('session-id').textContent = sessionId ?? 'No active session';
}

$('grant').addEventListener('click', async () => {
  await widget.grantConsent(['session_replay']);
  setRecording(await widget.startRecording());
});

$('stop').addEventListener('click', async () => {
  await widget.stopRecording();
  $('rec-dot').className = 'dot';
  $('rec-status').textContent = 'Stopped — final chunk flushed';
});

$('revoke').addEventListener('click', async () => {
  await widget.revokeConsent();
  $('rec-dot').className = 'dot';
  $('rec-status').textContent = 'Consent revoked — buffered events discarded';
  $('session-id').textContent = 'No active session';
});

// Exposed so the seed script can drive the app without clicking through the UI.
window.__demo = { widget, setRecording };
