#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
let SHARED = path.join(__dirname, 'aggregator', 'lib');
if (!fs.existsSync(SHARED)) {
  const siblingFallback = path.join(path.dirname(process.cwd()), 'job-board-aggregator', 'lib');
  if (fs.existsSync(siblingFallback)) SHARED = siblingFallback;
}

const { fetchAllGoogleJobs } = require(`${SHARED}/fetchers/google`);
const { fetchAllMicrosoftJobs } = require(`${SHARED}/fetchers/microsoft`);
const { fetchAllTiktokJobs } = require(`${SHARED}/fetchers/tiktok`);

const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const JOBS_FILE = path.join(DATA_DIR, 'supplemental-custom-jobs.json');
const META_FILE = path.join(DATA_DIR, 'supplemental-custom-metadata.json');

function countJsonlLines(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return 0;
    return raw.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function loadIds(prefix) {
  const ids = new Set();
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith(prefix) && f.endsWith('.jsonl'));
    for (const fname of files) {
      const lines = fs.readFileSync(path.join(DATA_DIR, fname), 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try { const { id } = JSON.parse(line); if (id) ids.add(id); } catch {}
      }
    }
  } catch {}
  return ids;
}

async function main() {
  const start = Date.now();
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const googleSidecarPath = path.join(DATA_DIR, 'descriptions-google.jsonl');
  const microsoftSidecarPath = path.join(DATA_DIR, 'descriptions-microsoft.jsonl');
  const googleCachedIds = await loadIds('descriptions-google');
  const microsoftCachedIds = await loadIds('descriptions-microsoft');
  const googleCacheBefore = countJsonlLines(googleSidecarPath);
  const microsoftCacheBefore = countJsonlLines(microsoftSidecarPath);

  const [google, microsoft, tiktok] = await Promise.all([
    fetchAllGoogleJobs({ cachedDescriptionIds: googleCachedIds, dataDir: DATA_DIR }),
    fetchAllMicrosoftJobs({ cachedDescriptionIds: microsoftCachedIds }),
    fetchAllTiktokJobs(),
  ]);

  const groups = { google, microsoft, tiktok };
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
      expected_cadence_minutes: 15,
      max_staleness_minutes: 90,
    },
    source: 'custom',
    sources: {
      google: google.length,
      microsoft: microsoft.length,
      tiktok: tiktok.length,
    },
    jobs_fetched: payload.length,
    duration_ms: durationMs,
    cache_state: {
      google_ids_before: googleCachedIds.size,
      google_lines_before: googleCacheBefore,
      google_lines_after: googleCacheAfter,
      microsoft_ids_before: microsoftCachedIds.size,
      microsoft_lines_before: microsoftCacheBefore,
      microsoft_lines_after: microsoftCacheAfter,
    },
  };

  fs.writeFileSync(JOBS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(META_FILE, JSON.stringify(metadata, null, 2), 'utf8');
  console.log(`✅ Custom supplemental lane wrote ${payload.length} jobs in ${Math.round(durationMs/1000)}s`);

  if (process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT && process.env.R2_BUCKET_NAME) {
    try {
      const { createR2Client } = require(`${SHARED}/storage/r2-client`);
      const r2 = createR2Client({ prefix: 'data/' });
      await r2.uploadRaw('supplemental-custom-jobs.json', fs.readFileSync(JOBS_FILE, 'utf8'), 'application/json');
      await r2.uploadRaw('supplemental-custom-metadata.json', fs.readFileSync(META_FILE, 'utf8'), 'application/json');
      const googleSidecar = path.join(DATA_DIR, 'descriptions-google.jsonl');
      if (fs.existsSync(googleSidecar)) {
        await r2.uploadRaw('descriptions-google.jsonl', fs.readFileSync(googleSidecar, 'utf8'), 'application/x-jsonlines');
      }
      console.log('☁️ Uploaded custom supplemental artifacts to R2');
    } catch (err) {
      console.log(`⚠️ R2 upload unavailable locally — skipped (${err.message})`);
    }
  } else {
    console.log('⚠️ R2 env missing — skipped R2 upload');
  }
}

main().catch(err => {
  console.error('❌ Supplemental custom lane failed:', err.message);
  process.exit(1);
});
