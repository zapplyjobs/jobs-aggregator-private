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
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

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

function getTenantCacheStatus(cache, tenants, now = Date.now()) {
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

    if (now - fetchedAt >= CACHE_TTL_MS) {
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
    console.log(`WD family cache tenant entries fresh (${status.tenantCount} tenants, TTL: ${(CACHE_TTL_MS / 3600000).toFixed(0)}h); skipping refresh`);
    return;
  }

  console.log(`WD family cache refresh needed: ${status.missing.length} missing, ${status.stale.length} stale, ${status.invalid.length} invalid tenant entries (${status.cacheTenantCount}/${status.tenantCount} cached)`);
  const report = await buildFamilyCache(tenants, DATA_DIR, { maxDurationMs });
  if (!fs.existsSync(CACHE_FILE)) {
    throw new Error('buildFamilyCache did not write wd-family-cache.json');
  }
  await uploadCache(r2);

  console.log(JSON.stringify({
    refreshed_at: new Date().toISOString(),
    max_duration_ms: maxDurationMs,
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
};
