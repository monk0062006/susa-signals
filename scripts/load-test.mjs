/**
 * Finds the ingest service's actual ceiling.
 *
 * Untested capacity is what takes a service down on day one: everything looks
 * fine at the ten requests a developer sends by hand, and the first real
 * customer arrives at a thousand. This ramps concurrency until latency degrades
 * and reports where that happens, rather than asserting a number someone hoped
 * for.
 *
 *   node scripts/load-test.mjs [--endpoint URL] [--seconds N]
 */

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg, i, all) =>
    arg.startsWith('--') ? [[arg.slice(2), all[i + 1] ?? 'true']] : [],
  ),
);

const ENDPOINT = args.endpoint ?? process.env.INGEST ?? 'http://localhost:4000';
const SECONDS_PER_STAGE = Number(args.seconds ?? 6);
const RUN = Date.now().toString(36);
/**
 * Rate limiting is per-project, so a single project id measures the limiter
 * rather than the service behind it. Spreading across many projects lets real
 * work through and exposes the storage ceiling, which is the number that
 * decides whether this survives a launch.
 */
const PROJECT_COUNT = Number(args.projects ?? 40);
const PROJECTS = Array.from({ length: PROJECT_COUNT }, (_, i) => `loadtest_${RUN}_${i}`);
let projectCursor = 0;
const nextProject = () => PROJECTS[projectCursor++ % PROJECTS.length];

/** Concurrency levels to walk. Stops early once the service is clearly past it. */
const STAGES = [1, 5, 10, 25, 50, 100, 200];

const uuid = () => crypto.randomUUID();

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

/** One analytics batch — the highest-volume path, so the one that matters. */
function eventBatch(size) {
  const sessionId = uuid();
  return {
    events: Array.from({ length: size }, (_, i) => ({
      id: uuid(),
      name: `load_event_${i % 5}`,
      sessionId,
      timestamp: Date.now(),
      userId: `user_${i % 50}`,
      properties: { index: i, stage: 'load' },
    })),
    device: { platform: 'web', sdkVersion: '0.0.0', browserName: 'LoadTest' },
  };
}

async function fireOnce(path, body) {
  const started = performance.now();
  try {
    const res = await fetch(`${ENDPOINT}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-project-id': nextProject() },
      body: JSON.stringify(body),
    });
    // Drain, or sockets pile up and skew later stages.
    await res.text();
    return { ms: performance.now() - started, status: res.status };
  } catch (err) {
    return { ms: performance.now() - started, status: 0, error: String(err?.cause?.code ?? err) };
  }
}

async function runStage(concurrency, path, makeBody) {
  const latencies = [];
  const statuses = new Map();
  const deadline = Date.now() + SECONDS_PER_STAGE * 1000;
  let inflight = 0;
  let completed = 0;

  await new Promise((resolve) => {
    const pump = () => {
      if (Date.now() >= deadline && inflight === 0) return resolve();

      while (inflight < concurrency && Date.now() < deadline) {
        inflight++;
        void fireOnce(path, makeBody()).then(({ ms, status }) => {
          inflight--;
          completed++;
          latencies.push(ms);
          statuses.set(status, (statuses.get(status) ?? 0) + 1);
          pump();
        });
      }
    };
    pump();
  });

  latencies.sort((a, b) => a - b);
  const elapsed = SECONDS_PER_STAGE;

  const accepted = [...statuses.entries()]
    .filter(([status]) => status >= 200 && status < 300)
    .reduce((sum, [, n]) => sum + n, 0);

  return {
    concurrency,
    rps: Math.round(completed / elapsed),
    acceptedRps: Math.round(accepted / elapsed),
    p50: Math.round(percentile(latencies, 50)),
    p95: Math.round(percentile(latencies, 95)),
    p99: Math.round(percentile(latencies, 99)),
    max: Math.round(latencies.at(-1) ?? 0),
    statuses: Object.fromEntries(statuses),
  };
}

function summarize(label, rows) {
  console.log(`\n${label}`);
  console.log('  conc    rps    ok/s     p50     p95     p99     max   statuses');
  for (const r of rows) {
    console.log(
      `  ${String(r.concurrency).padStart(4)}  ${String(r.rps).padStart(5)}  ` +
        `${String(r.acceptedRps).padStart(5)}  ` +
        `${String(r.p50).padStart(5)}ms ${String(r.p95).padStart(5)}ms ` +
        `${String(r.p99).padStart(5)}ms ${String(r.max).padStart(5)}ms   ` +
        JSON.stringify(r.statuses),
    );
  }
}

const health = await fetch(`${ENDPOINT}/health`).then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.error(`Ingest not healthy at ${ENDPOINT}. Run: npm run ingest`);
  process.exit(1);
}

console.log(`Load testing ${ENDPOINT}`);
console.log(`projects=${PROJECT_COUNT}  ${SECONDS_PER_STAGE}s per stage`);
console.log('\nNOTE: rate limiting is per-project, so a single load-test project');
console.log('hits its own throttle before the service saturates. 429s below are');
console.log('the limiter working, not a failure.');

// --- events, 50 per batch: the realistic high-volume shape ------------------
const eventRows = [];
for (const concurrency of STAGES) {
  const row = await runStage(concurrency, '/v1/events', () => eventBatch(50));
  eventRows.push(row);
  process.stdout.write(`  events @${concurrency}: ${row.rps} rps, p95 ${row.p95}ms\n`);

  // Past a second of p95 the service is no longer usefully serving; further
  // stages only measure how badly it queues.
  if (row.p95 > 1000) {
    console.log('  (stopping: p95 exceeded 1s)');
    break;
  }
}
summarize('EVENTS (batch of 50)', eventRows);

// --- reports: low volume, but the payload that must never be dropped --------
const reportRows = [];
for (const concurrency of [1, 5, 10, 25]) {
  const row = await runStage(concurrency, '/v1/reports', () => ({
    id: uuid(),
    projectId: PROJECTS[0],
    payload: { type: 'bug_report', kind: 'bug', title: 'load test report', annotations: [] },
    device: { platform: 'web', sdkVersion: '0.0.0' },
    attachments: [],
    createdAt: Date.now(),
  }));
  reportRows.push(row);
  if (row.p95 > 1000) break;
}
summarize('REPORTS', reportRows);

const best = eventRows.reduce((a, b) => (b.rps > a.rps ? b : a), eventRows[0]);
console.log(`\nPeak observed: ${best.rps} req/s at concurrency ${best.concurrency} ` +
  `(${best.rps * 50} events/s), p95 ${best.p95}ms`);
console.log('Interpretation: this is a single Node process against one Postgres on');
console.log('a developer laptop. Treat it as a floor, not a capacity plan.\n');
