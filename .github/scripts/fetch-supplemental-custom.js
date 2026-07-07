#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
let SHARED = path.join(__dirname, 'aggregator', 'lib');
if (!fs.existsSync(SHARED)) {
  SHARED = path.join(__dirname, '..', 'aggregator', 'lib');
}

const { fetchAllGoogleJobs, fetchGoogleCanadaJobs } = require(`${SHARED}/fetchers/google`);
const { fetchAllMicrosoftJobs } = require(`${SHARED}/fetchers/microsoft`);
const { fetchAllAppleJobs } = require(`${SHARED}/fetchers/apple`);
const { fetchAllByteDanceJobs } = require(`${SHARED}/fetchers/bytedance`);
const { fetchAllAmazonJobs } = require(`${SHARED}/fetchers/amazon`);

const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const JOBS_FILE = path.join(DATA_DIR, 'supplemental-custom-jobs.json');
const META_FILE = path.join(DATA_DIR, 'supplemental-custom-metadata.json');

function countJsonlLines(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length; }
  catch { return 0; }
}

function hasR2Env() {
  return Boolean(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT && process.env.R2_BUCKET_NAME);
}

function isGitHubActions() {
  return process.env.GITHUB_ACTIONS === 'true';
}

async function uploadRequired(r2, name, file, contentType) {
  const ok = await r2.uploadRaw(name, fs.readFileSync(file, 'utf8'), contentType);
  if (!ok) throw new Error(`R2 upload failed: ${name}`);
  console.log(`  R2 OK: ${name}`);
}

async function loadIds(prefix) {
  const file = path.join(DATA_DIR, `${prefix}.jsonl`);
  const ids = new Set();
  if (!fs.existsSync(file)) return ids;
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)) {
    try { const { id } = JSON.parse(line); if (id) ids.add(id); } catch {}
  }
  return ids;
}

function writeSidecar(filePath, jobs) {
  if (!jobs || jobs.length === 0) return 0;
  const lines = jobs.filter(j => j.description).map(j =>
    JSON.stringify({ id: j.id, description_text: j.description })
  ).join('\n') + '\n';
  fs.writeFileSync(filePath, lines, 'utf8');
  return countJsonlLines(filePath);
}

/**
 * AGG-SLOW-LANE-1: Off-cycle supplemental lane for slow fetchers.
 * Google/Microsoft/Apple have 600-1200s timeouts — too slow for the 15-min main pipeline.
 * Runs independently every 2h, writes to R2, main pipeline consumes via loadSupplementalInputs().
 *
 * Fault isolation: allSettled + per-fetcher timeouts. If one fetcher is slow/fails,
 * others still complete and upload independently.
 */
async function main() {
  const start = Date.now();
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const googleSidecarPath = path.join(DATA_DIR, 'descriptions-google.jsonl');
  const microsoftSidecarPath = path.join(DATA_DIR, 'descriptions-microsoft.jsonl');
  const appleSidecarPath = path.join(DATA_DIR, 'descriptions-apple.jsonl');
  const bytedanceSidecarPath = path.join(DATA_DIR, 'descriptions-bytedance.jsonl');
  const googleCachedIds = await loadIds('descriptions-google');
  const microsoftCachedIds = await loadIds('descriptions-microsoft');
  const appleCachedIds = await loadIds('descriptions-apple');

  // allSettled + per-fetcher timeouts for fault + timeout isolation.
  // CRITICAL: clearTimeout after race settles — otherwise the pending timer keeps
  // the Node.js process alive long after the fetch completes (script hangs until
  // the longest timer fires). This was the root cause of all slow-lane timeouts.
  const withTimeout = (promise, ms, name) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms/1000}s`)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };

  console.log('Fetching supplemental lane: Google, Microsoft, Apple, ByteDance...');
  const [googleR, googleCaR, microsoftR, appleR, bytedanceR, amazonR] = await Promise.allSettled([
    withTimeout(fetchAllGoogleJobs({ cachedDescriptionIds: googleCachedIds, dataDir: DATA_DIR }), 600_000, 'Google'),
    withTimeout(fetchGoogleCanadaJobs({ cachedDescriptionIds: googleCachedIds, dataDir: DATA_DIR }), 300_000, 'Google Canada'),
    withTimeout(fetchAllMicrosoftJobs({ cachedDescriptionIds: microsoftCachedIds, fetchDetailsOnInitial: true }), 300_000, 'Microsoft'),
    withTimeout(fetchAllAppleJobs({ previousJobCount: 201, previousJobIds: new Set(['_placeholder']), cachedDescriptionIds: appleCachedIds, dataDir: DATA_DIR }), 300_000, 'Apple'),
    withTimeout(fetchAllByteDanceJobs(), 120_000, 'ByteDance'),
    withTimeout(fetchAllAmazonJobs(), 120_000, 'Amazon'),
  ]);

  const google = googleR.status === 'fulfilled' ? googleR.value : [];
  const googleCa = googleCaR.status === 'fulfilled' ? googleCaR.value : [];
  if (googleCa.length > 0) google.push(...googleCa);
  const microsoft = microsoftR.status === 'fulfilled' ? microsoftR.value : [];
  const apple = appleR.status === 'fulfilled' ? appleR.value : [];
  const bytedance = bytedanceR.status === 'fulfilled' ? bytedanceR.value : [];
  const amazon = amazonR.status === 'fulfilled' ? amazonR.value : [];
  if (googleR.status === 'rejected') console.log(`  ⚠️ Google: ${googleR.reason?.message || googleR.reason}`);
  if (googleCaR.status === 'rejected') console.log(`  ⚠️ Google Canada: ${googleCaR.reason?.message || googleCaR.reason}`);
  if (microsoftR.status === 'rejected') console.log(`  ⚠️ Microsoft: ${microsoftR.reason?.message || microsoftR.reason}`);
  if (appleR.status === 'rejected') console.log(`  ⚠️ Apple: ${appleR.reason?.message || appleR.reason}`);
  if (bytedanceR.status === 'rejected') console.log(`  ⚠️ ByteDance: ${bytedanceR.reason?.message || bytedanceR.reason}`);
  if (amazonR.status === 'rejected') console.log(`  ⚠️ Amazon: ${amazonR.reason?.message || amazonR.reason}`);

  const groups = { google, microsoft, apple, bytedance, amazon };
  const payload = Object.entries(groups).flatMap(([source, jobs]) =>
    jobs.map(job => ({
      id: job.id,
      title: job.title,
      company_name: job.company_name,
      source,
      location: job.location,
      url: job.url,
      posted_at: job.posted_at,
      description: job.description || null,
    }))
  );

  const bytedanceSidecarRows = writeSidecar(bytedanceSidecarPath, bytedance);

  const durationMs = Date.now() - start;
  const metadata = {
    schema: 'supplemental-lane-v1',
    generated_at: new Date().toISOString(),
    lane_name: 'custom',
    publish_contract: {
      blocks_fast_publish: false,
      included_in_main_all_jobs: false,
      merge_mode: 'separate_artifact',
      visibility: 'snapshot_only',
      expected_cadence_minutes: 120,
      max_staleness_minutes: 180,
    },
    source: 'custom',
    sources: Object.fromEntries(
      Object.entries({ google: google.length, microsoft: microsoft.length, apple: apple.length, bytedance: bytedance.length, amazon: amazon.length })
        .filter(([, count]) => count > 0)
    ),
    jobs_fetched: payload.length,
    duration_ms: durationMs,
  };

  fs.writeFileSync(JOBS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(META_FILE, JSON.stringify(metadata, null, 2), 'utf8');
  console.log(`Custom supplemental lane wrote ${payload.length} jobs in ${Math.round(durationMs/1000)}s`);
  console.log(`  Sources: google=${google.length}, microsoft=${microsoft.length}, apple=${apple.length}, bytedance=${bytedance.length}, amazon=${amazon.length}`);

  if (hasR2Env()) {
    try {
      const { createR2Client } = require(`${SHARED}/storage/r2-client`);
      const r2 = createR2Client({ prefix: 'data/' });
      await uploadRequired(r2, 'supplemental-custom-jobs.json', JOBS_FILE, 'application/json');
      await uploadRequired(r2, 'supplemental-custom-metadata.json', META_FILE, 'application/json');
      if (fs.existsSync(googleSidecarPath)) await uploadRequired(r2, 'descriptions-google.jsonl', googleSidecarPath, 'application/x-jsonlines');
      if (fs.existsSync(appleSidecarPath)) await uploadRequired(r2, 'descriptions-apple.jsonl', appleSidecarPath, 'application/x-jsonlines');
      if (fs.existsSync(microsoftSidecarPath)) await uploadRequired(r2, 'descriptions-microsoft.jsonl', microsoftSidecarPath, 'application/x-jsonlines');
      if (fs.existsSync(bytedanceSidecarPath)) await uploadRequired(r2, 'descriptions-bytedance.jsonl', bytedanceSidecarPath, 'application/x-jsonlines');
      console.log('Uploaded custom supplemental artifacts to R2');
    } catch (err) {
      if (isGitHubActions()) throw new Error(`R2 publish failed: ${err.message}`);
      console.log(`R2 upload unavailable locally — skipped (${err.message})`);
    }
  } else if (isGitHubActions()) {
    throw new Error('R2 env missing in GitHub Actions');
  }
}

if (require.main === module) {
  // AGG-SLOW-LANE-1: process.exit(0) is REQUIRED — HTTP keep-alive connections
  // and pending setTimeout timers from the fetchers keep the Node.js event loop
  // alive long after the work is done. Without this, the script hangs until the
  // longest timer fires (10+ min), causing every slow-lane workflow timeout.
  main().then(() => process.exit(0)).catch(err => {
    console.error('Supplemental custom lane failed:', err.message);
    process.exit(1);
  });
}

module.exports = { writeSidecar };
