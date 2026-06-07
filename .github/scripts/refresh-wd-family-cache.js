#!/usr/bin/env node

/**
 * Refresh Workday family cache outside the hot publish path.
 *
 * Main fetch uses wd-family-cache.json to annotate Workday departments before TAG
 * decisions. The cache refresh is intentionally separate from output production:
 * fresh all_jobs.json can publish first, then this script refreshes the cache for
 * the next run.
 */

const fs = require('fs');
const path = require('path');

const SHARED = path.join(__dirname, 'aggregator', 'lib');
const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const COMPANY_LIST_PATH = path.join(SHARED, 'fetchers', 'company-list.json');
const CACHE_FILE = path.join(DATA_DIR, 'wd-family-cache.json');
const DEFAULT_MAX_DURATION_MS = 120000;
const TENANT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const { buildFamilyCache } = require(`${SHARED}/fetchers/workday`);

function parseMaxDurationMs() {
  const raw = process.env.WD_FAMILY_CACHE_MAX_MS;
  if (!raw) return DEFAULT_MAX_DURATION_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid WD_FAMILY_CACHE_MAX_MS: ${raw}`);
  }
  return value;
}


function readExistingCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

const TECH_DOMAINS = new Set(['software', 'data_science', 'hardware', 'cybersecurity', 'ai', 'devops', 'product', 'design', 'qa', 'it']);

function isTechUs(job) {
  return Array.isArray(job.tags?.locations)
    && job.tags.locations.includes('us')
    && Array.isArray(job.tags?.domains)
    && job.tags.domains.some(domain => TECH_DOMAINS.has(domain));
}

function readJobsFile(jobsPath) {
  let text = '';
  try {
    text = fs.readFileSync(jobsPath, 'utf8');
  } catch {
    return [];
  }

  try {
    const jobs = JSON.parse(text);
    if (Array.isArray(jobs)) return jobs;
    if (Array.isArray(jobs.jobs)) return jobs.jobs;
  } catch {}

  const records = [];
  for (const line of text.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {}
  }
  return records;
}
function readCurrentJobs() {
  return readJobsFile(path.join(DATA_DIR, 'all_jobs.json'));
}

async function loadCurrentJobs(r2) {
  const localJobs = readCurrentJobs();
  if (localJobs.length > 0) return localJobs;

  const fallbackPath = path.join(DATA_DIR, 'all_jobs.priority.json');
  try {
    const result = await r2.downloadToFile('all_jobs.json', fallbackPath);
    if (result) return readJobsFile(fallbackPath);
  } catch (error) {
    console.warn(`Could not load all_jobs.json for WD cache priority scoring: ${error.message}`);
  }

  return [];
}

function getTenantPriorityScores(cache, jobs = readCurrentJobs()) {
  const scores = {};
  const stats = {};

  for (const job of jobs) {
    if (job.source !== 'workday' || !job.company_name) continue;

    const row = stats[job.company_name] || {
      total: 0,
      techUs: 0,
      noCacheRows: 0,
      noCacheTechUs: 0,
      pathNoHit: 0,
      techPathNoHit: 0,
    };

    row.total += 1;
    const techUs = isTechUs(job);
    if (techUs) row.techUs += 1;

    const cached = cache?.tenants?.[job.company_name];
    if (!cached || !cached.pathMap || typeof cached.pathMap !== 'object') {
      row.noCacheRows += 1;
      if (techUs) row.noCacheTechUs += 1;
    } else if (job.wd_path && !cached.pathMap[job.wd_path]) {
      row.pathNoHit += 1;
      if (techUs) row.techPathNoHit += 1;
    }

    stats[job.company_name] = row;
  }

  for (const [name, row] of Object.entries(stats)) {
    scores[name] = (row.noCacheTechUs + row.techPathNoHit) * 10000
      + (row.noCacheRows + row.pathNoHit) * 100
      + row.techUs * 10
      + row.total;
  }

  return { scores, stats };
}

function getTenantCacheStatus(cache, tenants, now = Date.now(), maxAgeMs = TENANT_REFRESH_INTERVAL_MS) {
  if (!cache || !cache.tenants || typeof cache.tenants !== 'object') {
    return {
      fresh: false,
      tenantCount: tenants.length,
      cacheTenantCount: 0,
      missing: tenants.map(t => t.name),
      stale: [],
      invalid: [],
    };
  }

  const missing = [];
  const stale = [];
  const invalid = [];

  for (const tenant of tenants) {
    const cached = cache.tenants[tenant.name];
    if (!cached || !cached.pathMap || typeof cached.pathMap !== 'object') {
      missing.push(tenant.name);
      continue;
    }

    const fetchedAt = cached.fetched_at ? new Date(cached.fetched_at).getTime() : NaN;
    if (!Number.isFinite(fetchedAt)) {
      invalid.push(tenant.name);
      continue;
    }

    if (now - fetchedAt >= maxAgeMs) {
      stale.push(tenant.name);
    }
  }

  return {
    fresh: missing.length === 0 && stale.length === 0 && invalid.length === 0,
    tenantCount: tenants.length,
    cacheTenantCount: Object.keys(cache.tenants).length,
    missing,
    stale,
    invalid,
  };
}

function loadWorkdayTenants() {
  const companyList = JSON.parse(fs.readFileSync(COMPANY_LIST_PATH, 'utf8'));
  const tenants = companyList.workday;
  if (!Array.isArray(tenants) || tenants.length === 0) {
    throw new Error('company-list.json has no Workday tenants');
  }
  return tenants;
}

async function seedExistingCache(r2) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const result = await r2.downloadToFile('wd-family-cache.json', CACHE_FILE);
    if (result) {
      console.log(`Seeded existing wd-family-cache.json from R2 (${Math.round(result.size / 1024)} KB)`);
      return true;
    }
  } catch (error) {
    console.warn(`Could not seed existing WD family cache from R2: ${error.message}`);
  }
  console.warn('No existing WD family cache seeded; rebuilding from local state only');
  return false;
}

async function uploadCache(r2) {
  const raw = fs.readFileSync(CACHE_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  const tenantCount = Object.keys(parsed.tenants || {}).length;
  if (tenantCount === 0) {
    throw new Error('Refusing to upload empty wd-family-cache.json');
  }
  const uploaded = await r2.uploadRaw('wd-family-cache.json', raw, 'application/json');
  if (!uploaded) {
    throw new Error('R2 uploadRaw returned false for wd-family-cache.json');
  }
  console.log(`Uploaded wd-family-cache.json to R2 (${tenantCount} tenants)`);
}

async function main() {
  const maxDurationMs = parseMaxDurationMs();
  const tenants = loadWorkdayTenants();
  const { createR2Client } = require(`${SHARED}/storage/r2-client`);
  const r2 = createR2Client({ prefix: 'data/' });

  await seedExistingCache(r2);

  const cache = readExistingCache();
  const status = getTenantCacheStatus(cache, tenants);
  if (status.fresh) {
    console.log(`WD family cache tenant entries fresh (${status.tenantCount} tenants, refresh interval: ${(TENANT_REFRESH_INTERVAL_MS / 3600000).toFixed(0)}h); skipping refresh`);
    return;
  }

  const dueNames = new Set([...status.missing, ...status.stale, ...status.invalid]);
  const tenantsToRefresh = tenants.filter(t => dueNames.has(t.name));
  const currentJobs = await loadCurrentJobs(r2);
  const { scores: tenantPriorityScores, stats: tenantPriorityStats } = getTenantPriorityScores(cache, currentJobs);
  const scoredDueTenants = tenantsToRefresh
    .map(tenant => ({
      name: tenant.name,
      score: tenantPriorityScores[tenant.name] || 0,
      stats: tenantPriorityStats[tenant.name] || null,
    }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8);

  console.log(`WD family cache refresh needed: ${status.missing.length} missing, ${status.stale.length} stale, ${status.invalid.length} invalid tenant entries (${status.cacheTenantCount}/${status.tenantCount} cached); refreshing ${tenantsToRefresh.length} due tenants`);
  console.log(`WD family cache priority input: ${currentJobs.length} current jobs, ${scoredDueTenants.length} due tenants with live headroom scores`);
  if (scoredDueTenants.length > 0) {
    console.log(`WD family cache priority tenants: ${scoredDueTenants.map(row => `${row.name}:${row.score}`).join(', ')}`);
  }
  const report = await buildFamilyCache(tenantsToRefresh, DATA_DIR, { maxDurationMs, tenantPriorityScores });
  if (!fs.existsSync(CACHE_FILE)) {
    throw new Error('buildFamilyCache did not write wd-family-cache.json');
  }
  await uploadCache(r2);

  console.log(JSON.stringify({
    refreshed_at: new Date().toISOString(),
    max_duration_ms: maxDurationMs,
    tenant_refresh_interval_hours: TENANT_REFRESH_INTERVAL_MS / 3600000,
    report,
  }));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`WD family cache refresh failed: ${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = {
  getTenantCacheStatus,
  getTenantPriorityScores,
  isTechUs,
};