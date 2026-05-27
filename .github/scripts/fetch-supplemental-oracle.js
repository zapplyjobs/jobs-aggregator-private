#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
let SHARED = path.join(__dirname, 'aggregator', 'lib');
if (!fs.existsSync(SHARED)) {
  const siblingFallback = path.join(path.dirname(process.cwd()), 'job-board-aggregator', 'lib');
  if (fs.existsSync(siblingFallback)) SHARED = siblingFallback;
}
const { fetchAllOracleJobs } = require(`${SHARED}/fetchers/oracle`);

const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const COMPANY_LIST_PATH = path.join(SHARED, 'fetchers', 'company-list.json');
const JOBS_FILE = path.join(DATA_DIR, 'supplemental-oracle-jobs.json');
const META_FILE = path.join(DATA_DIR, 'supplemental-oracle-metadata.json');

async function main() {
  const start = Date.now();
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const companyList = JSON.parse(fs.readFileSync(COMPANY_LIST_PATH, 'utf8'));
  const oracleCompanies = companyList.oracle || [];

  console.log(`🏛️ Supplemental Oracle lane: ${oracleCompanies.length} companies configured`);
  const jobs = await fetchAllOracleJobs(oracleCompanies);
  const durationMs = Date.now() - start;

  const payload = jobs.map(job => ({
    id: job.id,
    title: job.title,
    company_name: job.company_name,
    source: job.source,
    location: job.location,
    url: job.url,
    posted_at: job.posted_at,
    description: job.description || null,
  }));

  const metadata = {
    schema: 'supplemental-lane-v1',
    generated_at: new Date().toISOString(),
    lane_name: 'oracle',
    publish_contract: {
      blocks_fast_publish: false,
      included_in_main_all_jobs: false,
      merge_mode: 'separate_artifact',
      visibility: 'snapshot_only',
    },
    source: 'oracle',
    companies_configured: oracleCompanies.length,
    jobs_fetched: payload.length,
    duration_ms: durationMs,
  };

  fs.writeFileSync(JOBS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(META_FILE, JSON.stringify(metadata, null, 2), 'utf8');

  console.log(`✅ Oracle supplemental lane wrote ${payload.length} jobs in ${Math.round(durationMs/1000)}s`);

  if (process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT && process.env.R2_BUCKET_NAME) {
    try {
      const { createR2Client } = require(`${SHARED}/storage/r2-client`);
      const r2 = createR2Client({ prefix: 'data/' });
      await r2.uploadRaw('supplemental-oracle-jobs.json', fs.readFileSync(JOBS_FILE, 'utf8'), 'application/json');
      await r2.uploadRaw('supplemental-oracle-metadata.json', fs.readFileSync(META_FILE, 'utf8'), 'application/json');
      console.log('☁️ Uploaded Oracle supplemental artifacts to R2');
    } catch (err) {
      console.log(`⚠️ R2 upload unavailable locally — skipped (${err.message})`);
    }
  } else {
    console.log('⚠️ R2 env missing — skipped R2 upload');
  }
}

main().catch(err => {
  console.error('❌ Supplemental Oracle lane failed:', err.message);
  process.exit(1);
});
