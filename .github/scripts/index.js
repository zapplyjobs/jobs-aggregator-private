#!/usr/bin/env node

/**
 * Main Orchestrator - Jobs Data Fetcher
 *
 * Coordinates all fetchers, normalizes jobs, deduplicates,
 * and writes the shared output file.
 *
 * Usage:
 *   node index.js                    # Normal run
 *   node index.js --dry-run          # Dry run (no git commit)
 *   node index.js --verbose          # Verbose logging
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Import from aggregator submodule (job-board-aggregator/lib/)
const SHARED = path.join(__dirname, 'aggregator', 'lib');

// Import fetchers
const { fetchFromAllATS, getUsageStats: getATSUsageStats } = require(`${SHARED}/fetchers/ats-fetcher`);
const { fetchAllAmazonJobs } = require(`${SHARED}/fetchers/amazon`);
const { fetchAllNetflixJobs } = require(`${SHARED}/fetchers/netflix`);
// AGG-HOTPATH-1: WD descriptions are no longer fetched in the hot publish path.
const { fetchAllAppleJobs } = require(`${SHARED}/fetchers/apple`);
const { fetchAllTwoSigmaJobs } = require(`${SHARED}/fetchers/twosigma`);
const { fetchAllUberJobs } = require(`${SHARED}/fetchers/uber`);
const { fetchAllGoogleJobs } = require(`${SHARED}/fetchers/google`);
// AGG-SIMPLIFY-EXIT-1 (2026-07-06): simplify fetcher REMOVED. Source retired.
// Fetcher files kept in submodule for reference but no longer called.
const { fetchAllIcimsJobs } = require(`${SHARED}/fetchers/icims`);
const { fetchAllMicrosoftJobs } = require(`${SHARED}/fetchers/microsoft`);
const { fetchAllOracleJobs } = require(`${SHARED}/fetchers/oracle`);
const { fetchAllAmdJobs } = require(`${SHARED}/fetchers/amd`);
const { fetchAllTiktokJobs } = require(`${SHARED}/fetchers/tiktok`);
const { fetchAllDeshawJobs } = require(`${SHARED}/fetchers/deshaw`);
const { applyFamilyCache, buildFamilyCache } = require(`${SHARED}/fetchers/workday`);
const { fetchSRDescriptions } = require(`${SHARED}/fetchers/smartrecruiters-descriptions`);
const { fetchWorkdayDescriptions } = require(`${SHARED}/fetchers/workday-descriptions`);
const { fromDescription } = require(`${SHARED}/fetchers/salary`);


// Import processors
const { validateAndNormalizeJobs, printValidationSummary, normalizeJob } = require(`${SHARED}/processors/validator`);
const { filterSeniorJobs, printSeniorFilterSummary, isSeniorJob, buildCompanyOverrideMap } = require(`${SHARED}/processors/senior-filter`);
const { deduplicateJobs, DEDUPE_TTL_MS, DEDUPE_TTL_DAYS, INTERNSHIP_TTL_MS } = require(`${SHARED}/processors/deduplicator`);
const { tagJobs, generateTagStats, tagEmployment, tagDomains, tagLocations, setCompanyOverrideMap, TAG_ENGINE_VERSION, getKeywordMap } = require(`${SHARED}/processors/tag-engine`);
const { printTagDistribution, checkTagDrift, printDriftReport, checkDomainPrecision, printPrecisionReport, checkKeywordHealth, checkKeywordOverlap } = require(`${SHARED}/processors/tag-monitor`);

const SKIP_WD_FAMILY_CACHE_BUILD = process.env.SKIP_WD_FAMILY_CACHE_BUILD === '1';
// Import utils
const { writeJobsJSONL, writeMetadata } = require(`${SHARED}/utils/file-writer`);
const { EMPLOYMENT_NORMALIZE_MAP } = require(`${SHARED}/utils/helpers`);
const { writeSidecars } = require(`${SHARED}/utils/sidecar-writer`);
const { runTagMonitoring } = require(`${SHARED}/utils/monitoring`);

// AGG-36: Company override map (populated by loadCompanyOverrides)
const COMPANY_LIST_PATH = path.join(SHARED, 'fetchers', 'company-list.json');
let companyOverrideMap = new Map();

function loadCompanyOverrides() {
  try {
    const companyList = JSON.parse(fs.readFileSync(COMPANY_LIST_PATH, 'utf8'));
    companyOverrideMap = buildCompanyOverrideMap(companyList);
    if (companyOverrideMap.size > 0) {
      console.log(`📋 AGG-36: Loaded ${companyOverrideMap.size} company title overrides`);
      setCompanyOverrideMap(companyOverrideMap);
    }
  } catch (e) {
    console.warn(`⚠️ AGG-36: Could not load company overrides: ${e.message}`);
  }
}
loadCompanyOverrides();

// Paths
const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const JOBS_OUTPUT_FILE = path.join(DATA_DIR, 'all_jobs.json');
const US_JOBS_OUTPUT_FILE = path.join(DATA_DIR, 'us_jobs.json');
const MID_LEVEL_TECH_FILE = path.join(DATA_DIR, 'mid-level-tech-jobs.jsonl');
const MID_LEVEL_TECH_SUMMARY_FILE = path.join(DATA_DIR, 'mid-level-tech-summary.json');
const SENIOR_TECH_FILE = path.join(DATA_DIR, 'senior-tech-jobs.jsonl');
const SENIOR_TECH_SUMMARY_FILE = path.join(DATA_DIR, 'senior-tech-summary.json');
const METADATA_OUTPUT_FILE = path.join(DATA_DIR, 'jobs-metadata.json');

// Command line args
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isVerbose = args.includes('--verbose');

// --- Extracted invariants (AGG-PIPE-6) ---
// Each function wraps a pipeline invariant that was previously inline in main().
// Named functions make accidental removal structurally harder.

function appendAll(target, items) {
  if (!Array.isArray(items) || items.length === 0) return;
  for (const item of items) target.push(item);
}

function isUsSnapshotJob(job) {
  return job?.tags?.locations?.includes('us') === true;
}
function injectDescriptions(jobs, descriptionMap, source) {
  let injected = 0;
  for (const job of jobs) {
    if (job.description) continue;
    const text = descriptionMap.get(job.id);
    if (!text) continue;
    job.description = text;
    injected++;
  }
  if (injected > 0) {
    console.log(`📄 ${source} descriptions: injected ${injected} descriptions into current jobs`);
  }
  return injected;
}


function buildUsSnapshotJobs(jobs) {
  return jobs.filter(isUsSnapshotJob);
}

// INF-FEED-1: mid-level tech shadow feed (additive lane artifact; no source mutation, no consumer yet).
// Spec: research/INF_FEED_1_MID_LEVEL_TECH_FEED_SPEC_2026_06_07.md. Consumer adoption blocked until
// TAG/AGG reviews quality-flagged rows; this artifact only measures/publishes supply.
const MID_LEVEL_TECH_DOMAINS = ['software', 'data_science', 'hardware', 'ai'];
function isMidLevelTechJob(job) {
  const emp = job?.tags?.employment;
  const doms = Array.isArray(job?.tags?.domains) ? job.tags.domains : [];
  return emp === 'mid_level' && doms.some(d => MID_LEVEL_TECH_DOMAINS.includes(d));
}
function buildMidLevelTechFeed(jobs) {
  return jobs.filter(isMidLevelTechJob);
}
function buildMidLevelTechSummary(feed, sourceTotal) {
  const countsByDomain = {};
  for (const d of MID_LEVEL_TECH_DOMAINS) countsByDomain[d] = 0;
  const locCounts = { US: 0, non_US: 0, missing: 0 };
  const q = { missing_location: 0, title_contains_senior: 0, title_contains_manager: 0,
              title_contains_facilities: 0, title_contains_sales: 0, title_contains_principal_or_staff: 0 };
  for (const j of feed) {
    for (const d of (j.tags?.domains || [])) if (d in countsByDomain) countsByDomain[d]++;
    const locs = Array.isArray(j.tags?.locations) ? j.tags.locations : [];
    if (locs.length === 0) { locCounts.missing++; q.missing_location++; }
    else if (locs.includes('us')) locCounts.US++;
    else locCounts.non_US++;
    const t = String(j.title || '').toLowerCase();
    if (t.includes('senior')) q.title_contains_senior++;
    if (t.includes('manager')) q.title_contains_manager++;
    if (t.includes('facilities')) q.title_contains_facilities++;
    if (t.includes('sales')) q.title_contains_sales++;
    if (t.includes('principal') || t.includes('staff')) q.title_contains_principal_or_staff++;
  }
  return {
    contract_version: 1, generated_at: new Date().toISOString(),
    source_artifact: 'data/all_jobs.json', source_total: sourceTotal,
    feed_total: feed.length, employment_required: 'mid_level',
    tech_domains: MID_LEVEL_TECH_DOMAINS, counts_by_domain: countsByDomain,
    counts_by_location: locCounts, quality_flags: q, shadow: true,
    consumer_adoption_blocked_reason: 'TAG/AGG classification review pending for quality-flagged rows',
  };
}

// AGG-SEN-FILTERKNOB-1: senior-tech shadow feed (additive; mirrors INF-FEED-1).
// Sources from the Step-4 seniorJobs partition (the jobs senior-filter drops before pooling),
// NOT from publicJobs — senior jobs are absent from the final pool by design. This surfaces the
// dropped senior tech supply as a queryable feed so INF/OUT can build a senior surface later.
// No source mutation: the main pool (all_jobs) is untouched; senior jobs remain filtered from
// the entry-level/new-grad pool. Shadow artifact — measures/publishes supply only (no consumer yet).
const SENIOR_TECH_DOMAINS = ['software', 'data_science', 'hardware', 'ai'];
function isSeniorTechJob(job) {
  // Seniority is defined by membership in the senior-filter partition (Step 4), not by the
  // employment tag — so we filter by tech domain only (the tag-engine and the senior filter
  // are independent classifiers; employment is reported in the summary, not required here).
  const doms = Array.isArray(job?.tags?.domains) ? job.tags.domains : [];
  return doms.some(d => SENIOR_TECH_DOMAINS.includes(d));
}
function buildSeniorTechFeed(taggedSeniorJobs) {
  // AGG-SEN-RAWTRIM: match all_jobs's STRIP_FIELDS (defined ~line 1127) so this feed is as lean
  // as the main pool. The dominant bloat is `description` (~5 KB/job, ~150 MB total) — it lives
  // in sidecars (descriptions-*.jsonl) fetched on-demand by detail views; this feed is a
  // list/index pool for OUT's paginated senior board (id/title/company/location/tags/posted_at/url).
  return taggedSeniorJobs.filter(isSeniorTechJob).map(stripFeedInternal);
}
// Same fields all_jobs strips (STRIP_FIELDS ~line 1127) + any internal underscore-prefixed field.
// NOTE: an earlier revision only stripped `_*` fields (wrongly assumed _raw was the bloat) — the
// feed stayed ~151 MB. Verified the real bloat is `description`; now matches all_jobs leanness.
const SENIOR_FEED_STRIP = ['source_url', '_raw', 'description', 'enriched', 'enriched_at', 'is_internship', 'is_new_grad', 'is_us_only', 'remote'];
function stripFeedInternal(job) {
  if (!job) return job;
  const out = {};
  for (const [k, v] of Object.entries(job)) {
    if (k.startsWith('_')) continue;             // _filter_reason, future internal fields
    if (SENIOR_FEED_STRIP.includes(k)) continue; // match all_jobs STRIP_FIELDS (incl. description)
    out[k] = v;
  }
  return out;
}
function buildSeniorTechSummary(feed, seniorTotal) {
  const countsByDomain = {};
  for (const d of SENIOR_TECH_DOMAINS) countsByDomain[d] = 0;
  const locCounts = { US: 0, non_US: 0, missing: 0 };
  const empCounts = { senior: 0, mid_level: 0, entry_level: 0, other: 0, missing: 0 };
  for (const j of feed) {
    for (const d of (j.tags?.domains || [])) if (d in countsByDomain) countsByDomain[d]++;
    const locs = Array.isArray(j.tags?.locations) ? j.tags.locations : [];
    if (locs.length === 0) locCounts.missing++;
    else if (locs.includes('us')) locCounts.US++;
    else locCounts.non_US++;
    const emp = j.tags?.employment;
    if (emp === 'senior') empCounts.senior++;
    else if (emp === 'mid_level') empCounts.mid_level++;
    else if (emp === 'entry_level') empCounts.entry_level++;
    else if (emp) empCounts.other++;
    else empCounts.missing++;
  }
  return {
    contract_version: 1, generated_at: new Date().toISOString(),
    source_artifact: 'step4_senior_partition', source_total: seniorTotal,
    feed_total: feed.length, seniority_source: 'senior-filter partition (Step 4, pre-pooling)',
    tech_domains: SENIOR_TECH_DOMAINS, counts_by_domain: countsByDomain,
    counts_by_location: locCounts, counts_by_employment: empCounts, shadow: true,
    consumer_adoption_blocked_reason: 'INF/OUT senior surface not yet built; artifact measures supply only',
  };
}

// CANADA-LANE: tag-driven additive partition over the post-merge pool (locations:'canada').
// Re-added 2026-06-25 (operator reactivation of the Canada lane). Recovered from commit 81f6347~1
// and hardened with an empty-file fallback (A196 lesson): a shadow feed must never block the
// pipeline. This is NOT a new fetcher — it partitions the SAME publicJobs pool the US feed uses,
// via the tag-engine's `locations:'canada'` tag (the scope knob). Zero US-path impact by
// construction: the US snapshot and all_jobs are computed upstream and untouched here.
// Dual-tag policy (AGG-8): a "Canada; United States" job carries BOTH tags and intentionally
// appears in BOTH the us_jobs and canada feeds — preserved verbatim from the original partition.
const CANADA_TECH_DOMAINS = new Set(['software', 'hardware', 'data_science', 'ai']);
const CANADA_TECH_JOBS_OUTPUT_FILE = path.join(DATA_DIR, 'canada-tech-jobs.jsonl');
const CANADA_TECH_INTERNSHIPS_OUTPUT_FILE = path.join(DATA_DIR, 'canada-tech-internships.jsonl');
const CANADA_TECH_SUMMARY_OUTPUT_FILE = path.join(DATA_DIR, 'canada-tech-summary.json');
const CANADA_ALL_JOBS_OUTPUT_FILE = path.join(DATA_DIR, 'canada-jobs.jsonl');
const CANADA_ALL_SUMMARY_OUTPUT_FILE = path.join(DATA_DIR, 'canada-all-summary.json');
const CANADA_ALL_INTERNSHIPS_OUTPUT_FILE = path.join(DATA_DIR, 'canada-internships.jsonl');

// Sentinel cue regexes — used ONLY by buildCanadaSentinelChecks (the FP guard), NEVER for tagging
// (the tag-engine owns canada detection via hasCanadaLocation). The US cue flags a canada-tagged
// job whose raw location text reads US-only (a mis-tag / leak); the canada cue whitelists genuine
// Canadian text so dual-country rows do not false-alarm.
const CANADA_LOCATION_CUE_RE = /\b(canada|canadian|ontario|toronto|ottawa|waterloo|kitchener|markham|mississauga|burlington|brampton|windsor|london|hamilton|quebec|montr[eé]al|montreal|laval|gatineau|british columbia|vancouver|burnaby|victoria|richmond|surrey|alberta|calgary|edmonton|manitoba|winnipeg|saskatchewan|regina|saskatoon|nova scotia|halifax|new brunswick|fredericton|moncton|newfoundland|st john'?s|prince edward island|charlottetown|yukon|whitehorse|northwest territories|yellowknife|nunavut|iqaluit|\bON\b|\bQC\b|\bBC\b|\bAB\b|\bMB\b|\bSK\b|\bNS\b|\bNB\b|\bNL\b|\bPE\b|\bYT\b|\bNT\b|\bNU\b)\b/i;
const US_LOCATION_CUE_RE = /\b(united states|\busa\b|california|new york|texas|florida|washington|illinois|massachusetts|georgia|north carolina|virginia|colorado|arizona|pennsylvania|ohio|michigan|new jersey|maryland|oregon|utah|seattle|san francisco|los angeles|new york city|austin|dallas|boston|chicago|atlanta|denver|phoenix|philadelphia|detroit|portland|\bCA\b|\bNY\b|\bTX\b|\bFL\b|\bWA\b|\bIL\b|\bMA\b|\bGA\b|\bNC\b|\bVA\b|\bCO\b|\bAZ\b|\bPA\b|\bOH\b|\bMI\b|\bNJ\b|\bMD\b|\bOR\b|\bUT\b)\b/i;

// Shared partition helpers (restored with the canada feed; pure, no side effects, no collisions).
function hasTag(job, field, value) {
  const values = job?.tags?.[field];
  return Array.isArray(values) && values.includes(value);
}
function isInternshipJob(job) {
  return job.tags?.employment === 'internship'
    || job.employment_type === 'internship'
    || (Array.isArray(job.employment_types) && job.employment_types.includes('internship'));
}
function isCanadaJob(job) {
  return hasTag(job, 'locations', 'canada');
}
function isCanadaTechJob(job) {
  const domains = job?.tags?.domains;
  return isCanadaJob(job) && Array.isArray(domains) && domains.some(domain => CANADA_TECH_DOMAINS.has(domain));
}
function incrementCount(map, key, amount = 1) {
  const safeKey = key || 'unknown';
  map[safeKey] = (map[safeKey] || 0) + amount;
}
function sortCountObject(map) {
  return Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}
function locationText(job) {
  return [job.location, job.job_city, job.job_state, job.city, job.state, job.country, job.url].filter(Boolean).join(' ');
}

function buildCanadaSentinelChecks(canadaTechJobs) {
  let missingCanadaTag = 0;
  let nonTechDomain = 0;
  const suspiciousUsOnly = [];
  for (const job of canadaTechJobs) {
    if (!isCanadaJob(job)) missingCanadaTag++;
    if (!Array.isArray(job.tags?.domains) || !job.tags.domains.some(domain => CANADA_TECH_DOMAINS.has(domain))) nonTechDomain++;
    const text = locationText(job);
    const locations = Array.isArray(job.tags?.locations) ? job.tags.locations : [];
    const canadaOnly = locations.includes('canada') && !locations.includes('us') && !locations.includes('remote');
    if (canadaOnly && US_LOCATION_CUE_RE.test(text) && !CANADA_LOCATION_CUE_RE.test(text)) {
      suspiciousUsOnly.push({
        id: job.id, company_name: job.company_name, title: job.title, source: job.source,
        job_city: job.job_city || '', job_state: job.job_state || '', url: job.url || '',
      });
    }
  }
  return {
    contract_version: 'canada-tech-feed-v1',
    passed: missingCanadaTag === 0 && nonTechDomain === 0 && suspiciousUsOnly.length === 0,
    checks: {
      missing_canada_tag: missingCanadaTag,
      non_tech_domain: nonTechDomain,
      suspicious_us_only_location: suspiciousUsOnly.length,
    },
    suspicious_us_only_samples: suspiciousUsOnly.slice(0, 10),
  };
}

function buildCanadaTechFeed(jobs) {
  const canadaJobs = [];
  const canadaTechJobs = [];
  const byDomain = {};
  const bySource = {};
  const companyCounts = {};
  let canadaInternships = 0;
  let canadaTechInternships = 0;
  for (const job of jobs) {
    if (!isCanadaJob(job)) continue;
    canadaJobs.push(job);
    if (isInternshipJob(job)) canadaInternships++;
    if (!isCanadaTechJob(job)) continue;
    canadaTechJobs.push(job);
    if (isInternshipJob(job)) canadaTechInternships++;
    incrementCount(bySource, job.source);
    incrementCount(companyCounts, job.company_name);
    for (const domain of job.tags.domains || []) {
      if (CANADA_TECH_DOMAINS.has(domain)) incrementCount(byDomain, domain);
    }
  }
  const topCompanies = Object.entries(companyCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([company_name, count]) => ({ company_name, count }));
  return {
    jobs: canadaTechJobs,
    summary: {
      contract_version: 'canada-tech-feed-v1',
      generated_at: new Date().toISOString(),
      source: 'jobs-aggregator-private normalized post-merge all_jobs pipeline output',
      tag_engine_version: TAG_ENGINE_VERSION,
      total_jobs: jobs.length,
      canada_jobs: canadaJobs.length,
      canada_tech_jobs: canadaTechJobs.length,
      canada_internships: canadaInternships,
      canada_tech_internships: canadaTechInternships,
      included_domains: [...CANADA_TECH_DOMAINS],
      by_domain: sortCountObject(byDomain),
      by_source: sortCountObject(bySource),
      top_companies: topCompanies,
      sentinel_false_positive_checks: buildCanadaSentinelChecks(canadaTechJobs),
    },
  };
}

// Canada tech internships lane: subset of canada-tech-jobs filtered to entry_level + internship
// (A164 recommended highest-signal first slice for the OUT canada-internships consumer).
function buildCanadaInternshipsFeed(canadaTechJobs) {
  return canadaTechJobs.filter(job => ['entry_level', 'internship'].includes(job?.tags?.employment));
}

async function writeCanadaTechFeed(jobs) {
  const { jobs: canadaTechJobs, summary } = buildCanadaTechFeed(jobs);
  await writeJobsJSONL(canadaTechJobs, CANADA_TECH_JOBS_OUTPUT_FILE);
  await writeMetadata(summary, CANADA_TECH_SUMMARY_OUTPUT_FILE);
  console.log(`🇨🇦 CANADA-LANE: tech feed ${canadaTechJobs.length} jobs (${summary.canada_jobs} Canada total, ${summary.canada_tech_internships} tech internships) → canada-tech-jobs.jsonl`);
  if (!summary.sentinel_false_positive_checks.passed) {
    throw new Error(`Canada tech feed sentinel checks failed: ${JSON.stringify(summary.sentinel_false_positive_checks.checks)}`);
  }
  return summary;
}

async function writeCanadaInternshipsFeed(jobs) {
  const { jobs: canadaTechJobs } = buildCanadaTechFeed(jobs);
  const internshipsJobs = buildCanadaInternshipsFeed(canadaTechJobs);
  await writeJobsJSONL(internshipsJobs, CANADA_TECH_INTERNSHIPS_OUTPUT_FILE);
  const internshipCount = internshipsJobs.filter(job => job?.tags?.employment === 'internship').length;
  const entryLevelCount = internshipsJobs.filter(job => job?.tags?.employment === 'entry_level').length;
  console.log(`🇨🇦 CANADA-LANE: internships feed ${internshipsJobs.length} jobs (${entryLevelCount} entry-level, ${internshipCount} internships) → canada-tech-internships.jsonl`);
  return { total: internshipsJobs.length, entry_level: entryLevelCount, internships: internshipCount };
}
// Canada ALL internships lane: broad internship feed from ALL Canada jobs (not just tech).
// INF-CANADA-INTERNSHIP-FEED-1: matches the US Internships-2027 pattern (all categories).
async function writeCanadaAllInternshipsFeed(jobs) {
  const canadaAllJobs = jobs.filter(isCanadaJob);
  const internshipsJobs = canadaAllJobs.filter(job => isInternshipJob(job));
  await writeJobsJSONL(internshipsJobs, CANADA_ALL_INTERNSHIPS_OUTPUT_FILE);
  console.log(`🇨🇦 CANADA-LANE: ALL internships feed ${internshipsJobs.length} jobs → canada-internships.jsonl`);
  return { total: internshipsJobs.length };
}
// AGG-CANADAFEED-1: ALL-Canada feed (broadens canada-tech → all domains, tech-prioritized).
// Additive shadow feed alongside canada-tech-* (unchanged, back-compat). Independent of tech feeds.
function buildCanadaAllSentinelChecks(canadaAllJobs) {
  let missingCanadaTag = 0;
  const suspiciousUsOnly = [];
  for (const job of canadaAllJobs) {
    if (!isCanadaJob(job)) missingCanadaTag++;
    const text = locationText(job);
    const locations = Array.isArray(job.tags?.locations) ? job.tags.locations : [];
    const canadaOnly = locations.includes('canada') && !locations.includes('us') && !locations.includes('remote');
    if (canadaOnly && US_LOCATION_CUE_RE.test(text) && !CANADA_LOCATION_CUE_RE.test(text)) {
      suspiciousUsOnly.push({ id: job.id, company_name: job.company_name, title: job.title, source: job.source, job_city: job.job_city || '', job_state: job.job_state || '', url: job.url || '' });
    }
  }
  return {
    contract_version: 'canada-all-feed-v1',
    passed: missingCanadaTag === 0 && suspiciousUsOnly.length === 0,
    checks: { missing_canada_tag: missingCanadaTag, suspicious_us_only_location: suspiciousUsOnly.length },
    suspicious_us_only_samples: suspiciousUsOnly.slice(0, 10),
  };
}
function buildCanadaAllFeed(jobs) {
  const canadaJobs = [];
  const byDomain = {}; const bySource = {}; const companyCounts = {};
  let techCount = 0; let nonTechCount = 0;
  for (const job of jobs) {
    if (!isCanadaJob(job)) continue;
    canadaJobs.push(job);
    const doms = job?.tags?.domains || [];
    const isTech = doms.some(d => CANADA_TECH_DOMAINS.has(d));
    if (isTech) techCount++; else nonTechCount++;
    incrementCount(bySource, job.source);
    incrementCount(companyCounts, job.company_name);
    for (const d of doms) incrementCount(byDomain, d);
  }
  // tech-prioritized: tech-domain jobs first, then non-tech; each by posted_at desc.
  const sorted = canadaJobs
    .map(j => ({ job: j, _tech: (j?.tags?.domains || []).some(d => CANADA_TECH_DOMAINS.has(d)) }))
    .sort((a, b) => (b._tech - a._tech) || (new Date(b.job.posted_at || 0).getTime() - new Date(a.job.posted_at || 0).getTime()))
    .map(x => x.job);
  const topCompanies = Object.entries(companyCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20).map(([company_name, count]) => ({ company_name, count }));
  return {
    jobs: sorted,
    summary: {
      contract_version: 'canada-all-feed-v1',
      generated_at: new Date().toISOString(),
      source: 'jobs-aggregator-private normalized post-merge all_jobs pipeline output',
      tag_engine_version: TAG_ENGINE_VERSION,
      total_jobs: jobs.length,
      canada_jobs: canadaJobs.length,
      canada_tech_jobs: techCount,
      canada_non_tech_jobs: nonTechCount,
      tech_prioritized: true,
      by_domain: sortCountObject(byDomain),
      by_source: sortCountObject(bySource),
      top_companies: topCompanies,
      sentinel_false_positive_checks: buildCanadaAllSentinelChecks(sorted),
    },
  };
}
async function writeCanadaAllFeed(jobs) {
  const { jobs: canadaAllJobs, summary } = buildCanadaAllFeed(jobs);
  await writeJobsJSONL(canadaAllJobs, CANADA_ALL_JOBS_OUTPUT_FILE);
  await writeMetadata(summary, CANADA_ALL_SUMMARY_OUTPUT_FILE);
  console.log(`🇨🇦 CANADA-LANE (all): all-canada feed ${canadaAllJobs.length} jobs (${summary.canada_tech_jobs} tech + ${summary.canada_non_tech_jobs} non-tech, tech-prioritized) → canada-jobs.jsonl`);
  if (!summary.sentinel_false_positive_checks.passed) {
    throw new Error(`Canada all feed sentinel checks failed: ${JSON.stringify(summary.sentinel_false_positive_checks.checks)}`);
  }
  return summary;
}


function activePublicWindowTs(job, now = Date.now()) {
  const rawPostedAt = job?.posted_at ? new Date(job.posted_at).getTime() : now;
  const postedTs = Number.isNaN(rawPostedAt) ? now : Math.min(rawPostedAt, now);
  if (job?.source === 'greenhouse' && job?.tags?.employment === 'internship' && job?.source_updated_at) {
    const rawUpdatedAt = new Date(job.source_updated_at).getTime();
    if (!Number.isNaN(rawUpdatedAt)) {
      const updatedTs = Math.min(rawUpdatedAt, now);
      if (updatedTs > postedTs) return updatedTs;
    }
  }
  return postedTs;
}

function applicableTtlMs(job) {
  return job?.tags?.employment === 'internship' ? INTERNSHIP_TTL_MS : DEDUPE_TTL_MS;
}

// AGG-LIFECYCLE-1: TAG-AND-KEEP for evergreen / ghost / TTL-expired jobs.
// Previously these were DROPPED from the pool; now they are KEPT and tagged with a
// lifecycle_state so they stay visible + filterable instead of vanishing. The 5 states:
//   fresh            — current-run job, within the active window (recent posted_at)
//   carry-forward    — prior-run job merged via rolling window (source absent this run, still alive)
//   evergreen        — old-but-alive (always-open repost); posted_at in the 10d–TTL evergreen band
//   stale-candidate  — posted_at beyond TTL (or null/unverifiable); previously TTL-dropped
//   dead             — confirmed closed/ghost (absent from a successful fetch) or retired source
// Precedence (most actionable first): dead > stale-candidate > evergreen > carry-forward > fresh.
// Consumers replicate the pre-LIFECYCLE "dropped" set by excluding {dead, stale-candidate}.
const LIFECYCLE_VERSION = 1;
const LIFECYCLE_EVERGREEN_THRESHOLD_DAYS = 10; // matches evergreen-detector.js EVERGREEN_THRESHOLD_DAYS
const LIFECYCLE_EVERGREEN_THRESHOLD_MS = LIFECYCLE_EVERGREEN_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
// Anti-flood guardrail (verify-no-flood): dead / stale-candidate jobs are KEPT for visibility but
// truly retired (dropped) once posted_at outlives its TTL + this window, so the rolling store
// cannot accumulate closed/expired jobs forever. Generous vs both 14d regular and 120d internship TTL.
const LIFECYCLE_VISIBILITY_DAYS = 45;
const LIFECYCLE_VISIBILITY_MS = LIFECYCLE_VISIBILITY_DAYS * 24 * 60 * 60 * 1000;

/**
 * AGG-LIFECYCLE-1: classify a job's age-based lifecycle_state.
 * Returns 'stale-candidate' | 'evergreen' | null (null = within the fresh window; caller resolves
 * carry-forward vs fresh). Caller must assign 'dead' for confirmed-closed jobs separately, since
 * closure (not age) is the strongest lifecycle signal and takes precedence over age.
 */
function classifyAgeLifecycle(job, now = Date.now()) {
  const jobTtlMs = applicableTtlMs(job);
  const windowTs = activePublicWindowTs(job, now);
  if (!job.posted_at || Number.isNaN(windowTs) || windowTs < now - jobTtlMs) {
    return 'stale-candidate';
  }
  if (windowTs < now - LIFECYCLE_EVERGREEN_THRESHOLD_MS) {
    return 'evergreen';
  }
  return null;
}

/**
 * AGG-LIFECYCLE-1: hard-retire check (anti-flood). A dead/stale-candidate job kept for visibility
 * is truly dropped once it outlives its TTL + visibility window, bounding rolling-pool growth.
 */
function isLifecycleHardRetired(job, now = Date.now()) {
  if (!job.posted_at) return false; // null-date jobs are rare; retained, bounded by their scarcity
  const windowTs = activePublicWindowTs(job, now);
  if (Number.isNaN(windowTs)) return false;
  return windowTs < now - (applicableTtlMs(job) + LIFECYCLE_VISIBILITY_MS);
}

/**
 * AGG-32 / AGG-LIFECYCLE-1: classify current-run jobs by posted_at age (TAG-AND-KEEP).
 * Previously DROPPED stale (TTL-expired) and null-date jobs from the pool. Now KEPT and tagged
 * with lifecycle_state (stale-candidate / evergreen / fresh) so they stay visible + filterable.
 * Hard-retires jobs beyond TTL + visibility window (anti-flood; see isLifecycleHardRetired).
 * AGG-6 date overwrite disabled A86 — jobs keep their source-reported posted_at.
 */
function resolvePostedAt(publicJobs, prevLines) {
  // AGG-LIFECYCLE-1: single pass — tag instead of drop.
  // SUP-TTL-1: Internships get wider TTL window (120d vs 14d).
  // AGG-STALE-FIX-1 (2026-07-06): hard-retire now also applies to current-run jobs.
  // Previously only carry-forward (mergeCarryForward) had the check. But ATS sources
  // (oracle, greenhouse) keep returning ancient ghost postings indefinitely — 155 jobs
  // >59d accumulated because resolvePostedAt blindly trusted "source returns it = active."
  // Same isLifecycleHardRetired function, applied uniformly.
  let staleTagged = 0;
  let evergreenTagged = 0;
  let freshTagged = 0;
  let hardRetired = 0;
  for (let i = publicJobs.length - 1; i >= 0; i--) {
    const job = publicJobs[i];
    if (!job.tags) job.tags = {};
    const ageState = classifyAgeLifecycle(job);
    if (ageState === 'stale-candidate') {
      if (isLifecycleHardRetired(job)) {
        publicJobs.splice(i, 1);
        hardRetired++;
        continue;
      }
      job.tags.lifecycle_state = 'stale-candidate';
      staleTagged++;
    } else if (ageState === 'evergreen') {
      job.tags.lifecycle_state = 'evergreen';
      evergreenTagged++;
    } else {
      job.tags.lifecycle_state = 'fresh';
      freshTagged++;
    }
    job.tags.lifecycle_version = LIFECYCLE_VERSION;
  }

  if (hardRetired > 0) {
    console.log(`🧹 AGG-STALE-FIX-1: hard-retired ${hardRetired} current-run jobs beyond TTL+${LIFECYCLE_VISIBILITY_DAYS}d (ATS ghost postings — source still returns them but posted_at expired)`);
  }
  if (staleTagged > 0 || evergreenTagged > 0) {
    console.log(`🏷️  AGG-LIFECYCLE-1: kept+tagged ${staleTagged} stale-candidate + ${evergreenTagged} evergreen current-run jobs (>${DEDUPE_TTL_DAYS}d regular / 120d internship)`);
  }
}

// AGG-PIPE-4: Sources excluded from closed-job detection.
// Workday: per-tenant failures inside an otherwise-successful aggregate fetch
// would falsely close hundreds of jobs (33K+ WD jobs, ~138 tenants).
// SmartRecruiters: owned by enrichment workflow (DESC-MIGRATE-1), not main pipeline.
const PIPE4_EXCLUDED_SOURCES = new Set(['workday', 'smartrecruiters']);

// Sources that are no longer fetched by any active lane must not survive through
// the internship 120-day rolling window. If a retired source is absent from the
// current run, carry-forward would otherwise preserve stale skeleton listings.
const RETIRED_CARRY_FORWARD_SOURCES = new Set(['jsearch', 'simplify', 'icims']);

// AGG-PIPE-4: Map Phase B fetcher display names to job source field values.
const FETCHER_NAME_TO_SOURCE = {
  'Amazon': 'amazon',
  'Netflix': 'eightfold',
  'Apple': 'apple',
  'Two Sigma': 'twosigma',
  'Uber': 'uber',
  'Google': 'google',
  'SimplifyJobs': 'simplify',
  'Microsoft': 'microsoft',
  'Oracle': 'oracle',
  'AMD': 'amd',
  'TikTok': 'tiktok',
  'D.E. Shaw': 'deshaw',
};

// AGG-HOTPATH-1: fetchers explicitly removed from the fast publish path.
// They may return via separate workflowing or slower lanes later, but they must not
// consume Tier A runtime budget inside the main 15-minute-capped workflow.
const HOTPATH_DEMOTED_FETCHERS = new Set(['Apple', 'Google', 'Microsoft', 'Oracle']);
const HOTPATH_DEMOTED_SOURCES = new Set(
  [...HOTPATH_DEMOTED_FETCHERS].map(name => FETCHER_NAME_TO_SOURCE[name] || name.toLowerCase())
);

const SUPPLEMENTAL_LANE_FILES = [
  {
    lane: 'oracle',
    jobsFile: path.join(DATA_DIR, 'supplemental-oracle-jobs.json'),
    metaFile: path.join(DATA_DIR, 'supplemental-oracle-metadata.json'),
  },
  {
    lane: 'custom',
    jobsFile: path.join(DATA_DIR, 'supplemental-custom-jobs.json'),
    metaFile: path.join(DATA_DIR, 'supplemental-custom-metadata.json'),
  },
];

function normalizeSupplementalJobForMerge(job, laneMeta) {
  if (!job || typeof job !== 'object') return null;
  const source = typeof job.source === 'string' ? job.source.toLowerCase() : null;
  if (!source) return null;

  const normalized = { ...job, source };
  if (!normalized.posted_at && laneMeta?.generated_at) {
    const generatedTs = new Date(laneMeta.generated_at).getTime();
    if (!Number.isNaN(generatedTs)) {
      normalized.posted_at = laneMeta.generated_at;
      normalized.posted_at_basis = 'supplemental_generated_at';
    }
  }
  return normalized;
}

function summarizeSupplementalLaneForMerge(laneName, laneJobs, laneMeta, nowMs = Date.now()) {
  const info = {
    status: 'missing',
    skip_reason: null,
    generated_at: laneMeta?.generated_at || null,
    age_minutes: null,
    jobs_loaded: Array.isArray(laneJobs) ? laneJobs.length : 0,
    by_source: {},
    publish_contract: laneMeta?.publish_contract || null,
  };
  if (!Array.isArray(laneJobs)) {
    info.status = 'skipped_invalid';
    info.skip_reason = 'jobs_not_array';
    return { info, jobs: [], sourcesUsed: new Set() };
  }
  if (!laneMeta || typeof laneMeta !== 'object') {
    info.status = 'skipped_invalid';
    info.skip_reason = 'metadata_not_object';
    return { info, jobs: [], sourcesUsed: new Set() };
  }
  if (laneMeta.lane_name && laneMeta.lane_name !== laneName) {
    info.status = 'skipped_invalid';
    info.skip_reason = 'lane_name_mismatch';
    return { info, jobs: [], sourcesUsed: new Set() };
  }

  const normalizedJobs = [];
  const sourcesUsed = new Set();
  for (const job of laneJobs) {
    const normalized = normalizeSupplementalJobForMerge(job, laneMeta);
    if (!normalized) continue;
    const source = normalized.source;
    sourcesUsed.add(source);
    info.by_source[source] = (info.by_source[source] || 0) + 1;
    normalizedJobs.push(normalized);
  }

  const generatedTs = info.generated_at ? new Date(info.generated_at).getTime() : Number.NaN;
  if (info.generated_at) {
    if (Number.isNaN(generatedTs)) {
      info.status = 'skipped_invalid';
      info.skip_reason = 'invalid_generated_at';
      return { info, jobs: [], sourcesUsed: new Set() };
    }
    info.age_minutes = Math.max(0, Math.floor((nowMs - generatedTs) / 60000));
  }

  const maxStalenessMinutes = Number(info.publish_contract?.max_staleness_minutes);
  if (Number.isFinite(maxStalenessMinutes) && maxStalenessMinutes > 0 && Number.isFinite(generatedTs)) {
    if (nowMs - generatedTs > maxStalenessMinutes * 60 * 1000) {
      info.status = 'skipped_stale';
      info.skip_reason = 'stale_artifact';
      return { info, jobs: [], sourcesUsed: new Set() };
    }
  }

  if (Number.isFinite(laneMeta.jobs_fetched) && laneMeta.jobs_fetched !== laneJobs.length) {
    info.status = 'skipped_invalid';
    info.skip_reason = 'jobs_fetched_mismatch';
    return { info, jobs: [], sourcesUsed: new Set() };
  }

  if (laneName === 'custom') {
    // AGG-SLOW-LANE-1: validate that actual sources are a SUBSET of declared sources.
    // A fetcher legitimately returning 0 (e.g. API down) shouldn't invalidate the entire lane.
    // We still reject UNDECLARED sources (corruption/tampering detection).
    const declaredSet = laneMeta.sources && typeof laneMeta.sources === 'object'
      ? new Set(Object.keys(laneMeta.sources))
      : new Set();
    const actualSources = Object.keys(info.by_source);
    for (const src of actualSources) {
      if (!declaredSet.has(src)) {
        info.status = 'skipped_invalid';
        info.skip_reason = `undeclared_source:${src}`;
        return { info, jobs: [], sourcesUsed: new Set() };
      }
    }
  } else if (laneName === 'oracle') {
    const actualSources = Object.keys(info.by_source);
    if (actualSources.some(source => source !== 'oracle')) {
      info.status = 'skipped_invalid';
      info.skip_reason = 'unexpected_source';
      return { info, jobs: [], sourcesUsed: new Set() };
    }
  }

  info.status = 'merged';
  return { info, jobs: normalizedJobs, sourcesUsed };
}


function loadSupplementalInputs(nowMs = Date.now()) {
  const jobs = [];
  const inputs = {};
  const sourcesUsed = new Set();
  for (const lane of SUPPLEMENTAL_LANE_FILES) {
    if (!fs.existsSync(lane.jobsFile) || !fs.existsSync(lane.metaFile)) {
      inputs[lane.lane] = {
        status: 'missing',
        skip_reason: 'artifact_missing',
        generated_at: null,
        age_minutes: null,
        jobs_loaded: 0,
        by_source: {},
        publish_contract: null,
      };
      continue;
    }
    try {
      const laneJobs = JSON.parse(fs.readFileSync(lane.jobsFile, 'utf8'));
      const laneMeta = JSON.parse(fs.readFileSync(lane.metaFile, 'utf8'));
      const summary = summarizeSupplementalLaneForMerge(lane.lane, laneJobs, laneMeta, nowMs);
      inputs[lane.lane] = summary.info;
      if (summary.info.status !== 'merged') {
        console.warn(`⚠️ Supplemental lane ${lane.lane}: skipped (${summary.info.skip_reason})`);
        continue;
      }
      for (const source of summary.sourcesUsed) sourcesUsed.add(source);
      appendAll(jobs, summary.jobs);
    } catch (e) {
      inputs[lane.lane] = {
        status: 'skipped_invalid',
        skip_reason: 'load_error',
        generated_at: null,
        age_minutes: null,
        jobs_loaded: 0,
        by_source: {},
        publish_contract: null,
      };
      console.warn(`⚠️ Supplemental lane ${lane.lane}: could not load artifact (${e.message})`);
    }
  }
  return { jobs, inputs, sourcesUsed };
}




/**
 * Carry-forward merge: re-adds prior-run jobs not in current run (rolling window).
 * Re-tags employment, re-tags domains on version change, refreshes empty locations.
 *
 * AGG-PIPE-4: Jobs from sources that had a successful fetch this run are NOT carried
 * forward — if the source fetched successfully and the job isn't in the results,
 * the job is genuinely closed. Excludes WD and SR (multi-tenant false-positive risk).
 */
function shouldTreatCompanyScopedSourceJobClosed(job, fetcherHealth) {
  const source = (job.source || '').toLowerCase();
  if (source !== 'workday' && source !== 'smartrecruiters') return false;
  if (!fetcherHealth || typeof fetcherHealth !== 'object') return false;
  const companyKey = job.company_name;
  if (!companyKey) return false;
  const health = fetcherHealth[companyKey];
  return health?.source === source && health?.status === 'alive';
}

// AGG-STALEUPSTREAM-1 (2026-07-04): drop orphan jobs — carry-forward jobs whose company is no longer
// in the active multi-tenant config (workday/smartrecruiters) AND not fetched in >14d. These are
// defunct-tenant leftovers (e.g. Sanofi, Veolia) that never get re-fetched -> never dead-checked ->
// linger indefinitely. High precision: company-list name match is exact (0 near-misses measured), and
// the >14d fetched_at floor avoids dropping jobs from very-recently-removed companies. Exported for testing.
function dropOrphanJobs(publicJobs, activeWdNames, activeSRNames, graceMs = 14 * 86400000, now = Date.now()) {
  let dropped = 0;
  // AGG-SIMPLIFY-EXIT-1 (2026-07-06): extended to cover ALL multi-tenant sources (workday, SR, icims)
  // + the hardcoded iCIMS tenant list (orphan check was workday/SR-only — zombie iCIMS jobs survived).
  const ACTIVE_ICIMS_COMPANIES = new Set(['Peraton', 'General Dynamics Mission Systems', 'Cotiviti']);
  for (let i = publicJobs.length - 1; i >= 0; i--) {
    const j = publicJobs[i];
    const src = (j.source || '').toLowerCase();
    let set = null;
    if (src === 'workday') set = activeWdNames;
    else if (src === 'smartrecruiters') set = activeSRNames;
    else if (src === 'icims') set = ACTIVE_ICIMS_COMPANIES;
    if (set && set.size > 0 && !set.has(j.company_name) && j.fetched_at && (now - new Date(j.fetched_at).getTime()) > graceMs) {
      publicJobs.splice(i, 1);
      dropped++;
    }
  }
  return dropped;
}

function mergeCarryForward(publicJobs, prevLines, currentIds, currentFingerprints, stripFields, successfulSources, companyFetchHealth) {

  let mergedCount = 0;
  let staleKept = 0;          // AGG-LIFECYCLE-1: TTL-expired / null-date prior-run (was dropped)
  let deadDropped = 0;       // OPERATOR 2026-07-03: dead dropped UPSTREAM (reverses AGG-LIFECYCLE-1 tag-and-keep). dead = source fetched OK this run but job absent (or retired source) — high-precision, no re-flood (source no longer lists it). Restores pre-LIFECYCLE drop behavior.
  let evergreenTagged = 0;
  let carryForwardTagged = 0;
  let hardRetired = 0;        // AGG-LIFECYCLE-1: anti-flood true-drop
  let seniorDropped = 0;      // OUT OF SCOPE (senior filter) — still dropped, not lifecycle-tagged
  let fpSkipCount = 0;
  for (const line of prevLines) {
    try {
      const job = JSON.parse(line);
      if (currentIds.has(job.id)) continue;                                       // dedup (unchanged)
      if (job.fingerprint && currentFingerprints.has(job.fingerprint)) { fpSkipCount++; continue; } // dedup

      // AGG-LIFECYCLE-1: build the carried-forward job once, then TAG-AND-KEEP.
      // (Previously the cases below each `continue`-DROPPED the job; now they keep + tag it.)
      const strippedJob = { ...job };
      for (const field of stripFields) delete strippedJob[field];
      // AGG-DATA-13: normalize employment types on carry-forward jobs (AGG-PIPE-13: shared constant)
      if (Array.isArray(strippedJob.employment_types)) {
        strippedJob.employment_types = strippedJob.employment_types.map(t => EMPLOYMENT_NORMALIZE_MAP[t] || t);
      }
      // A86: Restore posted_at from first_published for carry-forward jobs.
      // Pre-A86 runs used FRESHNESS-2 which inflated posted_at to Date.now() when source date >7d.
      // This one-time correction restores the real source date where first_published is available.
      if (strippedJob.first_published && strippedJob.posted_at) {
        const fpTs = new Date(strippedJob.first_published).getTime();
        const paTs = new Date(strippedJob.posted_at).getTime();
        if (!isNaN(fpTs) && !isNaN(paTs) && paTs > fpTs) {
          strippedJob.posted_at = strippedJob.first_published;
        }
      }
      if (!strippedJob.tags) strippedJob.tags = {};

      // Classify lifecycle_state. OPERATOR-2026-07-04: DEAD takes precedence over age.
      // A confirmed-dead prior-run job (retired source / source fetched OK but absent / company-scoped
      // closed) is DROPPED upstream regardless of posted_at age — age must not "rescue" a dead job.
      // Previously the stale-candidate age check fired first, so old dead jobs leaked into the pool
      // tagged stale-candidate. This extends the 2026-07-03 dead-drop to stale-candidate-age jobs
      // using the SAME source-absence signal (high-precision; non-dead stale-candidate still tag-and-keep).
      // Consumers replicate the pre-LIFECYCLE "dropped" set by excluding {dead, stale-candidate}.
      let state;
      const ageState = classifyAgeLifecycle(strippedJob);
      if (RETIRED_CARRY_FORWARD_SOURCES.has((strippedJob.source || '').toLowerCase())) {
        deadDropped++; continue;  // DROP dead upstream. Retired source.
      } else if (successfulSources.has(strippedJob.source) && !PIPE4_EXCLUDED_SOURCES.has(strippedJob.source)) {
        deadDropped++; continue;  // DROP dead upstream. Source fetched OK this run but job absent -> gone from its own career site.
      } else if (shouldTreatCompanyScopedSourceJobClosed(strippedJob, companyFetchHealth)) {
        deadDropped++; continue;  // DROP dead upstream. Company-scoped source confirmed closed.
      } else if (ageState === 'stale-candidate') {
        if (isLifecycleHardRetired(strippedJob)) { hardRetired++; continue; }      // anti-flood: truly drop (non-dead, extremely old)
        state = 'stale-candidate';
        staleKept++;
      } else if (ageState === 'evergreen') {
        state = 'evergreen'; evergreenTagged++;
      } else {
        state = 'carry-forward'; carryForwardTagged++;
      }
      strippedJob.tags.lifecycle_state = state;
      strippedJob.tags.lifecycle_version = LIFECYCLE_VERSION;
      publicJobs.push(strippedJob);
      mergedCount++;
    } catch { /* skip malformed lines */ }
  }

  if (staleKept > 0) {
    console.log(`🏷️  AGG-LIFECYCLE-1: kept+tagged ${staleKept} stale-candidate prior-run jobs (TTL-expired/null-date; previously dropped)`);
  }
  if (deadDropped > 0) {
    console.log(`🧹 OPERATOR 2026-07-03+07-04: dropped ${deadDropped} dead prior-run jobs UPSTREAM (closed/ghost/retired; dead takes precedence over posted_at age since 2026-07-04) — they no longer reach all_jobs/R2/consumers. [non-dead stale-candidate still tag-and-keep until a first_seen-based TTL]`);
  }
  if (hardRetired > 0) {
    console.log(`🧹 AGG-LIFECYCLE-1: hard-retired ${hardRetired} prior-run jobs beyond TTL+${LIFECYCLE_VISIBILITY_DAYS}d visibility window (anti-flood)`);
  }
  if (fpSkipCount > 0) {
    console.log(`🔄 Rolling window: skipped ${fpSkipCount} prior-run jobs with matching fingerprint (ID changed, current version wins)`);
  }
  if (seniorDropped > 0) {
    console.log(`🛡️  Rolling window: dropped ${seniorDropped} senior prior-run jobs (senior filter; out of lifecycle scope)`);
  }
  if (mergedCount > 0) {
    publicJobs.sort((a, b) => new Date(b.posted_at || 0) - new Date(a.posted_at || 0));
    let empRetagged = 0;
    let domainRetagged = 0;
    let locRefreshed = 0;
    let locRetagged = 0;
    for (const job of publicJobs) {
      if (currentIds.has(job.id)) continue;
      if (!job.tags) job.tags = {};
      const newEmp = tagEmployment(job);
      if (job.tags.employment !== newEmp) {
        job.tags.employment = newEmp;
        empRetagged++;
      }
      // AGG-PIPE-12: Always re-tag domains (not just on version change).
      // Between version bumps, keyword/guard changes silently miss carry-forward jobs.
      const freshDomains = tagDomains(job);
      const oldDomains = (job.tags.domains || []).slice().sort().join(',');
      const newDomains = (freshDomains || []).slice().sort().join(',');
      if (oldDomains !== newDomains) {
        job.tags.domains = freshDomains;
        domainRetagged++;
      }
      if ((!job.job_state || job.job_state === '') || (!job.job_city || job.job_city === '')) {
        const hadState = job.job_state && job.job_state !== '';
        const hadCity = job.job_city && job.job_city !== '';
        normalizeJob(job);
        if ((!hadState && job.job_state) || (!hadCity && job.job_city)) locRefreshed++;
      }
      const freshLocations = tagLocations(job);
      const oldLocations = (job.tags.locations || []).slice().sort().join(',');
      const newLocations = (freshLocations || []).slice().sort().join(',');
      if (oldLocations !== newLocations) {
        job.tags.locations = freshLocations;
        locRetagged++;
      }
      job.tags.tag_engine_version = TAG_ENGINE_VERSION;
      // AGG-LIFECYCLE-1: re-stamp lifecycle version on every carry-forward job each run.
      if (job.tags.lifecycle_state) job.tags.lifecycle_version = LIFECYCLE_VERSION;
    }
    console.log(`🔄 Merged ${mergedCount} prior-run jobs into rolling window (total: ${publicJobs.length}${deadDropped > 0 ? `, ${deadDropped} dead dropped upstream` : ''}${staleKept > 0 ? `, ${staleKept} stale-candidate kept+tagged` : ''}${evergreenTagged > 0 ? `, ${evergreenTagged} evergreen` : ''}${carryForwardTagged > 0 ? `, ${carryForwardTagged} carry-forward` : ''}${empRetagged > 0 ? `, ${empRetagged} employment re-tagged` : ''}${domainRetagged > 0 ? `, ${domainRetagged} domains re-tagged (version ${TAG_ENGINE_VERSION})` : ''}${locRefreshed > 0 ? `, ${locRefreshed} location fields refreshed` : ''}${locRetagged > 0 ? `, ${locRetagged} locations re-tagged` : ''})`);
  } else {
    console.log(`🔄 No prior-run jobs to merge${(deadDropped + staleKept) > 0 ? ` (${deadDropped} dead dropped, ${staleKept} stale-candidate tagged)` : ''}`);
  }
}

/**
 * Generate tag stats from full pool (post-merge + post-AGG-32).
 * Must run after both carry-forward merge and AGG-32 filter for accurate counts.
 */
function computeFullPoolTagStats(publicJobs) {
  const stats = generateTagStats(publicJobs);
  console.log(`📊 Tag stats: ${stats.total} jobs (full pool)`);
  return stats;
}

/**
 * Main execution function
 */
async function main() {
  const startTime = Date.now();
  const stageTimings = {};
  const pipelineTimestamps = { started_at: new Date(startTime).toISOString() };

  // AGG-PREVIOUS-CYCLE-TIMESTAMP-1 v3: read prior run's completion timestamp.
  // Seeded from R2 by fetch-jobs.yml "Seed pipeline-cycle-state.json" step.
  // First run (file absent) → null → field publishes as null; self-bootstraps next cycle.
  // v3 lesson: declared in main() and PASSED explicitly to generateMetadata (v2 used a
  // closure reference across function boundaries → ReferenceError at runtime, not at parse).
  let prevRunCompletedAt = null;
  try {
    const _cycleStatePath = path.join(DATA_DIR, 'pipeline-cycle-state.json');
    if (fs.existsSync(_cycleStatePath)) {
      prevRunCompletedAt = JSON.parse(fs.readFileSync(_cycleStatePath, 'utf8')).last_completed_at || null;
    }
  } catch (_cycleErr) { /* non-fatal: first run or corrupt marker */ }

  console.log('🚀 Jobs Data Fetcher - Starting...');
  console.log('═'.repeat(60));
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no commits)' : 'NORMAL'}`);
  console.log('');

  // AGG-PIPE-7: Startup assertions — fail fast when critical files are missing.
  // Origin: d06bb81 deleted tag-engine.js, pipeline ran 25+ failing runs over 7h.
  try {
    // (a) Submodule directory exists and isn't empty
    const sharedFiles = fs.readdirSync(SHARED);
    assert(sharedFiles.length > 0, `Submodule directory ${SHARED} is empty`);

    // (b) tag-engine.js exports expected functions
    assert(typeof tagJobs === 'function', 'tag-engine.js does not export tagJobs');
    assert(typeof tagEmployment === 'function', 'tag-engine.js does not export tagEmployment');
    assert(typeof tagDomains === 'function', 'tag-engine.js does not export tagDomains');
    assert(typeof generateTagStats === 'function', 'tag-engine.js does not export generateTagStats');

    // (c) Senior filter exports expected functions
    assert(typeof filterSeniorJobs === 'function', 'senior-filter.js does not export filterSeniorJobs');
    assert(typeof isSeniorJob === 'function', 'senior-filter.js does not export isSeniorJob');
    assert(typeof buildCompanyOverrideMap === 'function', 'senior-filter.js does not export buildCompanyOverrideMap');

    // (d) Deduplicator exports TTL constants
    assert(typeof DEDUPE_TTL_MS === 'number' && DEDUPE_TTL_MS > 0, 'deduplicator.js does not export valid DEDUPE_TTL_MS');
    assert(typeof DEDUPE_TTL_DAYS === 'number' && DEDUPE_TTL_DAYS > 0, 'deduplicator.js does not export valid DEDUPE_TTL_DAYS');

    // (e) company-list.json is parseable with expected platforms
    const companyList = JSON.parse(fs.readFileSync(COMPANY_LIST_PATH, 'utf8'));
    const platforms = Object.keys(companyList);
    const requiredPlatforms = ['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters'];
    for (const p of requiredPlatforms) {
      assert(platforms.includes(p), `company-list.json missing required platform: ${p}`);
    }

    console.log('✅ Startup assertions passed (AGG-PIPE-7)');
  } catch (assertionErr) {
    console.error(`❌ STARTUP ASSERTION FAILED: ${assertionErr.message}`);
    console.error('Pipeline cannot proceed — critical file/module missing or corrupt.');
    process.exit(1);
  }

  try {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Step 1: Fetch from all sources
    console.log('📡 Step 1: Fetching jobs from all sources...');
    let _stepStart = Date.now();
    console.log('━'.repeat(60));

    // AGG-5 (S229): Overall timeout per fetcher. Prevents one hung API from blocking
    // the entire pipeline (Amazon API hung for 23 min on 2026-03-26T00:15 run).
    // Rolling window merge preserves prior-run jobs — skipping a source is safe.
    function withTimeout(promise, ms, label) {
      return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms/1000}s`)), ms))
      ]).catch(err => {
        console.error(`⚠️ ${label}: ${err.message} — continuing with 0 jobs`);
        return label.includes('ATS') ? { jobs: [], stats: { by_source: {}, by_company: {} } } : [];
      });
    }

    let allJobs = [];

    // Read previous counts (needed for initial-population detection) before fetch
    let prevAppleCount = 0, prevGoogleCount = 0, prevMicrosoftCount = 0;
    let prevAppleIds = new Set();
    let wdPreviousTotals = null;
    try {
      if (fs.existsSync(JOBS_OUTPUT_FILE)) {
        const content = fs.readFileSync(JOBS_OUTPUT_FILE, 'utf8');
        prevAppleCount = (content.match(/"source":"apple"/g) || []).length;
        prevGoogleCount = (content.match(/"source":"google"/g) || []).length;
        prevMicrosoftCount = (content.match(/"source":"microsoft"/g) || []).length;
        if (prevAppleCount > 0) {
          prevAppleIds = new Set((content.match(/"id":"apple-[^"]+"/g) || []).map(m => m.slice(6, -1)));
          console.log(`  Previous Apple count: ${prevAppleCount} (${prevAppleIds.size} IDs)`);
        }
        if (prevGoogleCount > 0) console.log(`  Previous Google count: ${prevGoogleCount}`);
        if (prevMicrosoftCount > 0) console.log(`  Previous Microsoft count: ${prevMicrosoftCount}`);
      }
    } catch (e) { /* first run */ }

    // AGG-SPEED-4: Load Microsoft description cache from seeded sidecar
    // IDs are extracted from descriptions-microsoft*.jsonl files in DATA_DIR
    let microsoftCachedIds = new Set();
    try {
      const msSidecarFiles = fs.readdirSync(DATA_DIR)
        .filter(f => f.startsWith('descriptions-microsoft') && f.endsWith('.jsonl'));
      for (const fname of msSidecarFiles) {
        const lines = fs.readFileSync(path.join(DATA_DIR, fname), 'utf8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try { const { id } = JSON.parse(line); if (id) microsoftCachedIds.add(id); } catch {}
        }
      }
      if (microsoftCachedIds.size > 0) console.log(`  Microsoft description cache: ${microsoftCachedIds.size} IDs`);
    } catch (e) { /* no cache yet */ }

    // AGG-FETCH-10: Load description caches from sidecar files.
    // Same pattern as Microsoft — avoids re-fetching detail pages every run.
    // Oracle only treats rich sidecars as cached; short listing snippets must
    // stay fetchable so responsibilities/qualifications can progressively land.
    function loadDescriptionCacheState(prefix, { minChars = 1, marker = null, trackShort = false } = {}) {
      const cachedIds = new Set();
      const priorityIds = new Set();
      try {
        const sidecarFiles = fs.readdirSync(DATA_DIR)
          .filter(f => f.startsWith(prefix) && f.endsWith('.jsonl'));
        for (const fname of sidecarFiles) {
          const lines = fs.readFileSync(path.join(DATA_DIR, fname), 'utf8').trim().split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const { id, description_text } = JSON.parse(line);
              const text = description_text || '';
              const rich = text.length >= minChars || (marker && marker.test(text));
              if (id && rich) cachedIds.add(id);
              else if (id && trackShort && text) priorityIds.add(id);
            } catch {}
          }
        }
        if (cachedIds.size > 0 || priorityIds.size > 0) {
          const source = prefix.replace('descriptions-', '');
          const cacheLabel = minChars > 1 ? `rich IDs (>=${minChars} chars or marker)` : 'IDs';
          const priorityLabel = priorityIds.size > 0 ? `, ${priorityIds.size} short sidecar IDs prioritized` : '';
          console.log(`  ${source} description cache: ${cachedIds.size} ${cacheLabel}${priorityLabel}`);
        }
      } catch (e) { /* no cache yet */ }
      return { cachedIds, priorityIds };
    }

    const googleCachedIds = loadDescriptionCacheState('descriptions-google').cachedIds;
    const appleCachedIds = loadDescriptionCacheState('descriptions-apple').cachedIds;
    const oracleCache = loadDescriptionCacheState('descriptions-oracle', { minChars: 2000, marker: /^(Responsibilities|Qualifications):/m, trackShort: true });
    // AGG-ORACLE-DEPT: also treat Oracle jobs whose department is already captured in the sidecar
    // as cached, so the detail-fetch budget (MAX_DETAIL_FETCHES) targets jobs still missing a
    // department. This drains the large short-sidecar pool progressively — tech-titled jobs get
    // captured first and drop out, letting US Oracle generals (low title score) rise into the
    // budget over successive runs instead of being permanently starved. Without this, generals
    // (the G1 target) are never reached because the pool is tech-front-loaded.
    try {
      const oracleSidecarFiles = fs.readdirSync(DATA_DIR)
        .filter(f => f.startsWith('descriptions-oracle') && f.endsWith('.jsonl'));
      const deptHavingIds = new Set();
      for (const fname of oracleSidecarFiles) {
        const lines = fs.readFileSync(path.join(DATA_DIR, fname), 'utf8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const { id, departments } = JSON.parse(line);
            if (id && Array.isArray(departments) && departments.length > 0) deptHavingIds.add(id);
          } catch (_) {}
        }
      }
      // AGG-ORACLE-DEPT FIX: loadDescriptionCacheState (line 977) caches ALL described Oracle
      // jobs — including generals that never captured a Category. Remove dept-less jobs from
      // the skip-list so they remain eligible for detail-fetch (the only source of Category).
      // Only keep jobs WITH departments cached (skip re-fetch, preserve the captured dept).
      // Without this, generals (the G1 target) are skipped forever → 0% department capture.
      let removed = 0;
      for (const id of oracleCache.cachedIds) {
        if (!deptHavingIds.has(id)) { oracleCache.cachedIds.delete(id); removed++; }
      }
      if (removed > 0) console.log(`  oracle dept cache: ${deptHavingIds.size} with dept (cached/skip), ${removed} dept-less → eligible for detail-fetch`);
    } catch (_) { /* no sidecar yet */ }


    // AGG-SPEED-2: Load WD totals cache from prior run
    const WD_TOTALS_CACHE = path.join(DATA_DIR, 'wd-totals-cache.json');
    try {
      if (fs.existsSync(WD_TOTALS_CACHE)) {
        wdPreviousTotals = JSON.parse(fs.readFileSync(WD_TOTALS_CACHE, 'utf8'));
        const cachedCount = Object.keys(wdPreviousTotals).length;
        if (cachedCount > 0) console.log(`  WD incremental cache: ${cachedCount} tenants`);
      }
    } catch (e) { /* first run or corrupt cache */ }
    // AGG-MAXJOBS-ROTATE-1: Load WD segment rotation cache
    const WD_SEGMENT_CACHE = path.join(DATA_DIR, 'wd-segment-cache.json');
    let wdSegmentCache = {};
    try {
      if (fs.existsSync(WD_SEGMENT_CACHE)) {
        wdSegmentCache = JSON.parse(fs.readFileSync(WD_SEGMENT_CACHE, 'utf8'));
        const rotated = Object.keys(wdSegmentCache).filter(k => wdSegmentCache[k] > 0).length;
        if (rotated > 0) console.log(`  WD segment cache: ${rotated} tenants with active rotation`);
      }
    } catch (e) { /* first run or corrupt cache */ }

    // Phase A+B: Run ATS and custom fetchers in parallel (AGG-SPEED-5)
    // ~5.5 min savings: max(PhaseA, PhaseB) instead of PhaseA + PhaseB
    console.log('  Phase A+B: ATS + custom fetchers (parallel)...');
    const [phaseAResult, ...phaseBSettled] = await Promise.allSettled([
      withTimeout(fetchFromAllATS({ wdPreviousTotals, wdSegmentCache }), 720_000, 'ATS'),
      withTimeout(fetchAllAmazonJobs(), 120_000, 'Amazon'),
      withTimeout(fetchAllNetflixJobs(), 60_000, 'Netflix'),
      HOTPATH_DEMOTED_FETCHERS.has('Apple')
        ? Promise.resolve([])
        : withTimeout(fetchAllAppleJobs({ previousJobCount: prevAppleCount, previousJobIds: prevAppleIds, cachedDescriptionIds: appleCachedIds, dataDir: DATA_DIR }), 1200_000, 'Apple'),
      withTimeout(fetchAllTwoSigmaJobs(), 120_000, 'Two Sigma'),
      withTimeout(fetchAllUberJobs(), 60_000, 'Uber'),
      HOTPATH_DEMOTED_FETCHERS.has('Google')
        ? Promise.resolve([])
        : withTimeout(fetchAllGoogleJobs({ previousJobCount: prevGoogleCount, cachedDescriptionIds: googleCachedIds, dataDir: DATA_DIR }), 600_000, 'Google'),
      // AGG-SIMPLIFY-EXIT-1: simplify fetcher REMOVED (source retired).
      HOTPATH_DEMOTED_FETCHERS.has('Microsoft')
        ? Promise.resolve([])
        : withTimeout(fetchAllMicrosoftJobs({ previousJobCount: prevMicrosoftCount, cachedDescriptionIds: microsoftCachedIds }), 600_000, 'Microsoft'),
      HOTPATH_DEMOTED_FETCHERS.has('Oracle')
        ? Promise.resolve([])
        : withTimeout(fetchAllOracleJobs(JSON.parse(fs.readFileSync(COMPANY_LIST_PATH, 'utf8')).oracle || undefined, { cachedDescriptionIds: oracleCache.cachedIds, priorityDescriptionIds: oracleCache.priorityIds }), 600_000, 'Oracle'),
      withTimeout(fetchAllAmdJobs(), 120_000, 'AMD'),
      HOTPATH_DEMOTED_FETCHERS.has('TikTok')
        ? Promise.resolve([])
        : withTimeout(fetchAllTiktokJobs(), 120_000, 'TikTok'),
      withTimeout(fetchAllDeshawJobs(), 30_000, 'D.E. Shaw'),
      // AGG-SIMPLIFY-EXIT-1: iCIMS fetcher DISABLED (returns 0 jobs from CI — HTML parsing
      // fails in GitHub Actions environment). PoC needs debugging before re-enabling.
      // withTimeout(fetchAllIcimsJobs([...tenants...]), 120_000, 'iCIMS'),
    ]);

    if (HOTPATH_DEMOTED_FETCHERS.size > 0) {
      console.log(`  AGG-HOTPATH-1: demoted from hot path -> ${[...HOTPATH_DEMOTED_FETCHERS].join(', ')}`);
    }

    // Collect ATS results
    const atsResult = phaseAResult.status === 'fulfilled' ? phaseAResult.value : { jobs: [] };
    appendAll(allJobs, atsResult.jobs);
    console.log(`  ATS: ${atsResult.jobs.length} jobs`);

    // AGG-SPEED-2: Save WD totals cache for next run
    if (atsResult.wdCurrentTotals && Object.keys(atsResult.wdCurrentTotals).length > 0) {
      fs.writeFileSync(WD_TOTALS_CACHE, JSON.stringify(atsResult.wdCurrentTotals, null, 2));
      console.log(`  WD totals cache saved: ${Object.keys(atsResult.wdCurrentTotals).length} tenants`);
    }
    // AGG-MAXJOBS-ROTATE-1: Save WD segment rotation cache
    if (atsResult.wdSegmentCache) {
      try { fs.writeFileSync(WD_SEGMENT_CACHE, JSON.stringify(atsResult.wdSegmentCache, null, 2)); } catch (e) {}
    }
    // AGG-WD-429MONITOR-1: Track WD rate-limit responses
    const wdRateLimited = atsResult.wdRateLimited || 0;
    if (wdRateLimited > 0) console.log(`   ⚠️  WD rate-limited (429): ${wdRateLimited} responses — investigate Cloudflare rules`);

    // Collect custom fetcher results
    const fetcherNames = ['Amazon', 'Netflix', 'Apple', 'Two Sigma', 'Uber', 'Google', 'Microsoft', 'Oracle', 'AMD', 'TikTok', 'D.E. Shaw'];
    const fetcherResults = {};
    phaseBSettled.forEach((result, i) => {
      const name = fetcherNames[i];
      const jobs = result.status === 'fulfilled' ? result.value : [];
      fetcherResults[name] = Array.isArray(jobs) ? jobs : [];
      appendAll(allJobs, fetcherResults[name]);
    });


    const supplementalInputs = loadSupplementalInputs();
    if (supplementalInputs.jobs.length > 0) {
      appendAll(allJobs, supplementalInputs.jobs);
      console.log(`  Supplemental lanes merged: ${supplementalInputs.jobs.length} jobs`);
      for (const [lane, info] of Object.entries(supplementalInputs.inputs)) {
        console.log(`   - ${lane}: ${info.jobs_loaded} jobs from supplemental artifact`);
      }
    }

    // Step 1a-post: apply cached Workday family/department mapping before tagging.
    const familyCacheReport = await applyFamilyCache(allJobs, JSON.parse(fs.readFileSync(COMPANY_LIST_PATH, 'utf8')).workday || [], DATA_DIR);
    stageTimings.step1a_family_cache_ms = familyCacheReport.durationMs;

    console.log('');
    console.log(`📊 Step 1 complete: ${allJobs.length} jobs fetched`);
    stageTimings.step1_fetch_ms = Date.now() - _stepStart;
    pipelineTimestamps.fetch_completed_at = new Date().toISOString();
    console.log(`   - ATS: ${atsResult.jobs.length} jobs`);
    for (const name of fetcherNames) {
      console.log(`   - ${name}: ${fetcherResults[name].length} jobs`);
    }

    // GAP-6: Compute zero-yield companies from raw fetch results (pre-filter).
    // Compares companies configured in company-list.json against companies that
    // produced jobs this run. A company returning 0 raw jobs may have a broken
    // slug, API change, or auth issue (LLNL incident class).
    const zeroYieldCompanies = computeZeroYield(atsResult, fetcherResults, COMPANY_LIST_PATH, atsResult.wdCurrentTotals);
    if (zeroYieldCom