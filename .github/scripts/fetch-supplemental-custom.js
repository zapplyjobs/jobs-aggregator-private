#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
let SHARED = path.join(__dirname, 'aggregator', 'lib');
if (!fs.existsSync(SHARED)) {
  // Try submodule path
  SHARED = path.join(__dirname, '..', 'aggregator', 'lib');
}

const { fetchAllGoogleJobs } = require(`${SHARED}/fetchers/google`);
const { fetchAllMicrosoftJobs } = require(`${SHARED}/fetchers/microsoft`);
const { fetchAllAppleJobs } = require(`${SHARED}/fetchers/apple`);
const { fetchAllByteDanceJobs } = require(`${SHARED}/fetchers/bytedance`);

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
  console.log(`  ☁️ ${name} → R2 OK`);
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
 * AGG-SLOW-LANE-1: Off-cycle supplemental lane for slow fetchers (Apple, Google, Microsoft).
 * These fetchers have 600-1200s timeouts — too slow for the 15-min main pipeline.
 * This script runs independently (every 2h), writes to R2, main pipeline consumes via
 * loadSupplementalInputs(). ByteDance included (not in main pipeline Phase B batch).
 * TikTok removed (re-enabled in main pipeline — 120s timeout is hot-path safe).
 * iCIMS removed (returns 0 from CI — PoC needs debugging).
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
  const googleCacheBefore = countJsonlLines(googleSidecarPath);
  const microsoftCacheBefore = countJsonlLines(microsoftSidecarPath);
  const appleCacheBefore = countJsonlLines(appleSidecarPath);

  // AGG-SLOW-LANE-1: Use allSettled (not Promise.all) so one slow/failed fetcher
  // doesn't block the others. Each source writes independently — if Apple times out,
  // Google/Microsoft/ByteDance still complete and upload.
  console.log('Fetching slow lane: Google, Microsoft, Apple, ByteDance...');
  const [googleR, microsoftR, appleR, bytedanceR] = await Promise.allSettled([
    fetchAllGoogleJobs({ cachedDescriptionIds: googleCachedIds, dataDir: DATA_DIR }),
    fetchAllMicrosoftJobs({ cachedDescriptionIds: microsoftCachedIds, fetchDetailsOnInitial: true }),
    fetchAllAppleJobs({ previousJobCount: 0, previousJobIds: new Set(), cachedDescriptionIds: appleCachedIds, dataDir: DATA_DIR }),
    fetchAllByteDanceJobs(),
  ]);
  const google = googleR.status === 'fulfilled' ? googleR.value : [];
  const microsoft = microsoftR.status === 'fulfilled' ? microsoftR.value : [];
  const apple = appleR.status === 'fulfilled' ? appleR.value : [];
  const bytedance = bytedanceR.status === 'fulfilled' ? bytedanceR.value : [];
  if (googleR.status === 'rejected') console.log(`  ⚠️ Google failed: ${googleR.reason?.message || googleR.reason}`);
  if (microsoftR.status === 'rejected') console.log(`  ⚠️ Microsoft failed: ${microsoftR.reason?.message || microsoftR.reason}`);
  if (appleR.status === 'rejected') console.log(`  ⚠️ Apple failed: ${appleR.reason?.message || appleR.reason}`);
  if (bytedanceR.status === 'rejected') console.log(`  ⚠️ ByteDance failed: ${bytedanceR.reason?.message || bytedanceR.reason}`);

  const groups = { google, microsoft, apple, bytedance };
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

  const googleCacheAfter = countJsonlLines(googleSidecarPath);
  const microsoftCacheAfter = countJsonlLines(microsoftSidecarPath);
  const appleCacheAfter = countJsonlLines(appleSidecarPath);
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
      Object.entries({ google: google.length, microsoft: microsoft.length, apple: apple.length, bytedance: bytedance.length })
        .filter(([, count]) => count > 0)
    ),
    jobs_fetched: payload.length,
    duration_ms: durationMs,
    cache_state: {
      google_ids_before: googleCachedIds.size,
      google_lines_before: googleCacheBefore,
      google_lines_after: googleCacheAfter,
      microsoft_ids_before: microsoftCachedIds.size,
      microsoft_lines_before: microsoftCacheBefore,
      microsoft_lines_after: microsoftCacheAfter,
      apple_ids_before: appleCachedIds.size,
      apple_lines_before: appleCacheBefore,
      apple_lines_after: appleCacheAfter,
      bytedance_lines_after: bytedanceSidecarRows,
    },
  };

  fs.writeFileSync(JOBS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(META_FILE, JSON.stringify(metadata, null, 2), 'utf8');
  console.log(`✅ Custom supplemental lane wrote ${payload.length} jobs in ${Math.round(durationMs/1000)}s`);
  console.log(`  Sources: google=${google.length}, microsoft=${microsoft.length}, apple=${apple.length}, bytedance=${bytedance.length}`);

  if (hasR2Env()) {
    try {
      const { createR2Client } = require(`${SHARED}/storage/r2-client`);
      const r2 = createR2Client({ prefix: 'data/' });
      await uploadRequired(r2, 'supplemental-custom-jobs.json', JOBS_FILE, 'application/json');
      await uploadRequired(r2, 'supplemental-custom-metadata.json', META_FILE, 'application/json');
      if (fs.existsSync(googleSidecarPath)) {
        await uploadRequired(r2, 'descriptions-google.jsonl', googleSidecarPath, 'application/x-jsonlines');
      }
      if (fs.existsSync(appleSidecarPath)) {
        await uploadRequired(r2, 'descriptions-apple.jsonl', appleSidecarPath, 'application/x-jsonlines');
      }
      if (fs.existsSync(microsoftSidecarPath)) {
        await uploadRequired(r2, 'descriptions-microsoft.jsonl', microsoftSidecarPath, 'application/x-jsonlines');
      }
      if (fs.existsSync(bytedanceSidecarPath)) {
        await uploadRequired(r2, 'descriptions-bytedance.jsonl', bytedanceSidecarPath, 'application/x-jsonlines');
      }
      console.log('☁️ Uploaded custom supplemental artifacts to R2');
    } catch (err) {
      if (isGitHubActions()) {
        throw new Error(`Custom supplemental R2 publish failed: ${err.message}`);
      }
      console.log(`⚠️ R2 upload unavailable locally — skipped (${err.message})`);
    }
  } else if (isGitHubActions()) {
    throw new Error('R2 env missing in GitHub Actions; refusing to mark custom supplemental publish successful');
  } else {
    console.log('⚠️ R2 env missing — skipped R2 upload (local mode)');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('❌ Supplemental custom lane failed:', err.message);
    process.exit(1);
  });
}

module.exports = { writeSidecar };
