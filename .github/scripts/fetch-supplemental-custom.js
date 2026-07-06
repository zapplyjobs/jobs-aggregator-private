#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
let SHARED = path.join(__dirname, 'aggregator', 'lib');
if (!fs.existsSync(SHARED)) {
  SHARED = path.join(__dirname, '..', 'aggregator', 'lib');
}

const { fetchAllByteDanceJobs } = require(`${SHARED}/fetchers/bytedance`);

const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const JOBS_FILE = path.join(DATA_DIR, 'supplemental-custom-jobs.json');
const META_FILE = path.join(DATA_DIR, 'supplemental-custom-metadata.json');

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

function writeSidecar(filePath, jobs) {
  if (!jobs || jobs.length === 0) return 0;
  const lines = jobs.filter(j => j.description).map(j =>
    JSON.stringify({ id: j.id, description_text: j.description })
  ).join('\n') + '\n';
  fs.writeFileSync(filePath, lines, 'utf8');
  return lines.trim().split('\n').filter(Boolean).length;
}

/**
 * AGG-SLOW-LANE-1: Supplemental lane for off-cycle fetchers.
 * Currently ByteDance only (fast, ~2 min). Google/Microsoft/Apple removed —
 * their fetchers take 10-20 min each and block the lane. Will be re-added
 * when their enrichment is made concurrent or a separate enrichment workflow exists.
 */
async function main() {
  const start = Date.now();
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const bytedanceSidecarPath = path.join(DATA_DIR, 'descriptions-bytedance.jsonl');

  console.log('Fetching supplemental lane: ByteDance...');
  const bytedance = await fetchAllByteDanceJobs();
  console.log(`  ByteDance: ${bytedance.length} jobs`);

  const payload = bytedance.map(job => ({
    id: job.id,
    title: job.title,
    company_name: job.company_name,
    source: 'bytedance',
    location: job.location,
    url: job.url,
    posted_at: job.posted_at,
    description: job.description || null,
  }));

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
    sources: { bytedance: bytedance.length },
    jobs_fetched: payload.length,
    duration_ms: durationMs,
    cache_state: { bytedance_lines_after: bytedanceSidecarRows },
  };

  fs.writeFileSync(JOBS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(META_FILE, JSON.stringify(metadata, null, 2), 'utf8');
  console.log(`Custom supplemental lane wrote ${payload.length} jobs in ${Math.round(durationMs/1000)}s`);

  if (hasR2Env()) {
    try {
      const { createR2Client } = require(`${SHARED}/storage/r2-client`);
      const r2 = createR2Client({ prefix: 'data/' });
      await uploadRequired(r2, 'supplemental-custom-jobs.json', JOBS_FILE, 'application/json');
      await uploadRequired(r2, 'supplemental-custom-metadata.json', META_FILE, 'application/json');
      if (fs.existsSync(bytedanceSidecarPath)) {
        await uploadRequired(r2, 'descriptions-bytedance.jsonl', bytedanceSidecarPath, 'application/x-jsonlines');
      }
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
  main().catch(err => {
    console.error('Supplemental custom lane failed:', err.message);
    process.exit(1);
  });
}

module.exports = { writeSidecar };
