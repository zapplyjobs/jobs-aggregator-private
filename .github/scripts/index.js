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

    // Phase A+B: Run ATS and custom fetchers in parallel (AGG-SPEED-5)
    // ~5.5 min savings: max(PhaseA, PhaseB) instead of PhaseA + PhaseB
    console.log('  Phase A+B: ATS + custom fetchers (parallel)...');
    const [phaseAResult, ...phaseBSettled] = await Promise.allSettled([
      withTimeout(fetchFromAllATS({ wdPreviousTotals }), 720_000, 'ATS'),
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
    if (zeroYieldCompanies.length > 0) {
      console.log(`   ⚠️  GAP-6: ${zeroYieldCompanies.length} companies returned 0 raw jobs`);
    }

    // AGG-PIPE-4: Build set of sources that fetched successfully this run.
    // Used by mergeCarryForward to detect closed jobs (source fetched OK, job absent = closed).
    const successfulSources = new Set();
    for (const [source, count] of Object.entries((atsResult.stats || {}).by_source || {})) {
      if (count > 0) successfulSources.add(source);
    }
    for (const [fetcherName, jobs] of Object.entries(fetcherResults)) {
      const sourceKey = FETCHER_NAME_TO_SOURCE[fetcherName] || fetcherName.toLowerCase();
      if (Array.isArray(jobs) && jobs.length > 0) successfulSources.add(sourceKey);
    }
    for (const source of supplementalInputs.sourcesUsed) {
      successfulSources.add(source);
    }
    if (successfulSources.size > 0) {
      console.log(`   🔍 AGG-PIPE-4: ${successfulSources.size} sources fetched successfully: ${[...successfulSources].join(', ')}`);
    }

    console.log('');

    // AGG-DESCCOVERAGE-1 (2026-07-05): Workday description fetch RE-ENABLED in the main run.
    // It was removed (AGG-HOTPATH-1) under runtime pressure, but runtime has since recovered
    // (~5-6 min wall, under the 8-min alert), and ~1,227 in-scope workday jobs were being dropped
    // by the bridge for lack of a description (the workday shard sat near-empty at 25 entries).
    // The fetcher self-caps at MAX_PER_RUN=200 (~80s), prioritizes US jobs, and caches via
    // descriptions-workday.jsonl (seeded from R2 + uploaded each run) -> backfills over ~2 days.
    // GUARD: monitor first runs' wall-time; revert to skipping if it breaches 8 min.
    const _skipDesc = process.env.SKIP_DESC_BACKFILL === '1';
    const wdJobs = allJobs.filter(j => j.source === 'workday');
    if (wdJobs.length > 0) {
      const wdDescriptions = await fetchWorkdayDescriptions(wdJobs, DATA_DIR, { skipFetch: _skipDesc });
      injectDescriptions(wdJobs, wdDescriptions, 'WD');
    } else {
      console.log('📄 Step 1b: No WD jobs this run — skipping description fetch');
    }
    const srJobs = allJobs.filter(j => j.source === 'smartrecruiters');
    if (srJobs.length > 0) {
      const srDescriptions = await fetchSRDescriptions(srJobs, DATA_DIR, { skipFetch: _skipDesc });
      injectDescriptions(srJobs, srDescriptions, 'SR');
    } else {
      console.log('📄 SR descriptions: No SmartRecruiters jobs this run — skipping description fetch');
    }
    console.log('');


    // Step 2: Enhance jobs (add fingerprints, employment_types arrays, etc.)
    console.log('🔄 Step 2: Enhancing jobs with required fields...');
    _stepStart = Date.now();
    console.log('━'.repeat(60));

    // Add missing fields (fingerprints, normalize employment_types to arrays)
    const helpers = require(`${SHARED}/utils/helpers`);
    const enhancedJobs = allJobs.map(job => {
      // Add fingerprint if missing
      if (!job.fingerprint) {
        job.fingerprint = helpers.generateFingerprint(job);
      }

      // AGG-DATA-13: Normalize employment_type/employment_types to canonical array (AGG-PIPE-13: shared constant)
      if (!job.employment_types) {
        const types = job.employment_type || [];
        if (Array.isArray(types)) {
          job.employment_types = types.map(t => EMPLOYMENT_NORMALIZE_MAP[String(t).toUpperCase()] || String(t).toUpperCase());
        } else if (typeof types === 'string') {
          job.employment_types = types.split(',').map(t => EMPLOYMENT_NORMALIZE_MAP[t.trim().toUpperCase()] || t.trim().toUpperCase());
        } else {
          job.employment_types = [];
        }
      } else {
        // Carry-forward: re-normalize existing array
        job.employment_types = job.employment_types.map(t => EMPLOYMENT_NORMALIZE_MAP[t] || t);
      }

      return job;
    });

    console.log('');
    console.log(`✅ Step 2 complete: ${enhancedJobs.length} jobs enhanced`);
    stageTimings.step2_enhance_ms = Date.now() - _stepStart;
    console.log('');

    // Step 3: Validate and fix malformed fields
    console.log('📝 Step 3: Validating and fixing malformed fields...');
    _stepStart = Date.now();
    console.log('━'.repeat(60));

    const { validJobs, invalidJobs, metrics: validationMetrics } = validateAndNormalizeJobs(enhancedJobs);

    console.log('');
    printValidationSummary(validationMetrics);
    console.log('');
    console.log(`✅ Step 3 complete: ${validJobs.length} valid jobs (${invalidJobs.length} filtered)`);
    stageTimings.step3_validate_ms = Date.now() - _stepStart;
    console.log('');

    // Step 4: Filter senior jobs
    console.log('🎓 Step 4: Filtering senior-level jobs...');
    _stepStart = Date.now();
    console.log('━'.repeat(60));

    // INF-EXPAND-1 Phase 2 (Option D, 2026-07-09): pipeline senior filter BYPASSED. All jobs enter
    // the main pool; each consumer filters by tags.employment itself (6 GitHub boards + Discord =
    // Phase 1 filters LIVE; zapply.jobs = isEarlyCareerJob; softwarejobs.dev = all-levels by design).
    // filterSeniorJobs + senior-filter.js are KEPT for reference/rollback + observability: we still
    // call it to MEASURE what would be filtered, but validJobs is the pool and seniorJobs is empty
    // (so the shadow feed + seniorUsFold become no-ops — no double-count into us_jobs).
    const _filterResult = filterSeniorJobs(validJobs, companyOverrideMap);
    const entryLevelJobs = validJobs;
    const seniorJobs = [];
    const seniorFilterMetrics = _filterResult.metrics;
    const _wouldBeSenior = _filterResult.seniorJobs.length;

    console.log('');
    printSeniorFilterSummary(seniorFilterMetrics);
    console.log('');
    const overrideCount = seniorFilterMetrics.override_applied || 0;
    console.log(`✅ Step 4 complete (Phase 2: senior filter BYPASSED): ${entryLevelJobs.length} jobs enter pool (all levels; ${_wouldBeSenior} would-have-been-senior → flow to consumers that filter)`);
    stageTimings.step4_filter_ms = Date.now() - _stepStart;
    console.log('');

    // Step 4b: Write senior-filter analytics summary (PIPELINE-1)
    // Summary counts only — full job objects are ~180 MB and exceed GitHub's 100 MB limit.
    // Tags not yet available (Step 5), so breakdown is by source only.
    const FILTERED_OUTPUT_FILE = path.join(DATA_DIR, 'filtered_jobs.json');
    const seniorBySource = {};
    for (const job of seniorJobs) {
      seniorBySource[job.source || 'unknown'] = (seniorBySource[job.source || 'unknown'] || 0) + 1;
    }

    // AGG-SELF-4 Check C: FP rate tracking for trend alerting
    let fpStats = { sample_size: 0, potential_fp_count: 0, fp_rate_pct: '0.0' };
    // AGG-DATA-8 / AGG-PIPE-11: Sample 500 filtered jobs for false-positive measurement.
    // 500 jobs gives ±4.3pp CI (vs ±14pp with 50). File rotated weekly (7-day TTL).
    {
      const SAMPLE_SIZE = 500;
      const SAMPLES_FILE = path.join(DATA_DIR, 'filtered-samples.jsonl');
      const now = new Date();

      // Rotate: remove entries older than 7 days
      let existingLines = [];
      if (fs.existsSync(SAMPLES_FILE)) {
        const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        existingLines = fs.readFileSync(SAMPLES_FILE, 'utf8').trim().split('\n')
          .filter(line => { try { return JSON.parse(line).sampled_at >= cutoff; } catch { return false; } });
      }

      // Random sample without bias (Fisher-Yates partial shuffle)
      const sampleIndices = [];
      if (seniorJobs.length <= SAMPLE_SIZE) {
        sampleIndices.push(...Array.from({ length: seniorJobs.length }, (_, i) => i));
      } else {
        const pool = Array.from({ length: seniorJobs.length }, (_, i) => i);
        for (let i = 0; i < SAMPLE_SIZE; i++) {
          const j = i + Math.floor(Math.random() * (pool.length - i));
          [pool[i], pool[j]] = [pool[j], pool[i]];
          sampleIndices.push(pool[i]);
        }
      }

      // AGG-PIPE-11: Flag potential FPs — jobs where title has no senior keyword.
      // Not definitive (could be filtered by experience in description), but surfaces
      // likely FPs for review. A high potential_fp rate warrants investigation.
      const SENIOR_TITLE_RE = /\b(senior|sr\.?|lead|principal|staff|director|vp|vice president|head of|chief|manager|mgr\.?)\b/i;

      const newSamples = sampleIndices.map(idx => {
        const job = seniorJobs[idx];
        const hasSeniorKeyword = SENIOR_TITLE_RE.test(job.title || '');
        return {
          sampled_at: now.toISOString(),
          id: job.id,
          title: job.title,
          company_name: job.company_name,
          source: job.source,
          location: job.location || null,
          filter_reason: job._filter_reason || 'unknown',
          potential_fp: !hasSeniorKeyword,
        };
      });

      const fpCount = newSamples.filter(s => s.potential_fp).length;
      const fpRate = newSamples.length > 0 ? (fpCount / newSamples.length * 100).toFixed(1) : '0.0';
      console.log(`📋 FP estimate: ${fpCount}/${newSamples.length} (${fpRate}%) potential false positives in sample`);
      fpStats = { sample_size: newSamples.length, potential_fp_count: fpCount, fp_rate_pct: fpRate };

      const allLines = [...existingLines, ...newSamples.map(s => JSON.stringify(s))];
      fs.writeFileSync(SAMPLES_FILE, allLines.join('\n') + '\n', 'utf8');
      console.log(`📋 Step 4b-2: Filtered samples → filtered-samples.jsonl (${newSamples.length} sampled, ${allLines.length} total)`);
    }

    // Write summary AFTER fpStats is computed
    const filteredSummary = {
      generated: new Date().toISOString(),
      total_senior_filtered: seniorJobs.length,
      by_source: seniorBySource,
      ...fpStats,
    };
    fs.writeFileSync(FILTERED_OUTPUT_FILE, JSON.stringify(filteredSummary, null, 2), 'utf8');
    console.log(`📋 Step 4b: Senior-filter summary → filtered_jobs.json (${seniorJobs.length} total)`);

    console.log('');

    // Step 4c: Inject descriptions from ALL sidecar files for tag engine's description fallback.
    // Carried-forward jobs lose their inline descriptions in Step 9 (stripped from all_jobs.json).
    // This re-injects them from per-source sidecar files so the description-fallback layer can classify.
    // Guard: !job.description prevents double-injection for freshly-fetched jobs with inline descriptions.
    // TAG-9 S237: expanded from enriched-only to ALL sidecars — 1,317 additional jobs gain descriptions.
    const descSidecarFiles = fs.readdirSync(DATA_DIR)
      .filter(f => f.startsWith('descriptions-') && f.endsWith('.jsonl'));
    if (descSidecarFiles.length > 0) {
      const descMap = new Map();
      const deptMap = new Map();   // AGG-ORACLE-DEPT: id -> departments[] (persisted capture)
      for (const fname of descSidecarFiles) {
        const fpath = path.join(DATA_DIR, fname);
        const descLines = fs.readFileSync(fpath, 'utf8').trim().split('\n').filter(Boolean);
        for (const line of descLines) {
          try {
            const { id, description_text, departments } = JSON.parse(line);
            if (id && description_text) descMap.set(id, description_text);
            if (id && Array.isArray(departments) && departments.length > 0) deptMap.set(id, departments);
          } catch { /* skip malformed */ }
        }
      }
      let injected = 0;
      for (const job of entryLevelJobs) {
        if (!job.description && descMap.has(job.id)) {
          job.description = descMap.get(job.id);
          injected++;
        }
      }
      // AGG-ORACLE-DEPT: re-inject persisted departments for jobs not detail-fetched this run
      // (description-cache-skipped or carry-forward). normalizeOracleJob only sees detailJob on
      // the single run a job is fetched, so without this the captured department is lost and the
      // job reverts to "general" on every later run.
      let deptInjected = 0;
      for (const job of entryLevelJobs) {
        if ((!job.departments || job.departments.length === 0) && deptMap.has(job.id)) {
          job.departments = deptMap.get(job.id);
          deptInjected++;
        }
      }
      console.log(`📄 Step 4c: Injected ${injected} descriptions from ${descSidecarFiles.length} sidecar files (${descMap.size} available)${deptInjected > 0 ? `; re-injected ${deptInjected} persisted Oracle departments` : ''}`);
    } else {
      console.log('📄 Step 4c: No description sidecar files found — description fallback inactive');
    }
    console.log('');

    // Step 5: Apply tags
    console.log('🏷️  Step 5: Applying tags...');
    _stepStart = Date.now();
    console.log('━'.repeat(60));

    const taggedJobs = tagJobs(entryLevelJobs);

    console.log(`✅ Step 5 complete: ${taggedJobs.length} jobs tagged`);
    stageTimings.step5_tag_ms = Date.now() - _stepStart;
    console.log('');

    // Step 6: Deduplicate
    console.log('🔍 Step 6: Deduplicating jobs...');
    _stepStart = Date.now();
    console.log('━'.repeat(60));

    const { unique: dedupedJobs, duplicates, stats: dedupeStats } = deduplicateJobs(taggedJobs);

    console.log('');
    console.log(`✅ Step 6 complete: ${dedupedJobs.length} unique jobs (${duplicates} duplicates removed)`);
    stageTimings.step6_dedup_ms = Date.now() - _stepStart;
    console.log('');

    // Step 7: Tag statistics deferred to post-merge (after Step 9).
    // Previously computed from dedupedJobs (current-run only), missing ~4K carry-forward jobs.
    // Now computed after carry-forward merge + AGG-32 stale filter for full-pool accuracy.
    console.log('📊 Step 7: Tag statistics deferred to post-merge');

    let tagStats = null;
    console.log('');

    // Step 8: Sort by date (newest first)
    console.log('📊 Step 8: Sorting jobs by date...');
    _stepStart = Date.now();
    console.log('━'.repeat(60));

    const sortedJobs = dedupedJobs.sort((a, b) => {
      const dateA = new Date(a.posted_at || 0);
      const dateB = new Date(b.posted_at || 0);
      return dateB - dateA; // Newest first
    });

    console.log(`✅ Step 8 complete: Jobs sorted`);
    stageTimings.step8_sort_ms = Date.now() - _stepStart;
    console.log('');

    // Step 8b: Write per-source description sidecars (AGG-PIPE-13: extracted to sidecar-writer.js)
    console.log('📄 Step 8b: Writing description sidecars...');
    _stepStart = Date.now();
    const { writtenFiles: sidecarFiles, stats: sidecarStats, removedFiles: sidecarRemoved } = writeSidecars(sortedJobs, DATA_DIR);
    // R2-prune manifest (AGG-R2-SINGLEFILE-1): list sidecar files removed locally as stale
    // so the publish step can delete the superseded R2 copies. Always (re)write or clear it
    // so a prior run's manifest never causes spurious deletes on a clean run.
    const _removedManifest = path.join(DATA_DIR, '.sidecar-removed.json');
    if (sidecarRemoved && sidecarRemoved.size > 0) {
      fs.writeFileSync(_removedManifest, JSON.stringify([...sidecarRemoved]));
      console.log(`🗑️  R2-prune manifest: ${sidecarRemoved.size} stale sidecar file(s) queued for R2 deletion`);
    } else {
      try { fs.unlinkSync(_removedManifest); } catch (_) {}
    }
    stageTimings.step8b_sidecars_ms = Date.now() - _stepStart;
    pipelineTimestamps.sidecars_written_at = new Date().toISOString();
    console.log('');
    // AGG-SALARY-TEXT-INTEGRATION-1: Extract salary from description text for jobs
    // without structured salary (ashby/lever already have it from the fetcher).
    // ENR built + tested fromDescription() (30 tests, <0.3% false-positive).
    // Runs before STRIP_FIELDS so descriptions are still on the job objects.
    const _salaryStart = Date.now();
    let _descSalaryCount = 0;
    for (const job of sortedJobs) {
      if (job.salaryMin == null && job.description) {
        const plainText = typeof job.description === 'string'
          ? job.description.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ')
          : '';
        const extracted = fromDescription(plainText);
        if (extracted.salaryMin != null) {
          job.salaryMin = extracted.salaryMin;
          job.salaryMax = extracted.salaryMax;
          job.salaryCurrency = extracted.salaryCurrency;
          _descSalaryCount++;
        }
      }
    }
    console.log(`💰 Step 8c: Salary from description text — ${_descSalaryCount} jobs extracted (${((Date.now() - _salaryStart) / 1000).toFixed(1)}s)`);

    // Step 9: Write output files
    console.log('💾 Step 9: Writing output files...');
    _stepStart = Date.now();
    console.log('━'.repeat(60));

    // Strip pipeline internals before writing public output file
    // (source_url, source_id, _raw are internal — not needed downstream)
    // Note: 'source' is kept for downstream observability (which ATS produced each job)
    const STRIP_FIELDS = ['source_url', '_raw', 'description', 'enriched', 'enriched_at', 'is_internship', 'is_new_grad', 'is_us_only', 'remote'];
    let publicJobs = sortedJobs.map(job => {
      const stripped = { ...job };
      for (const field of STRIP_FIELDS) {
        delete stripped[field];
      }
      return stripped;
    });

    // Merge previous all_jobs.json into current run (rolling window — TTL from deduplicator)
    // Jobs from prior runs that weren't re-fetched this run are preserved until their TTL expires.
    if (fs.existsSync(JOBS_OUTPUT_FILE)) {
      const currentIds = new Set(publicJobs.map(j => j.id));
      // Fingerprint guard: prevents re-injection of jobs that changed ID (e.g. WD-ID-BUG fix)
      const currentFingerprints = new Set(publicJobs.map(j => j.fingerprint).filter(Boolean));
      const prevLines = fs.readFileSync(JOBS_OUTPUT_FILE, 'utf8').trim().split('\n').filter(Boolean);

      // AGG-32: Filter stale jobs by posted_at TTL
      resolvePostedAt(publicJobs, prevLines);

      mergeCarryForward(publicJobs, prevLines, currentIds, currentFingerprints, STRIP_FIELDS, successfulSources, atsResult.health || {});
    }

    for (const job of publicJobs) {
      delete job.source_updated_at;
    }

    // AGG-STALEUPSTREAM-1 (2026-07-04): orphan cleanup pass — drop defunct-tenant jobs (company no longer
    // in active workday/smartrecruiters config + not fetched >14d). Runs BEFORE the freshness metric so
    // the metric reflects post-cleanup state.
    {
      const _cl = JSON.parse(fs.readFileSync(COMPANY_LIST_PATH, 'utf8'));
      const _activeWd = new Set((_cl.workday || []).map(e => e.name));
      const _activeSR = new Set((_cl.smartrecruiters || []).map(e => e.name));
      const _orphanDropped = dropOrphanJobs(publicJobs, _activeWd, _activeSR);
      if (_orphanDropped > 0) console.log(`🧹 AGG-STALEUPSTREAM-1: dropped ${_orphanDropped} ORPHAN jobs upstream (company no longer in active workday/smartrecruiters config + not fetched >14d) — no longer reach all_jobs/R2/consumers.`);
    }

    // AGG-STALEUPSTREAM-1 (2026-07-04): Freshness SLA metric — make the stale-candidate residue's age
    // VISIBLE every run. The 4.6-day silent rot recurred because nothing measured this; if p50/max climb,
    // the rotate sweep is losing coverage and closed jobs are lingering again — investigate.
    const _staleResidue = publicJobs.filter(j => j?.tags?.lifecycle_state === 'stale-candidate');
    if (_staleResidue.length > 0) {
      const _agesH = _staleResidue.map(j => j.fetched_at ? (Date.now() - new Date(j.fetched_at).getTime()) / 3600000 : null)
                                  .filter(a => a != null && !isNaN(a)).sort((a, b) => a - b);
      if (_agesH.length > 0) {
        const _pct = p => _agesH[Math.min(_agesH.length - 1, Math.floor(p * _agesH.length))];
        const _p50 = _pct(0.5), _p90 = _pct(0.9), _max = _agesH[_agesH.length - 1];
        console.log(`📊 FRESHNESS SLA: ${_staleResidue.length} stale-candidate in pool | age(h) p50=${_p50.toFixed(1)} p90=${_p90.toFixed(1)} max=${_max.toFixed(1)} — investigate if p50/max climb (rotate-coverage-gap signal)`);
        // AGG-STALEUPSTREAM-1: breach check -> write freshness-status.json for the workflow alert step.
        // Thresholds dry-run-validated (recent runs: normal p50=1.2-1.9h, max=13.7d). Alert at p50>12h
        // (bulk staleness = rotate/cleanup degradation) OR max>15d/360h (orphan/carry-forward past the bound).
        const _ALERT_P50_H = 12, _ALERT_MAX_H = 360;
        let _breached = false, _reason = '';
        if (_p50 > _ALERT_P50_H) { _breached = true; _reason = `p50 ${_p50.toFixed(1)}h > ${_ALERT_P50_H}h (bulk staleness — rotate/cleanup degradation?)`; }
        else if (_max > _ALERT_MAX_H) { _breached = true; _reason = `max ${_max.toFixed(1)}h > ${_ALERT_MAX_H}h/15d (orphan/carry-forward past the bound — cleanup broken?)`; }
        try { fs.writeFileSync(path.join(DATA_DIR, 'freshness-status.json'), JSON.stringify({ breached: _breached, reason: _reason, p50: +_p50.toFixed(1), p90: +_p90.toFixed(1), max: +_max.toFixed(1), staleCount: _staleResidue.length, checkedAt: new Date().toISOString() }, null, 2)); } catch (e) { console.log(`   (freshness-status.json write skipped: ${e.message})`); }
        if (_breached) console.log(`⚠️  FRESHNESS ALERT (AGG-STALEUPSTREAM-1): ${_reason} — staleness bound breached; investigate rotate coverage + orphan cleanup.`);
      }
    }

    // Generate tag stats from full pool (post-merge + post-AGG-32 filter).
    tagStats = computeFullPoolTagStats(publicJobs);

    // Tag monitoring diagnostics (AGG-PIPE-13: extracted to monitoring.js)
    const monitoringReports = runTagMonitoring(publicJobs, tagStats, {
      dataDir: DATA_DIR,
      checkTagDrift, printDriftReport,
      tagDomainsFn: tagDomains,
      checkDomainPrecision, printPrecisionReport,
      checkKeywordHealth, checkKeywordOverlap,
      getKeywordMap, tagEngineVersion: TAG_ENGINE_VERSION,
      seniorJobs, companyOverrideMap,
    });
    ({ tagDriftReport, tagPrecisionReport, keywordHealthReport, keywordOverlapReport } = monitoringReports);

    // Archive expiring jobs BEFORE overwriting all_jobs.json
    const { getExpiringJobs, appendToWeeklyArchive, appendToDailyArchive } = require(`${SHARED}/utils/archiver`);
    const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
    const expiringJobs = getExpiringJobs(JOBS_OUTPUT_FILE, publicJobs);
    if (expiringJobs.length > 0) {
      const weeklyFile = appendToWeeklyArchive(expiringJobs, ARCHIVE_DIR);
      const dailyFile = appendToDailyArchive(expiringJobs, ARCHIVE_DIR);
      console.log(`📦 Archived ${expiringJobs.length} expiring jobs → weekly: ${path.basename(weeklyFile)}, daily: ${path.basename(dailyFile)}`);
    } else {
      console.log('📦 No expiring jobs this run');
    }

    // AGG-PIPE-10: RETIRED for EXPAND-1 Phase 2 (2026-07-09). Was a write-step safety filter that
    // removed senior-TAGGED jobs (catching seniors Step 4's title/experience filter missed).
    // Post-Phase-2 the pipeline senior filter is removed ENTIRELY — all jobs enter the pool;
    // CONSUMERS filter by tags.employment (6 GitHub boards + Discord Phase 1; zapply.jobs
    // isEarlyCareerJob; softwarejobs.dev all-levels by design — WANTS seniors). Keeping this
    // filter would starve softwarejobs.dev's all-levels board + duplicate the consumer filters.
    // Count for observability only (no removal):
    const seniorTaggedInPool = publicJobs.filter(job => job.tags?.employment === 'senior').length;
    if (seniorTaggedInPool > 0) {
      console.log(`📊 AGG-PIPE-10 (Phase 2: filter RETIRED): ${seniorTaggedInPool} senior-tagged jobs remain in pool → consumers filter`);
    }

    // Write jobs (JSONL format)
    await writeJobsJSONL(publicJobs, JOBS_OUTPUT_FILE);

    const usJobs = buildUsSnapshotJobs(publicJobs);

    // AGG-SEN-DATAFOLD (board 2026-06-23): fold a ≤14-day US senior-tech subset into us_jobs so
    // softwarejobs.dev's Senior filter has data (OUT verified the Senior UI/filter is correct; the
    // gap was data-only — us_jobs had 0 senior rows). Sourced from the Step-4 seniorJobs partition
    // (same as the senior-tech feed); windowed to ≤14d + US + tech domains to bound size/freshness.
    // Schema matches us_jobs (lean via stripFeedInternal — same STRIP_FIELDS as all_jobs). Best-effort.
    let seniorUsFold = [];
    try {
      const foldWindowMs = 14 * 24 * 3600 * 1000;
      const foldNow = Date.now();
      seniorUsFold = tagJobs(seniorJobs)
        .filter(j => {
          const doms = j.tags?.domains || [], locs = j.tags?.locations || [];
          return doms.some(d => SENIOR_TECH_DOMAINS.includes(d))
              && locs.includes('us')
              && j.posted_at && (foldNow - Date.parse(j.posted_at)) <= foldWindowMs;
        })
        .map(stripFeedInternal);
    } catch (e) {
      console.warn(`⚠️ AGG-SEN-DATAFOLD: senior fold failed (non-blocking): ${e.message}`);
    }
    const usJobsWithSenior = usJobs.concat(seniorUsFold);
    await writeJobsJSONL(usJobsWithSenior, US_JOBS_OUTPUT_FILE);
    console.log(`🇺🇸 AGG-US-SNAPSHOT-1 + SEN-DATAFOLD: Wrote ${usJobsWithSenior.length} US jobs to us_jobs.json (entry-level ${usJobs.length} + ≤14d senior-tech ${seniorUsFold.length})`);

    // INF-FEED-1: mid-level tech shadow feed (additive; no consumer depends on it yet)
    const midLevelTechFeed = buildMidLevelTechFeed(publicJobs);
    await writeJobsJSONL(midLevelTechFeed, MID_LEVEL_TECH_FILE);
    fs.writeFileSync(MID_LEVEL_TECH_SUMMARY_FILE, JSON.stringify(buildMidLevelTechSummary(midLevelTechFeed, publicJobs.length), null, 2) + '\n', 'utf8');
    console.log(`💼 INF-FEED-1: Wrote ${midLevelTechFeed.length} mid-level tech jobs (shadow feed) → mid-level-tech-jobs.jsonl`);

    // AGG-SEN-FILTERKNOB-1: senior-tech shadow feed (additive; mirrors INF-FEED-1).
    // seniorJobs are untagged at Step 4 (tag-engine runs at Step 5 on entryLevelJobs only), so
    // tag the partition here to make the feed queryable. Best-effort: a shadow feed must never
    // block the main pipeline. Main pool (all_jobs) is untouched — parity by construction.
    try {
      const taggedSeniorJobs = tagJobs(seniorJobs);
      const seniorTechFeed = buildSeniorTechFeed(taggedSeniorJobs);
      await writeJobsJSONL(seniorTechFeed, SENIOR_TECH_FILE);
      fs.writeFileSync(SENIOR_TECH_SUMMARY_FILE, JSON.stringify(buildSeniorTechSummary(seniorTechFeed, seniorJobs.length), null, 2) + '\n', 'utf8');
      console.log(`👔 AGG-SEN-FILTERKNOB-1: Wrote ${seniorTechFeed.length} senior tech jobs (shadow feed) → senior-tech-jobs.jsonl (of ${seniorJobs.length} senior-filtered)`);
    } catch (e) {
      // Empty-file fallback: these two files are in the workflow's REQUIRED R2 upload list, so
      // they must ALWAYS exist (empty is acceptable on failure) — a shadow feed must never block
      // the main pipeline or fail the required R2 upload. source_total stays accurate via
      // seniorJobs.length. (tagJobs is proven at Step 5, so reaching here is defense-in-depth.)
      await writeJobsJSONL([], SENIOR_TECH_FILE);
      fs.writeFileSync(SENIOR_TECH_SUMMARY_FILE, JSON.stringify(buildSeniorTechSummary([], seniorJobs.length), null, 2) + '\n', 'utf8');
      console.warn(`⚠️ AGG-SEN-FILTERKNOB-1: senior-tech feed failed, wrote EMPTY (non-blocking): ${e.message}`);
    }

    // CANADA-LANE: tag-driven additive shadow feed (additive; zero US-path impact — the US snapshot
    // and all_jobs are already written above, untouched). Empty-file fallback: these three files
    // are in the workflow's REQUIRED R2 upload list, so they must ALWAYS exist (empty is acceptable
    // on failure) — a shadow feed must never block the pipeline or fail the required R2 upload
    // (A196 lesson). A sentinel FP failure degrades to empty feeds + a warning, NOT a pipeline crash.
    try {
      await writeCanadaTechFeed(publicJobs);
      await writeCanadaInternshipsFeed(publicJobs);
    } catch (e) {
      await writeJobsJSONL([], CANADA_TECH_JOBS_OUTPUT_FILE);
      await writeJobsJSONL([], CANADA_TECH_INTERNSHIPS_OUTPUT_FILE);
      const degraded = {
        contract_version: 'canada-tech-feed-v1',
        generated_at: new Date().toISOString(),
        degraded: true,
        error: e.message,
        total_jobs: publicJobs.length,
        canada_jobs: 0, canada_tech_jobs: 0, canada_internships: 0, canada_tech_internships: 0,
        included_domains: [...CANADA_TECH_DOMAINS],
        by_domain: {}, by_source: {}, top_companies: [],
        sentinel_false_positive_checks: { contract_version: 'canada-tech-feed-v1', passed: false, checks: { degraded: true }, suspicious_us_only_samples: [] },
      };
      await writeMetadata(degraded, CANADA_TECH_SUMMARY_OUTPUT_FILE);
      console.warn(`⚠️ CANADA-LANE: feed build failed, wrote EMPTY fallbacks (non-blocking): ${e.message}`);
    }
    // CANADA-LANE (all-Canada, AGG-CANADAFEED-1): additive shadow feed — all canada jobs (tech-prioritized).
    // Independent try/catch so an all-feed failure cannot affect the tech feeds (or vice versa).
    try {
      await writeCanadaAllFeed(publicJobs);
    } catch (e) {
      await writeJobsJSONL([], CANADA_ALL_JOBS_OUTPUT_FILE);
      const degradedAll = {
        contract_version: 'canada-all-feed-v1', generated_at: new Date().toISOString(), degraded: true,
        error: e.message, total_jobs: publicJobs.length, canada_jobs: 0, canada_tech_jobs: 0, canada_non_tech_jobs: 0,
        by_domain: {}, by_source: {}, top_companies: [],
        sentinel_false_positive_checks: { contract_version: 'canada-all-feed-v1', passed: false, checks: { degraded: true }, suspicious_us_only_samples: [] },
      };
      await writeMetadata(degradedAll, CANADA_ALL_SUMMARY_OUTPUT_FILE);
      console.warn(`⚠️ CANADA-LANE (all): all-canada feed failed, wrote EMPTY fallback (non-blocking): ${e.message}`);
    }
    // INF-CANADA-INTERNSHIP-FEED-1: broad Canada internships (all domains, not just tech)
    try {
      await writeCanadaAllInternshipsFeed(publicJobs);
    } catch (e) {
      await writeJobsJSONL([], CANADA_ALL_INTERNSHIPS_OUTPUT_FILE);
      console.warn(`⚠️ CANADA-LANE: all-internships feed failed, wrote EMPTY fallback (non-blocking): ${e.message}`);
    }

    // Write metadata
    // Use publicJobs (full 7-day rolling window) for pool-level stats (by_source, top_companies, freshness).
    // sortedJobs is current-run only — stats must use publicJobs (full 7-day window).
    const duration = Date.now() - startTime;
    stageTimings.step9_write_ms = Date.now() - _stepStart;
    pipelineTimestamps.output_ready_at = new Date().toISOString();
    // Build fetch_results: per-source counts from current fetch attempts (before carry-forward).
    // Demoted hot-path sources are intentionally absent: they were not attempted in this
    // workflow, so reporting 0 would create a false "source fetch failure" alert.
    const fetchResults = {};
    for (const [source, count] of Object.entries((atsResult.stats || {}).by_source || {})) {
      if (count > 0) fetchResults[source] = (fetchResults[source] || 0) + count;
    }
    for (const [fetcherName, jobs] of Object.entries(fetcherResults)) {
      if (HOTPATH_DEMOTED_FETCHERS.has(fetcherName)) continue;
      const sourceKey = FETCHER_NAME_TO_SOURCE[fetcherName] || fetcherName.toLowerCase();
      fetchResults[sourceKey] = Array.isArray(jobs) ? jobs.length : 0;
    }

    // AGG-FETCH-14: Build fetcher_health from ATS + custom fetcher results.
    // Enables check-19 to classify zero-yield companies without HTTP probing.
    const fetcherHealth = {};
    const healthNow = new Date().toISOString();
    // ATS health (from ats-fetcher.js)
    if (atsResult.health) {
      Object.assign(fetcherHealth, atsResult.health);
    }
    // Custom fetcher health. Demoted sources are marked as skipped, not zero:
    // "zero" means attempted successfully and returned no jobs.
    for (let i = 0; i < fetcherNames.length; i++) {
      const name = fetcherNames[i];
      const source = FETCHER_NAME_TO_SOURCE[name] || name.toLowerCase();
      if (HOTPATH_DEMOTED_FETCHERS.has(name)) {
        fetcherHealth[name] = {
          status: 'skipped',
          source,
          jobs: null,
          reason: 'hot_path_demoted',
          timestamp: healthNow,
        };
        continue;
      }
      const result = phaseBSettled[i];
      if (!result) continue;
      const jobs = result.status === 'fulfilled' ? result.value : [];
      const count = Array.isArray(jobs) ? jobs.length : 0;
      fetcherHealth[name] = {
        status: result.status === 'rejected' ? 'error' : count > 0 ? 'alive' : 'zero',
        source,
        jobs: count,
        timestamp: healthNow,
        ...(result.status === 'rejected' ? { detail: result.reason?.message } : {}),
      };
    }

    const metadata = generateMetadata({
      startTime,
      jobs: publicJobs,
      uniqueCount: dedupedJobs.length,
      duplicateCount: duplicates,
      duration,
      tagStats,
      validationMetrics,
      seniorFilterMetrics,
      seniorJobs,
      zeroYieldCompanies,
      stageTimings,
      pipelineTimestamps,
      tagDriftReport,
      tagPrecisionReport,
      keywordHealthReport,
      keywordOverlapReport,
      fpStats,
      fetchResults,
      fetcherHealth,
      supplementalInputs: supplementalInputs.inputs,
    });
    await writeMetadata(metadata, METADATA_OUTPUT_FILE);

    // Step 9c: build / refresh Workday family cache for future runs. Output is already written, so
    // cache refresh cannot block user-visible publish correctness.
    if (!isDryRun && !SKIP_WD_FAMILY_CACHE_BUILD) {
      const familyCacheBuildReport = await buildFamilyCache(JSON.parse(fs.readFileSync(COMPANY_LIST_PATH, 'utf8')).workday || [], DATA_DIR);
      stageTimings.step9c_family_cache_build_ms = familyCacheBuildReport.durationMs;
    } else {
      stageTimings.step9c_family_cache_build_ms = 0;
      const reason = isDryRun ? 'dry run' : 'SKIP_WD_FAMILY_CACHE_BUILD=1';
      console.log(`⏭️  Step 9c: Skipping Workday family cache build (${reason})`);
    }

    console.log('');
    console.log(`✅ Step 9 complete: Output files written`);
    console.log('');
    // Step 9d: Unified cache pruning (AGG-CACHE-PRUNE-1).
    // Bounds ALL description sidecars to the current pool — evicts entries for retired/dropped jobs.
    // One mechanism covers every descriptions-*.jsonl file, present and future.
    if (!isDryRun) {
      _stepStart = Date.now();
      const validIds = new Set(sortedJobs.map(j => j.id));
      let totalPruned = 0;
      let filesPruned = 0;
      for (const fname of fs.readdirSync(DATA_DIR)) {
        if (!/^descriptions-.+\.jsonl$/.test(fname)) continue;
        // AGG-DESC-SPEED-1: workday descriptions are NOT pruned by Step 9d. The workday
        // pool has ~35K jobs; the cache is naturally bounded at that size (~20MB). Both
        // Step 9d (uses post-filter sortedJobs) and the fetcher's own pruning (uses
        // current-run-only pool) are too narrow — they prune valid descriptions for
        // carry-forward and filtered-out jobs, causing oscillation. No pruning = stable growth.
        if (fname === 'descriptions-workday.jsonl') continue;
        const fp = path.join(DATA_DIR, fname);
        try {
          const lines = fs.readFileSync(fp, 'utf8').trim().split('\n').filter(Boolean);
          if (lines.length === 0) continue;
          const kept = [];
          let pruned = 0;
          for (const line of lines) {
            try {
              const { id } = JSON.parse(line);
              if (id && validIds.has(id)) kept.push(line);
              else pruned++;
            } catch { pruned++; } // malformed line → drop
          }
          // Only rewrite if we actually pruned something (avoid unnecessary I/O)
          if (pruned > 0) {
            const beforeKB = Math.round(lines.length * 200 / 1024); // rough estimate
            fs.writeFileSync(fp, kept.join('\n') + '\n', 'utf8');
            totalPruned += pruned;
            filesPruned++;
            console.log(`  🧹 ${fname}: pruned ${pruned} stale entries (${lines.length}→${kept.length})`);
          }
        } catch (e) { /* skip unreadable file */ }
      }
      if (totalPruned > 0) {
        console.log(`✅ Step 9d: Cache pruned ${totalPruned} stale entries across ${filesPruned} sidecar file(s)`);
      } else {
        console.log(`✅ Step 9d: Cache pruning — all sidecars clean (0 stale entries)`);
      }
      stageTimings.step9d_cache_prune_ms = Date.now() - _stepStart;
    } else {
      console.log('⏭️  Step 9d: Skipping cache pruning (dry run)');
    }


    // Step 10: Print summary
    printSummary(sortedJobs, dedupedJobs.length, duplicates, duration);

    // Step 11: Print tag distribution
    printTagDistribution(sortedJobs);

    // Step 12 REMOVED (AGG-R2-CANONICAL-1, 2026-07-06): git commit was dead code —
    // committed locally to the Actions runner but was NEVER pushed (no git push step
    // for the main repo in the workflow). R2 upload (Step 10) is the sole persistence.
    // Removed per operator directive: "no git fallback — crutch that does more harm than good."

    console.log('');
    console.log('═'.repeat(60));
    console.log('🎉 Jobs Data Fetcher - Complete!');
    console.log('═'.repeat(60));

    process.exit(0);

  } catch (error) {
    console.error('');
    console.error('❌ Fatal error:');
    console.error(error.message);
    console.error('');
    console.error('Stack trace:');
    console.error(error.stack);
    process.exit(1);
  }
}

/**
 * GAP-6: Compute companies configured in company-list.json that returned 0 raw jobs.
 * Uses company_name from ATS stats (not slug) to match against configured company names.
 * Excludes custom-fetcher companies (Apple, Amazon, etc.) — only ATS companies are checked.
 * @param {Object} atsResult - ATS fetch result with stats.by_company
 * @param {Object} fetcherResults - Custom fetcher results by name
 * @param {string} companyListPath - Path to company-list.json
 * @returns {Array<string>} Company names that returned 0 raw jobs
 */
function computeZeroYield(atsResult, fetcherResults, companyListPath, wdCache) {
  try {
    const companyList = JSON.parse(fs.readFileSync(companyListPath, 'utf8'));

    // Build set of company names that produced jobs this run (ATS only)
    const companiesWithJobs = new Set(Object.keys((atsResult.stats || {}).by_company || {}));

    // AGG-ZEROYIELD-1: Include WD tenants from incremental cache.
    // When the cache skips a tenant, it doesn't appear in atsResult.by_company,
    // but it still has jobs (verified by wd-totals-cache.json).
    if (wdCache && typeof wdCache === 'object') {
      for (const [name, count] of Object.entries(wdCache)) {
        if (count > 0) companiesWithJobs.add(name);
      }
    }

    // AGG-SR-NAME-1: Build slug set for SR name mismatch.
    // SR API returns legal names (e.g. "RE/SPEC Inc.") that differ from config names (e.g. "RESPEC").
    // Matching by slug resolves 6 false positives per run.
    const slugsWithJobs = new Set();
    if (Array.isArray(atsResult.jobs)) {
      for (const job of atsResult.jobs) {
        if (job.company_slug) slugsWithJobs.add(job.company_slug);
      }
    }

    // Build set of configured company names per ATS source
    const zeroYield = [];
    const sources = [
      { key: 'greenhouse', entries: companyList.greenhouse },
      { key: 'lever', entries: companyList.lever },
      { key: 'ashby', entries: companyList.ashby },
      { key: 'workday', entries: companyList.workday },
      { key: 'smartrecruiters', entries: companyList.smartrecruiters },
    ];

    for (const { key, entries } of sources) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const name = entry.name;
        const slug = entry.slug;
        const hasName = name && companiesWithJobs.has(name);
        const hasSlug = slug && slugsWithJobs.has(slug);
        if (!hasName && !hasSlug) {
          zeroYield.push(`${name} (${key})`);
        }
      }
    }

    return zeroYield;
  } catch (e) {
    console.warn(`⚠️ GAP-6: Could not compute zero-yield companies: ${e.message}`);
    return [];
  }
}

/**
 * Generate metadata object
 * @param {Array} jobs - All jobs
 * @param {number} uniqueCount - Unique job count
 * @param {number} duplicateCount - Duplicate count
 * @param {number} duration - Duration in ms
 * @param {Object} tagStats - Tag statistics from tag engine
 * @param {Object} validationMetrics - Validation metrics
 * @param {Object} seniorFilterMetrics - Senior filter metrics
 * @returns {Object} - Metadata object
 */


const SOURCE_TIER_POLICY = {
  workday: 'tier_a_core',
  greenhouse: 'tier_a_core',
  ashby: 'tier_a_core',
  lever: 'tier_a_optional',
  smartrecruiters: 'tier_b_async_material',
  oracle: 'tier_b_c_scrutiny',
  apple: 'tier_b_c_scrutiny',
  google: 'tier_b_c_scrutiny',
  microsoft: 'tier_b_c_scrutiny',
  amd: 'tier_b_c_scrutiny',
  amazon: 'tier_b_c_scrutiny',
  tiktok: 'tier_b_c_scrutiny',
  icims: 'tier_b_c_scrutiny',
  simplify: 'tier_c_fallback',
  jsearch: 'tier_c_fallback',
  eightfold: 'tier_c_fallback',
  uber: 'tier_c_fallback',
  twosigma: 'tier_c_fallback',
};

const TECH_US_DOMAINS = new Set(['software', 'data_science', 'hardware', 'ai', 'finance']);

function buildLatencyMarkers({ startTime, duration, stageTimings, pipelineTimestamps }) {
  return {
    pipeline_started_at: new Date(startTime).toISOString(),
    fetch_completed_at: pipelineTimestamps.fetch_completed_at || null,
    sidecars_written_at: pipelineTimestamps.sidecars_written_at || null,
    output_ready_at: pipelineTimestamps.output_ready_at || null,
    total_runtime_ms: duration,
    step_timings_ms: {
      step1_fetch_ms: stageTimings.step1_fetch_ms || 0,
      step2_enhance_ms: stageTimings.step2_enhance_ms || 0,
      step3_validate_ms: stageTimings.step3_validate_ms || 0,
      step4_filter_ms: stageTimings.step4_filter_ms || 0,
      step5_tag_ms: stageTimings.step5_tag_ms || 0,
      step6_dedup_ms: stageTimings.step6_dedup_ms || 0,
      step8_sort_ms: stageTimings.step8_sort_ms || 0,
      step8b_sidecars_ms: stageTimings.step8b_sidecars_ms || 0,
      step9_write_ms: stageTimings.step9_write_ms || 0,
      // step12_commit_ms removed (AGG-R2-CANONICAL-1): git commit step deleted
    },
  };
}

function buildSourceVisibilitySummary(jobs) {
  const now = Date.now();
  const sources = {};

  for (const job of jobs || []) {
    const source = job.source || 'unknown';
    const row = sources[source] || (sources[source] = {
      tier: SOURCE_TIER_POLICY[source] || 'unclassified',
      total_jobs: 0,
      tech_us_jobs: 0,
      freshness: {
        last_24h: 0,
        last_72h: 0,
      },
      newest_posted_at: null,
      oldest_posted_at: null,
    });

    row.total_jobs++;

    const domains = job.tags?.domains || [];
    const locations = job.tags?.locations || [];
    if (locations.includes('us') && domains.some(domain => TECH_US_DOMAINS.has(domain))) {
      row.tech_us_jobs++;
    }

    if (!job.posted_at) continue;
    const postedMs = new Date(job.posted_at).getTime();
    if (!Number.isFinite(postedMs)) continue;

    const ageMs = now - postedMs;
    if (ageMs <= 24 * 60 * 60 * 1000) row.freshness.last_24h++;
    if (ageMs <= 72 * 60 * 60 * 1000) row.freshness.last_72h++;

    if (!row.newest_posted_at || postedMs > new Date(row.newest_posted_at).getTime()) {
      row.newest_posted_at = new Date(postedMs).toISOString();
    }
    if (!row.oldest_posted_at || postedMs < new Date(row.oldest_posted_at).getTime()) {
      row.oldest_posted_at = new Date(postedMs).toISOString();
    }
  }

  return {
    generated_at: new Date().toISOString(),
    policy_version: 'source-tier-a141',
    metric_basis: 'final_public_pool',
    tech_us_definition: ['software', 'data_science', 'hardware', 'ai', 'finance'].join('+') + ' with us location tag',
    tiers: {
      tier_a_core: ['workday', 'greenhouse', 'ashby'],
      tier_a_optional: ['lever'],
      tier_b_async_material: ['smartrecruiters'],
      tier_b_c_scrutiny: ['oracle', 'apple', 'google', 'microsoft', 'amd', 'amazon', 'tiktok', 'icims'],
      tier_c_fallback: ['simplify', 'jsearch', 'eightfold', 'uber', 'twosigma'],
    },
    sources,
  };
}

function buildDescriptionDeliverySummary(jobs, dataDir) {
  // AGG-DESCCOVERAGE-METRIC-1: removed stale 'workday' + 'smartrecruiters' exclusions.
  // These were excluded when workday descriptions were not in the hot path (AGG-HOTPATH-1).
  // Now that the backfill is running (Step 1b) and sidecars are uploaded to R2,
  // the exclusion hides real coverage data from monitoring.
  const excludedSources = new Set(['enriched']);
  const sidecarRows = {};
  const sidecarNonempty = {};
  const sidecarIds = new Map();

  try {
    const files = fs.readdirSync(dataDir)
      .filter(f => /^descriptions-.+\.jsonl$/.test(f))
      .filter(f => !f.startsWith('descriptions-enriched'));
    for (const fname of files) {
      const source = fname.replace(/^descriptions-/, '').replace(/-\d+\.jsonl$/, '').replace(/\.jsonl$/, '').toLowerCase();
      sidecarRows[source] = sidecarRows[source] || 0;
      sidecarNonempty[source] = sidecarNonempty[source] || 0;
      if (!sidecarIds.has(source)) sidecarIds.set(source, new Set());
      const lines = fs.readFileSync(path.join(dataDir, fname), 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        sidecarRows[source]++;
        try {
          const row = JSON.parse(line);
          if (typeof row.description_text === 'string' && row.description_text.trim()) sidecarNonempty[source]++;
          if (row.id) sidecarIds.get(source).add(row.id);
        } catch {
          // malformed rows still count toward file size but not toward matches/nonempty text
        }
      }
    }
  } catch {
    // Missing sidecar files are reflected as zero coverage below.
  }

  const finalRows = {};
  const finalInlineDescriptions = {};
  const finalRowsWithSidecarMatch = {};
  for (const job of jobs || []) {
    const source = (job.source || 'unknown').toLowerCase();
    if (excludedSources.has(source)) continue;
    finalRows[source] = (finalRows[source] || 0) + 1;
    if (typeof job.description === 'string' && job.description.trim()) {
      finalInlineDescriptions[source] = (finalInlineDescriptions[source] || 0) + 1;
    }
    if (sidecarIds.get(source)?.has(job.id)) {
      finalRowsWithSidecarMatch[source] = (finalRowsWithSidecarMatch[source] || 0) + 1;
    }
  }

  const summary = {};
  const sources = new Set([
    ...Object.keys(sidecarRows),
    ...Object.keys(finalRows),
  ]);
  for (const source of [...sources].sort()) {
    const finalPool = finalRows[source] || 0;
    const matched = finalRowsWithSidecarMatch[source] || 0;
    const sidecars = sidecarRows[source] || 0;
    let mode = 'none_visible';
    if (finalPool === 0) mode = 'no_final_rows';
    else if (matched === finalPool && finalPool > 0) mode = 'sidecar_only';
    else if (matched > 0) mode = 'partial_sidecar_coverage';
    else if ((finalInlineDescriptions[source] || 0) > 0) mode = 'inline_only';
    summary[source] = {
      final_rows: finalPool,
      final_inline_description_rows: finalInlineDescriptions[source] || 0,
      sidecar_rows: sidecars,
      sidecar_nonempty_description_rows: sidecarNonempty[source] || 0,
      final_rows_with_sidecar_match: matched,
      coverage_pct: finalPool > 0 ? Math.round((matched / finalPool) * 1000) / 10 : null,
      mode,
    };
  }

  return {
    generated_at: new Date().toISOString(),
    basis: 'final_public_pool_vs_description_sidecars',
    sources: summary,
  };
}


function buildSeniorRolloutProjection(seniorJobs, seniorBySource) {
  const projection = {
    generated_at: new Date().toISOString(),
    sample_basis: {
      type: 'current_run_filtered_senior_jobs',
      total_senior_filtered: Array.isArray(seniorJobs) ? seniorJobs.length : 0,
    },
    by_source: seniorBySource || {},
    by_domain: {},
    by_surface: {
      ngj_main: 0,
      software: 0,
      data_science: 0,
      hardware: 0,
      healthcare: 0,
    },
    quality: {
      surface_projection_exact: false,
      surface_projection_method: 'directional_current_run_domain_location_mapping',
      notes: 'Directional projection for current-run senior-filtered jobs. Source counts are exact; domain and surface counts use tag-engine projection on filtered jobs and should guide rollout decisions, not exact publish counts.',
    },
  };

  if (!Array.isArray(seniorJobs) || seniorJobs.length === 0) return projection;

  const mainSurfaceDomains = new Set(['software', 'data_science', 'hardware', 'ai', 'finance']);
  for (const job of seniorJobs) {
    const domains = tagDomains(job);
    const normalizedDomains = domains.length > 0 ? domains : ['general'];
    for (const domain of normalizedDomains) {
      projection.by_domain[domain] = (projection.by_domain[domain] || 0) + 1;
    }

    const locations = tagLocations(job);
    const isUs = locations.includes('us');
    if (!isUs) continue;

    if (normalizedDomains.some(domain => mainSurfaceDomains.has(domain))) projection.by_surface.ngj_main++;
    if (normalizedDomains.includes('software')) projection.by_surface.software++;
    if (normalizedDomains.includes('data_science') || normalizedDomains.includes('ai')) projection.by_surface.data_science++;
    if (normalizedDomains.includes('hardware')) projection.by_surface.hardware++;
    if (normalizedDomains.includes('healthcare')) projection.by_surface.healthcare++;
  }

  return projection;
}

/**
 * TAG-DIM-1: Build G1 by-domain breakdown for DASH visibility.
 * Categorizes US general jobs by source, company, fix category, engine version, employment type.
 * @param {Array} jobs - Full public pool (post-merge + post-AGG-32)
 * @returns {Object} g1_breakdown object for metadata
 */
function buildG1Breakdown(jobs) {
  const usJobs = jobs.filter(j => j.tags && j.tags.locations && j.tags.locations.includes('us'));
  const g1Jobs = usJobs.filter(j => j.tags.domains && j.tags.domains.includes('general'));

  if (g1Jobs.length === 0) return null;

  // By source
  const bySource = {};
  const sourceTotals = {};
  for (const j of usJobs) {
    sourceTotals[j.source] = (sourceTotals[j.source] || 0) + 1;
  }
  for (const j of g1Jobs) {
    bySource[j.source] = (bySource[j.source] || 0) + 1;
  }
  const bySourceFormatted = {};
  for (const [src, g1] of Object.entries(bySource)) {
    const total = sourceTotals[src] || 0;
    bySourceFormatted[src] = { g1, total, rate: total > 0 ? Math.round(g1 / total * 1000) / 10 : 0 };
  }

  // Top 20 companies
  const companyCounts = {};
  const companySource = {};
  const companyDepts = {};
  for (const j of g1Jobs) {
    const c = j.company_name || 'unknown';
    companyCounts[c] = (companyCounts[c] || 0) + 1;
    companySource[c] = j.source;
    companyDepts[c] = companyDepts[c] || j.departments?.length > 0;
  }
  const top20 = Object.entries(companyCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([company, g1]) => ({
      company,
      g1,
      source: companySource[company],
      has_departments: !!companyDepts[company],
    }));

  // Fix categories (heuristic based on source + departments)
  let needsFamilyMapping = 0; // WD jobs with no departments
  let familyMapGap = 0;       // WD jobs with departments but still G1
  let noDescription = 0;      // Simplify T0 with no desc
  let genuinelyAmbiguous = 0;  // Non-WD, non-Simplify, no domain signal
  let other = 0;
  for (const j of g1Jobs) {
    if (j.source === 'workday') {
      if (j.departments && j.departments.length > 0) {
        familyMapGap++;
      } else {
        needsFamilyMapping++;
      }
    } else if (j.source === 'simplify') {
      noDescription++;
    } else {
      // Check for domain keywords in title as signal
      const title = (j.title || '').toLowerCase();
      const hasSignal = /\b(engineer|developer|scientist|analyst|designer|manager|accountant|nurse|pharmacist|attorney|sales|marketing|operations|manufacturing|logistics|hardware|software|data|ai|product|finance|hr|legal)\b/i.test(title);
      if (hasSignal) {
        other++;
      } else {
        genuinelyAmbiguous++;
      }
    }
  }

  // Engine version distribution
  const byVersion = {};
  for (const j of g1Jobs) {
    const v = j.tags.tag_engine_version || 'none';
    byVersion['v' + v] = (byVersion['v' + v] || 0) + 1;
  }

  // Employment type distribution
  const byEmployment = {};
  for (const j of g1Jobs) {
    const e = j.tags.employment || 'unknown';
    byEmployment[e] = (byEmployment[e] || 0) + 1;
  }

  return {
    updated: new Date().toISOString(),
    us_total: usJobs.length,
    us_g1: g1Jobs.length,
    us_g1_rate: Math.round(g1Jobs.length / usJobs.length * 1000) / 10,
    by_source: bySourceFormatted,
    by_company_top20: top20,
    by_fix_category: {
      needs_family_mapping: { count: needsFamilyMapping, description: 'WD jobs with no departments — blocked on AGG-PIPE-16' },
      family_map_gap: { count: familyMapGap, description: 'WD jobs with departments but still G1' },
      genuinely_ambiguous: { count: genuinelyAmbiguous, description: 'Non-WD/Simplify jobs with no domain signal in title' },
      no_description: { count: noDescription, description: 'Simplify T0 jobs — no description for L4 fallback' },
      other: { count: other, description: 'Mixed ATS — some keyword gaps, some structural' },
    },
    by_engine_version: byVersion,
    by_employment: byEmployment,
  };
}

function generateMetadata({ startTime, jobs, uniqueCount, duplicateCount, duration, tagStats, validationMetrics, seniorFilterMetrics, seniorJobs, zeroYieldCompanies, stageTimings, pipelineTimestamps, tagDriftReport, tagPrecisionReport, keywordHealthReport, keywordOverlapReport, fpStats, fetchResults, fetcherHealth, supplementalInputs }) {
  const bySource = {};
  const byEmploymentType = {};
  const byInternship = { internship: 0, 'new-grad': 0, mid_level: 0, senior: 0 };
  const byRemote = { remote: 0, onsite: 0 };
  const companyCounts = {};
  const companyDomains = {};  // DASH-4b: track domain distribution per company

  const now = Date.now();
  const freshness = { last_1h: 0, last_6h: 0, last_24h: 0, last_48h: 0 };

  for (const job of jobs) {
    // Count by source
    bySource[job.source] = (bySource[job.source] || 0) + 1;

    // Count by employment type (AGG-DATA-13: normalize to canonical forms)
    // AGG-PIPE-13: shared EMPLOYMENT_NORMALIZE_MAP (includes compound types)
    const types = (job.employment_types || []).map(t => EMPLOYMENT_NORMALIZE_MAP[t] || t);
    if (Array.isArray(types)) {
      for (const type of types) {
        byEmploymentType[type] = (byEmploymentType[type] || 0) + 1;
      }
    }

    // Count by job type (use tags.employment — is_internship/is_new_grad stripped by STRIP_FIELDS)
    if (job.tags?.employment === 'internship') {
      byInternship.internship++;
    } else if (job.tags?.employment === 'entry_level') {
      byInternship['new-grad']++;
    } else if (job.tags?.employment === 'senior' || job.tags?.employment === 'senior_level') {
      byInternship.senior++;
    } else {
      byInternship.mid_level++;
    }

    // Count by remote (use tags.locations — is_remote stripped by STRIP_FIELDS)
    if (job.tags?.locations?.includes('remote')) {
      byRemote.remote++;
    } else {
      byRemote.onsite++;
    }

    // Freshness buckets
    if (job.posted_at) {
      const ageMs = now - new Date(job.posted_at).getTime();
      if (ageMs <= 1 * 60 * 60 * 1000)  freshness.last_1h++;
      if (ageMs <= 6 * 60 * 60 * 1000)  freshness.last_6h++;
      if (ageMs <= 24 * 60 * 60 * 1000) freshness.last_24h++;
      if (ageMs <= 48 * 60 * 60 * 1000) freshness.last_48h++;
    }

    // Company counts + domain tracking (for top-N with domain)
    const co = job.company_name;
    if (co) {
      companyCounts[co] = (companyCounts[co] || 0) + 1;
      // DASH-4b: track primary domain per company
      const domains = (job.tags && job.tags.domains) || [];
      if (!companyDomains[co]) companyDomains[co] = {};
      for (const d of domains) {
        companyDomains[co][d] = (companyDomains[co][d] || 0) + 1;
      }
    }
  }

  // Top 20 companies by job count
  // DASH-4b: includes primary domain (most common domain tag for that company)
  const top_companies = Object.entries(companyCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([company, count]) => {
      const domains = companyDomains[company] || {};
      const primaryDomain = Object.entries(domains).sort((a, b) => b[1] - a[1])[0];
      return { company, count, domain: primaryDomain ? primaryDomain[0] : 'general' };
    });

  // Senior-filtered breakdown by source
  const seniorBySource = {};
  if (Array.isArray(seniorJobs)) {
    for (const job of seniorJobs) {
      const src = job.source || 'unknown';
      seniorBySource[src] = (seniorBySource[src] || 0) + 1;
    }
  }

  // AGG-PERSOURCE-STAGES-1: Per-source pipeline stage counts for DASH Source Journey.
  const sourceJourney = {};
  for (const src of new Set([
    ...Object.keys(fetchResults || {}),
    ...Object.keys(seniorFilterMetrics?.by_source || {}),
    ...Object.keys(bySource),
  ])) {
    sourceJourney[src] = {
      fetched: (fetchResults || {})[src] || 0,
      senior_filtered: (seniorFilterMetrics?.by_source || {})[src] || 0,
      final: bySource[src] || 0,
    };
  }
  return {
    version: '1.0',
    generated: new Date().toISOString(),
    duration_ms: duration,

    total_jobs: jobs.length,
    unique_jobs: uniqueCount,
    duplicates_removed: duplicateCount,

    by_source: bySource,
    source_journey: sourceJourney,
    by_employment_type: byEmploymentType,
    by_job_type: byInternship,
    by_location: byRemote,

    ats_stats: getATSUsageStats(),

    // Validation statistics
    validation_stats: validationMetrics,

    // Senior filter statistics
    senior_filter_stats: {
      ...seniorFilterMetrics,
      by_source: seniorBySource,
      ...(fpStats || {}),
    },

    // AGG-MEASURE-1: Directional rollout projection for filtered senior jobs.
    senior_rollout_projection: buildSeniorRolloutProjection(seniorJobs, seniorBySource),

    // AGG-SOURCE-1: Source tier/value/freshness visibility for operator decisions.
    source_visibility: buildSourceVisibilitySummary(jobs),

    // AGG-SIDECAR-HEALTH-1: Producer-owned truth for sources whose downstream descriptions
    // depend on sidecars because all_jobs strips description text.
    description_delivery: buildDescriptionDeliverySummary(jobs, DATA_DIR),

    // AGG latency markers: producer-owned timing anchors for downstream latency measurement.
    latency_markers: buildLatencyMarkers({ startTime, duration, stageTimings, pipelineTimestamps }),

    // Tag statistics (Phase 1)
    tag_stats: tagStats,

    // TAG-SELF-2: Tag monitoring snapshots for metrics pipeline.
    tag_drift: tagDriftReport ? {
      drift_rate: tagDriftReport.drift_rate,
      sample_size: tagDriftReport.sample_size,
      drifted: tagDriftReport.drifted,
      warnings: tagDriftReport.warnings,
    } : null,
    tag_precision: tagPrecisionReport ? {
      domains: Object.fromEntries(
        Object.entries(tagPrecisionReport.domains).map(([d, r]) => [d, { total: r.total, fps: r.fps, fp_rate: r.fp_rate }])
      ),
      warnings: tagPrecisionReport.warnings,
    } : null,
    keyword_health: keywordHealthReport ? Object.fromEntries(
      Object.entries(keywordHealthReport.domains).map(([d, r]) => [d, {
        total_jobs: r.total_jobs,
        keyword_count: r.keyword_count,
        keywords_with_matches: r.keywords_with_matches,
        top_5: r.top_contributors.slice(0, 5).map(tc => ({ keyword: tc.keyword, matches: tc.matches, rate_pct: tc.rate_pct })),
        high_volume: r.high_volume,
      }])
    ) : null,
    keyword_overlap: keywordOverlapReport ? Object.fromEntries(
      Object.entries(keywordOverlapReport.domains).filter(([, r]) => r.foreign_keyword_overlaps > 0).map(([d, r]) => [d, {
        total_jobs: r.total_jobs,
        overlap_count: r.foreign_keyword_overlaps,
        top_overlaps: r.top_overlaps.slice(0, 3),
      }])
    ) : null,

    // TAG-DIM-1: G1 by-domain breakdown for DASH visibility.
    // Categorizes G1 jobs by source, company, fix category, engine version, and employment type.
    g1_breakdown: buildG1Breakdown(jobs),

    // Freshness — jobs posted within last N hours (entry-level pool)
    freshness,

    // Top 20 companies by job count (entry-level pool)
    top_companies,

    // GAP-6: Companies that returned 0 raw jobs this run (pre-filter).
    // Used by pipeline-alert.js for consecutive-failure detection.
    zero_yield_companies: zeroYieldCompanies || [],

    stage_timings: stageTimings || {},

    // AGG-HOTPATH-1: Sources intentionally excluded from the fast publish workflow.
    // Alerting must distinguish "not attempted here" from "attempted and fetched 0".
    hot_path_demoted_sources: [...HOTPATH_DEMOTED_SOURCES],

    supplemental_inputs: supplementalInputs || {},

    // TAG-DIM-1: Tag engine version deployed in this run.
    // Enables zjp-metrics to surface engine_version (was null because this field was missing).
    tag_engine_version: TAG_ENGINE_VERSION,

    // A91: Per-source fetch counts from current run (before carry-forward merge).
    // Enables alert checks to detect source fetch failures masked by carry-forward.
    fetch_results: fetchResults || {},

    // AGG-FETCH-14: Per-company fetcher health from current run.
    // status: 'alive' (has jobs), 'zero' (fetched ok but 0 jobs), 'error' (fetch failed).
    // Enables check-19 to classify without HTTP probing.
    fetcher_health: fetcherHealth || {},

    // AGG-LIFECYCLE-1: lifecycle_state distribution + version. Evergreen/ghost/TTL-expired jobs are
    // now KEPT+TAGGED (fresh / carry-forward / evergreen / stale-candidate / dead) instead of dropped.
    // Consumers replicate the pre-LIFECYCLE "dropped" set by excluding {dead, stale-candidate}.
    lifecycle: {
      version: LIFECYCLE_VERSION,
      distribution: jobs.reduce((acc, j) => {
        const s = j?.tags?.lifecycle_state || 'untagged';
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}

/**
 * Print execution summary
 * @param {Array} jobs - Final job array
 * @param {number} uniqueCount - Unique job count
 * @param {number} duplicateCount - Duplicate count
 * @param {number} duration - Duration in ms
 */
function printSummary(jobs, uniqueCount, duplicateCount, duration) {
  console.log('📊 Execution Summary:');
  console.log('━'.repeat(60));

  // Count by job type (use tag fields — is_internship/is_new_grad/is_remote are never set)
  const internships = jobs.filter(j => j.tags?.employment === 'internship').length;
  const newGrad = jobs.filter(j => j.tags?.employment === 'entry_level').length;
  const remote = jobs.filter(j => j.tags?.locations?.includes('remote')).length;

  console.log(`Total jobs in output: ${jobs.length}`);
  console.log(`  - Internships: ${internships}`);
  console.log(`  - New Grad: ${newGrad}`);
  console.log(`  - Remote: ${remote}`);
  console.log('');
  console.log(`Duplicates removed: ${duplicateCount}`);
  console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);
}


// Run main function
if (require.main === module) {
  main();
}

module.exports = { main, resolvePostedAt, mergeCarryForward, dropOrphanJobs, RETIRED_CARRY_FORWARD_SOURCES, normalizeSupplementalJobForMerge, summarizeSupplementalLaneForMerge, buildDescriptionDeliverySummary, buildUsSnapshotJobs, buildMidLevelTechFeed, buildMidLevelTechSummary, buildSeniorTechFeed, buildSeniorTechSummary, buildCanadaTechFeed, buildCanadaInternshipsFeed, buildCanadaSentinelChecks, buildCanadaAllFeed, activePublicWindowTs, applicableTtlMs, classifyAgeLifecycle, isLifecycleHardRetired, LIFECYCLE_VERSION, LIFECYCLE_EVERGREEN_THRESHOLD_DAYS, injectDescriptions };
