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

// Import from shared submodule (job-board-scripts/lib/aggregator/)
const SHARED = path.join(__dirname, 'shared', 'lib', 'aggregator');

// Import fetchers
const { fetchFromAllATS, getUsageStats: getATSUsageStats } = require(`${SHARED}/fetchers/ats-fetcher`);
const { fetchAllAmazonJobs } = require(`${SHARED}/fetchers/amazon`);
const { fetchAllNetflixJobs } = require(`${SHARED}/fetchers/netflix`);
const { loadDescriptions } = require(`${SHARED}/fetchers/workday-descriptions`);
const { fetchAllAppleJobs } = require(`${SHARED}/fetchers/apple`);
const { fetchAllTwoSigmaJobs } = require(`${SHARED}/fetchers/twosigma`);
const { fetchAllUberJobs } = require(`${SHARED}/fetchers/uber`);
const { fetchAllGoogleJobs } = require(`${SHARED}/fetchers/google`);
const { fetchAllSimplifyJobs } = require(`${SHARED}/fetchers/simplify`);
const { fetchAllMicrosoftJobs } = require(`${SHARED}/fetchers/microsoft`);
const { fetchAllOracleJobs } = require(`${SHARED}/fetchers/oracle`);
const { fetchAllAmdJobs } = require(`${SHARED}/fetchers/amd`);

// Import processors
const { validateAndNormalizeJobs, printValidationSummary, normalizeJob } = require(`${SHARED}/processors/validator`);
const { filterSeniorJobs, printSeniorFilterSummary, isSeniorJob, buildCompanyOverrideMap } = require(`${SHARED}/processors/senior-filter`);
const { deduplicateJobs, DEDUPE_TTL_MS, DEDUPE_TTL_DAYS } = require(`${SHARED}/processors/deduplicator`);
const { tagJobs, generateTagStats, tagEmployment, tagDomains, setCompanyOverrideMap, TAG_ENGINE_VERSION } = require(`${SHARED}/processors/tag-engine`);
const { printTagDistribution, checkTagDrift, printDriftReport, checkDomainPrecision, printPrecisionReport } = require(`${SHARED}/processors/tag-monitor`);

// Import utils
const { writeJobsJSONL, writeMetadata } = require(`${SHARED}/utils/file-writer`);

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
const METADATA_OUTPUT_FILE = path.join(DATA_DIR, 'jobs-metadata.json');

// Command line args
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isVerbose = args.includes('--verbose');

// --- Extracted invariants (AGG-PIPE-6) ---
// Each function wraps a pipeline invariant that was previously inline in main().
// Named functions make accidental removal structurally harder.

/**
 * AGG-6: Preserve earliest posted_at for re-fetched jobs.
 * Workday "Posted 30+ Days Ago" resets each run — preserving the earlier date
 * lets jobs age naturally and expire via TTL.
 */
function resolvePostedAt(publicJobs, prevLines) {
  const cutoffMs = Date.now() - DEDUPE_TTL_MS;

  // Collect prior dates for re-fetched jobs
  const priorDates = new Map();
  for (const line of prevLines) {
    try {
      const job = JSON.parse(line);
      if (job.id && job.posted_at) priorDates.set(job.id, job.posted_at);
    } catch { /* skip malformed */ }
  }

  // AGG-6: Preserve earlier dates; AGG-32: filter stale — single pass
  let datePreservedCount = 0;
  let staleRemoved = 0;
  const filtered = publicJobs.filter(job => {
    const prior = priorDates.get(job.id);
    if (prior && new Date(prior) < new Date(job.posted_at)) {
      job.posted_at = prior;
      datePreservedCount++;
    }
    if (!job.posted_at) { staleRemoved++; return false; }
    if (new Date(job.posted_at).getTime() < cutoffMs) { staleRemoved++; return false; }
    return true;
  });

  if (datePreservedCount > 0) {
    console.log(`📅 Preserved earlier posted_at for ${datePreservedCount} re-fetched jobs`);
  }
  if (staleRemoved > 0) {
    console.log(`🧹 AGG-32: Removed ${staleRemoved} stale jobs (posted_at >${DEDUPE_TTL_DAYS}d) from post-merge pool`);
  }

  publicJobs.length = 0;
  publicJobs.push(...filtered);
}

/**
 * Carry-forward merge: re-adds prior-run jobs not in current run (rolling window).
 * Re-tags employment, re-tags domains on version change, refreshes empty locations.
 */
function mergeCarryForward(publicJobs, prevLines, currentIds, currentFingerprints, stripFields, cutoffMs) {
  let mergedCount = 0;
  let nullDateCount = 0;
  let fpSkipCount = 0;
  for (const line of prevLines) {
    try {
      const job = JSON.parse(line);
      if (currentIds.has(job.id)) continue;
      if (job.fingerprint && currentFingerprints.has(job.fingerprint)) { fpSkipCount++; continue; }
      if (!job.posted_at) { nullDateCount++; continue; }
      const postedTs = new Date(job.posted_at).getTime();
      if (postedTs < cutoffMs) continue;
      if (isSeniorJob(job)) continue;
      const strippedJob = { ...job };
      for (const field of stripFields) delete strippedJob[field];
      publicJobs.push(strippedJob);
      mergedCount++;
    } catch { /* skip malformed lines */ }
  }
  if (nullDateCount > 0) {
    console.log(`⚠️ Rolling window: dropped ${nullDateCount} prior-run jobs with null posted_at (cannot verify TTL)`);
  }
  if (fpSkipCount > 0) {
    console.log(`🔄 Rolling window: skipped ${fpSkipCount} prior-run jobs with matching fingerprint (ID changed, current version wins)`);
  }
  if (mergedCount > 0) {
    publicJobs.sort((a, b) => new Date(b.posted_at || 0) - new Date(a.posted_at || 0));
    let empRetagged = 0;
    let domainRetagged = 0;
    let locRefreshed = 0;
    for (const job of publicJobs) {
      if (currentIds.has(job.id)) continue;
      const newEmp = tagEmployment(job);
      if (job.tags?.employment !== newEmp) {
        job.tags.employment = newEmp;
        empRetagged++;
      }
      if (!job.tags?.tag_engine_version || job.tags.tag_engine_version < TAG_ENGINE_VERSION) {
        const freshDomains = tagDomains(job);
        const oldDomains = (job.tags?.domains || []).slice().sort().join(',');
        const newDomains = (freshDomains || []).slice().sort().join(',');
        if (oldDomains !== newDomains) {
          job.tags.domains = freshDomains;
          domainRetagged++;
        }
        job.tags.tag_engine_version = TAG_ENGINE_VERSION;
      }
      if ((!job.job_state || job.job_state === '') || (!job.job_city || job.job_city === '')) {
        const hadState = job.job_state && job.job_state !== '';
        const hadCity = job.job_city && job.job_city !== '';
        normalizeJob(job);
        if ((!hadState && job.job_state) || (!hadCity && job.job_city)) locRefreshed++;
      }
    }
    console.log(`🔄 Merged ${mergedCount} prior-run jobs into rolling window (total: ${publicJobs.length}${empRetagged > 0 ? `, ${empRetagged} employment re-tagged` : ''}${domainRetagged > 0 ? `, ${domainRetagged} domains re-tagged (version ${TAG_ENGINE_VERSION})` : ''}${locRefreshed > 0 ? `, ${locRefreshed} locations refreshed` : ''})`);
  } else {
    console.log('🔄 No prior-run jobs to merge');
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
        return label.includes('ATS') ? { jobs: [] } : [];
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
      withTimeout(fetchAllNetflixJobs(), 300_000, 'Netflix'),
      withTimeout(fetchAllAppleJobs({ previousJobCount: prevAppleCount, previousJobIds: prevAppleIds }), prevAppleCount === 0 ? 300_000 : 180_000, 'Apple'),
      withTimeout(fetchAllTwoSigmaJobs(), 30_000, 'Two Sigma'),
      withTimeout(fetchAllUberJobs(), 60_000, 'Uber'),
      withTimeout(fetchAllGoogleJobs({ previousJobCount: prevGoogleCount }), prevGoogleCount === 0 ? 300_000 : 180_000, 'Google'),
      withTimeout(fetchAllSimplifyJobs(), 30_000, 'SimplifyJobs'),
      withTimeout(fetchAllMicrosoftJobs({ previousJobCount: prevMicrosoftCount }), prevMicrosoftCount === 0 ? 600_000 : 300_000, 'Microsoft'),
      withTimeout(fetchAllOracleJobs(), 120_000, 'Oracle'),
      withTimeout(fetchAllAmdJobs(), 120_000, 'AMD'),
    ]);

    // Collect ATS results
    const atsResult = phaseAResult.status === 'fulfilled' ? phaseAResult.value : { jobs: [] };
    allJobs.push(...atsResult.jobs);
    console.log(`  ATS: ${atsResult.jobs.length} jobs`);

    // AGG-SPEED-2: Save WD totals cache for next run
    if (atsResult.wdCurrentTotals && Object.keys(atsResult.wdCurrentTotals).length > 0) {
      fs.writeFileSync(WD_TOTALS_CACHE, JSON.stringify(atsResult.wdCurrentTotals, null, 2));
      console.log(`  WD totals cache saved: ${Object.keys(atsResult.wdCurrentTotals).length} tenants`);
    }

    // Collect custom fetcher results
    const fetcherNames = ['Amazon', 'Netflix', 'Apple', 'Two Sigma', 'Uber', 'Google', 'SimplifyJobs', 'Microsoft', 'Oracle', 'AMD'];
    const fetcherResults = {};
    phaseBSettled.forEach((result, i) => {
      const name = fetcherNames[i];
      const jobs = result.status === 'fulfilled' ? result.value : [];
      fetcherResults[name] = Array.isArray(jobs) ? jobs : [];
      allJobs.push(...fetcherResults[name]);
    });

    console.log('');
    console.log(`📊 Step 1 complete: ${allJobs.length} jobs fetched`);
    stageTimings.step1_fetch_ms = Date.now() - _stepStart;
    console.log(`   - ATS: ${atsResult.jobs.length} jobs`);
    for (const name of fetcherNames) {
      console.log(`   - ${name}: ${fetcherResults[name].length} jobs`);
    }

    // GAP-6: Compute zero-yield companies from raw fetch results (pre-filter).
    // Compares companies configured in company-list.json against companies that
    // produced jobs this run. A company returning 0 raw jobs may have a broken
    // slug, API change, or auth issue (LLNL incident class).
    const zeroYieldCompanies = computeZeroYield(atsResult, fetcherResults, COMPANY_LIST_PATH);
    if (zeroYieldCompanies.length > 0) {
      console.log(`   ⚠️  GAP-6: ${zeroYieldCompanies.length} companies returned 0 raw jobs`);
    }

    console.log('');

    // Steps 1b/1c REMOVED (DESC-MIGRATE-1): WD/SR descriptions now fetched by enrichment
    // workflow in jobs-data-2026 (targeted: only tech+US jobs, no waste on senior/non-US).
    console.log('📄 Steps 1b/1c: WD/SR descriptions → handled by enrichment workflow');
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

      // Normalize employment_type/employment_types to array
      if (!job.employment_types) {
        const types = job.employment_type || job.employment_types || [];
        if (Array.isArray(types)) {
          job.employment_types = types.map(t => String(t).toUpperCase());
        } else if (typeof types === 'string') {
          job.employment_types = types.split(',').map(t => t.trim().toUpperCase());
        } else if (types === null || types === undefined) {
          job.employment_types = [];
        } else {
          job.employment_types = [String(types).toUpperCase()];
        }
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

    const { entryLevelJobs, seniorJobs, metrics: seniorFilterMetrics } = filterSeniorJobs(validJobs, companyOverrideMap);

    console.log('');
    printSeniorFilterSummary(seniorFilterMetrics);
    console.log('');
    const overrideCount = seniorFilterMetrics.override_applied || 0;
    console.log(`✅ Step 4 complete: ${entryLevelJobs.length} entry-level jobs (${seniorJobs.length} senior filtered${overrideCount > 0 ? `, ${overrideCount} overrides applied` : ''})`);
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
    const filteredSummary = {
      generated: new Date().toISOString(),
      total_senior_filtered: seniorJobs.length,
      by_source: seniorBySource,
    };
    fs.writeFileSync(FILTERED_OUTPUT_FILE, JSON.stringify(filteredSummary, null, 2), 'utf8');
    console.log(`📋 Step 4b: Senior-filter summary → filtered_jobs.json (${seniorJobs.length} total)`);

    // AGG-DATA-8: Sample 50 filtered jobs for false-positive spot-check.
    // Enables measuring FP rate without storing all ~53K filtered jobs.
    // File is append-only JSONL, rotated weekly by the pipeline (keep last 7 days).
    {
      const SAMPLE_SIZE = 50;
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

      const newSamples = sampleIndices.map(idx => {
        const job = seniorJobs[idx];
        return {
          sampled_at: now.toISOString(),
          id: job.id,
          title: job.title,
          company_name: job.company_name,
          source: job.source,
          location: job.location || null,
          filter_reason: job._filter_reason || 'unknown',
        };
      });

      const allLines = [...existingLines, ...newSamples.map(s => JSON.stringify(s))];
      fs.writeFileSync(SAMPLES_FILE, allLines.join('\n') + '\n', 'utf8');
      console.log(`📋 Step 4b-2: Filtered samples → filtered-samples.jsonl (${newSamples.length} sampled, ${allLines.length} total)`);
    }
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
      for (const fname of descSidecarFiles) {
        const fpath = path.join(DATA_DIR, fname);
        const descLines = fs.readFileSync(fpath, 'utf8').trim().split('\n').filter(Boolean);
        for (const line of descLines) {
          try {
            const { id, description_text } = JSON.parse(line);
            if (id && description_text) descMap.set(id, description_text);
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
      console.log(`📄 Step 4c: Injected ${injected} descriptions from ${descSidecarFiles.length} sidecar files (${descMap.size} available)`);
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

    // Step 8b: Write per-source description sidecars
    //
    // One file per source: descriptions-{source}.jsonl
    // Each file is rewritten atomically each run.
    // Non-Workday sources: pruned to liveJobIds (entry-level survivors).
    // Workday: pruned to allWorkdayIds (full pre-filter pool, all seniorities) — see PIPELINE-3-FIX.
    //
    // Chunking: if a source exceeds SIDECAR_CHUNK_LIMIT_BYTES, split into
    //   descriptions-{source}-1.jsonl, descriptions-{source}-2.jsonl, etc.
    // This keeps every file well under GitHub's 100 MB hard limit.
    //
    // Stale file cleanup: when chunk count changes (1→2 or 2→1), old filenames are orphaned.
    // After writing, we scan DATA_DIR for any descriptions-{src}*.jsonl files not written
    // this run and delete them from disk + unstage from git. This handles both directions.
    //
    // Workday: descriptions were fetched live in Step 1b and injected as job.description.
    // All other sources: descriptions are inline on job objects from their respective fetchers.
    // After this step, all descriptions are in sidecar files. Step 9 strips description from publicJobs.
    //
    // enrich-jobs.js reads all files matching descriptions-*.jsonl — auto-picks up new chunks.

    const SIDECAR_CHUNK_LIMIT_BYTES = 40 * 1024 * 1024; // 40 MB per file
    const { execSync } = require('child_process');

    // Group jobs by source, collect id + description for each
    const bySource = {};
    for (const job of sortedJobs) {
      const src = job.source;
      if (!src) continue;
      if (!bySource[src]) bySource[src] = [];
      if (job.description) {
        bySource[src].push({ id: job.id, description_text: job.description });
      }
    }

    // WD sidecar REMOVED (DESC-MIGRATE-1): WD descriptions now owned by enrichment workflow.
    delete bySource['workday'];
    // SR sidecar REMOVED (DESC-MIGRATE-1): SR descriptions now owned by enrichment workflow.
    delete bySource['smartrecruiters'];

    // ENR-2 description accumulation fix (S229): accumulate descriptions across runs for ALL sources.
    // Without this, sidecars are rewritten from scratch each run — carried-forward jobs in the
    // rolling window lose their descriptions. GH lost 713, Ashby 194, Lever 174 per run.
    // Fix: load prior sidecar entries, overlay current-run data, write merged result.
    // Size is bounded by the 7-day pool TTL — old jobs expire from all_jobs.json and their
    // descriptions are no longer needed. Chunking (40MB limit) handles large sources.
    // Pattern originally applied to early sources — now generalized to all sources.
    for (const src of Object.keys(bySource)) {
      // Load ALL prior sidecar files for this source (handles chunked files too)
      const priorMap = new Map();
      const priorFiles = fs.readdirSync(DATA_DIR)
        .filter(f => f.startsWith(`descriptions-${src}`) && f.endsWith('.jsonl'));
      for (const fname of priorFiles) {
        const lines = fs.readFileSync(path.join(DATA_DIR, fname), 'utf8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const { id, description_text } = JSON.parse(line);
            if (id && description_text) priorMap.set(id, description_text);
          } catch (_) {}
        }
      }

      // Merge: prior entries as base, current-run entries win on conflict
      const merged = new Map(priorMap);
      for (const entry of bySource[src]) {
        if (entry.description_text) merged.set(entry.id, entry.description_text);
      }

      const priorCount = priorMap.size;
      const newCount = merged.size - priorCount;
      if (priorCount > 0 && newCount !== 0) {
        console.log(`   📎 ${src}: accumulated ${priorCount} prior + ${bySource[src].length} current → ${merged.size} total`);
      }

      bySource[src] = Array.from(merged, ([id, description_text]) => ({ id, description_text }));
    }

    // Write per-source files (chunked if needed)
    const writtenFiles = new Set(); // track filenames written this run for stale-file cleanup
    for (const [src, entries] of Object.entries(bySource)) {
      if (entries.length === 0) continue;

      // Estimate total bytes for this source
      const totalBytes = entries.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e), 'utf8') + 1, 0);
      const numChunks = Math.ceil(totalBytes / SIDECAR_CHUNK_LIMIT_BYTES);

      if (numChunks === 1) {
        const fname = `descriptions-${src}.jsonl`;
        fs.writeFileSync(path.join(DATA_DIR, fname), entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
        writtenFiles.add(fname);
        console.log(`📄 ${fname}: ${entries.length} entries (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
      } else {
        const perChunk = Math.ceil(entries.length / numChunks);
        for (let i = 0; i < numChunks; i++) {
          const chunk = entries.slice(i * perChunk, (i + 1) * perChunk);
          const fname = `descriptions-${src}-${i + 1}.jsonl`;
          const chunkBytes = chunk.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e), 'utf8') + 1, 0);
          fs.writeFileSync(path.join(DATA_DIR, fname), chunk.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
          writtenFiles.add(fname);
          console.log(`📄 ${fname}: ${chunk.length} entries (${(chunkBytes / 1024 / 1024).toFixed(1)} MB)`);
        }
      }
    }

    // Stale file cleanup: remove any descriptions-*.jsonl files on disk (and in git) that
    // were not written this run. Covers both chunk-count transitions (1→2 and 2→1).
    // descriptions.jsonl (no dash-source suffix) is the Workday fetch cache — never touched here.
    const existingSidecarFiles = fs.readdirSync(DATA_DIR)
      .filter(f => /^descriptions-.+\.jsonl$/.test(f) && !f.startsWith('descriptions-enriched') && !f.startsWith('descriptions-workday') && !f.startsWith('descriptions-smartrecruiters')); // skip enrichment-owned + legacy WD/SR files (incl. chunks)
    for (const fname of existingSidecarFiles) {
      if (!writtenFiles.has(fname)) {
        fs.unlinkSync(path.join(DATA_DIR, fname));
        execSync(`git rm --cached ".github/data/${fname}" 2>/dev/null || true`);
        console.log(`🗑️  Removed stale sidecar: ${fname}`);
      }
    }

    // NOTE: do NOT delete descriptions.jsonl — it is the Workday incremental fetch cache.
    // Step 1b reads it to know which Workday IDs are already fetched, avoiding redundant HTTP calls.
    // descriptions-workday.jsonl (written above) is the published sidecar for enrich-jobs.js.
    // descriptions.jsonl remains local state only — it is NOT staged for git push.

    console.log('');

    // Step 9: Write output files
    console.log('💾 Step 9: Writing output files...');
    _stepStart = Date.now();
    console.log('━'.repeat(60));

    // Strip pipeline internals before writing public output file
    // (source_url, source_id, _raw are internal — not needed downstream)
    // Note: 'source' is kept for downstream observability (which ATS produced each job)
    const STRIP_FIELDS = ['source_url', 'source_id', '_raw', 'description', 'enriched', 'enriched_at', 'is_internship', 'is_new_grad', 'is_us_only', 'remote'];
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
      const cutoffMs = Date.now() - DEDUPE_TTL_MS;
      const currentIds = new Set(publicJobs.map(j => j.id));
      // Fingerprint guard: prevents re-injection of jobs that changed ID (e.g. WD-ID-BUG fix)
      const currentFingerprints = new Set(publicJobs.map(j => j.fingerprint).filter(Boolean));
      const prevLines = fs.readFileSync(JOBS_OUTPUT_FILE, 'utf8').trim().split('\n').filter(Boolean);

      // AGG-6/AGG-32: Preserve earlier posted_at and filter stale — single pass
      resolvePostedAt(publicJobs, prevLines);

      mergeCarryForward(publicJobs, prevLines, currentIds, currentFingerprints, STRIP_FIELDS, cutoffMs);
    }

    // Generate tag stats from full pool (post-merge + post-AGG-32 filter).
    tagStats = computeFullPoolTagStats(publicJobs);

    // TAG-AUDIT-4: Pipeline-code drift detection.
    // Samples US jobs, re-runs tagDomains() on title-only, compares to pipeline tags.
    // Flags if >5% drift — indicates carry-forward masking classification changes.
    try {
      const driftReport = checkTagDrift(publicJobs, tagDomains, 500);
      printDriftReport(driftReport);
      if (driftReport.warnings.length > 0) {
        console.log('⚠️  TAG DRIFT WARNING — consider re-tagging carry-forward jobs');
      }
    } catch (driftErr) {
      console.warn('⚠️ Drift check failed (non-blocking):', driftErr.message);
    }

    // TAG-AUDIT-5: Per-domain precision monitoring.
    // Checks consumer-facing domains for known FP patterns.
    // Flags if >3% FP rate in any domain.
    try {
      const precisionReport = checkDomainPrecision(publicJobs);
      printPrecisionReport(precisionReport);
      if (precisionReport.warnings.length > 0) {
        console.log('⚠️  PRECISION WARNING — FP rate exceeds threshold in one or more domains');
      }
    } catch (precErr) {
      console.warn('⚠️ Precision check failed (non-blocking):', precErr.message);
    }

    // AGG-COMPANY-2: Discovery diagnostic — auto-detect companies needing overrides.
    // Compares senior-filter decisions vs tag-engine employment classification per company.
    // Flags companies where the filter rate is high AND most filtering is title-based (not experience).
    // Non-blocking: errors logged but never stop the pipeline.
    try {
      const OVERRIDE_CANDIDATES_FILE = path.join(DATA_DIR, 'override-candidates.json');
      const MIN_JOBS_THRESHOLD = 10;
      const HIGH_FILTER_RATE = 0.80;
      const TITLE_FILTER_SHARE = 0.70;

      const companyFiltered = {};
      for (const job of seniorJobs) {
        const c = job.company_name || 'unknown';
        if (!companyFiltered[c]) companyFiltered[c] = { total: 0, senior_title: 0, senior_experience: 0, both: 0 };
        companyFiltered[c].total++;
        const reason = job._filter_reason || 'unknown';
        if (reason === 'senior_title' || reason === 'both') companyFiltered[c].senior_title++;
        if (reason === 'senior_experience' || reason === 'both') companyFiltered[c].senior_experience++;
        if (reason === 'both') companyFiltered[c].both++;
      }

      const companyPool = {};
      for (const job of publicJobs) {
        const c = job.company_name || 'unknown';
        if (!companyPool[c]) companyPool[c] = { total: 0, senior_tagged: 0, mid_tagged: 0, entry_tagged: 0 };
        companyPool[c].total++;
        const emp = job.tags?.employment;
        if (emp === 'senior') companyPool[c].senior_tagged++;
        else if (emp === 'mid_level') companyPool[c].mid_tagged++;
        else if (emp === 'entry_level') companyPool[c].entry_tagged++;
      }

      const candidates = [];
      for (const [company, filtered] of Object.entries(companyFiltered)) {
        const pool = companyPool[company] || { total: 0 };
        const totalForCompany = filtered.total + pool.total;
        if (totalForCompany < MIN_JOBS_THRESHOLD) continue;

        const filterRate = filtered.total / totalForCompany;
        if (filterRate < HIGH_FILTER_RATE) continue;

        const titleShare = filtered.senior_title / (filtered.total || 1);
        if (titleShare < TITLE_FILTER_SHARE) continue;

        const hasOverride = companyOverrideMap.has(company);
        candidates.push({
          company,
          total_fetched: totalForCompany,
          senior_filtered: filtered.total,
          in_pool: pool.total,
          filter_rate: +(filterRate * 100).toFixed(1),
          title_filter_pct: +(titleShare * 100).toFixed(1),
          senior_tagged_in_pool: pool.senior_tagged || 0,
          has_override: hasOverride,
          recommendation: hasOverride ? 'existing_override_check_accuracy' : 'add_override',
        });
      }

      candidates.sort((a, b) => b.senior_filtered - a.senior_filtered);
      fs.writeFileSync(OVERRIDE_CANDIDATES_FILE, JSON.stringify({ generated: new Date().toISOString(), candidates, threshold: { min_jobs: MIN_JOBS_THRESHOLD, filter_rate: HIGH_FILTER_RATE, title_share: TITLE_FILTER_SHARE } }, null, 2), 'utf8');
      console.log(`🔍 AGG-COMPANY-2: ${candidates.length} override candidates → override-candidates.json`);
      if (candidates.length > 0 && candidates.length <= 10) {
        for (const c of candidates) {
          console.log(`   ${c.has_override ? '🔄' : '🆕'} ${c.company}: ${c.senior_filtered}/${c.total_fetched} filtered (${c.filter_rate}%)`);
        }
      }
    } catch (e) {
      console.warn(`⚠️ AGG-COMPANY-2: Diagnostic failed (non-critical): ${e.message}`);
    }

    // Archive expiring jobs BEFORE overwriting all_jobs.json
    const { getExpiringJobs, appendToWeeklyArchive } = require(`${SHARED}/utils/archiver`);
    const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
    const expiringJobs = getExpiringJobs(JOBS_OUTPUT_FILE, publicJobs);
    if (expiringJobs.length > 0) {
      const archiveFile = appendToWeeklyArchive(expiringJobs, ARCHIVE_DIR);
      console.log(`📦 Archived ${expiringJobs.length} expiring jobs → ${path.basename(archiveFile)}`);
    } else {
      console.log('📦 No expiring jobs this run');
    }

    // Write jobs (JSONL format)
    await writeJobsJSONL(publicJobs, JOBS_OUTPUT_FILE);

    // Write metadata
    // Use publicJobs (full 7-day rolling window) for pool-level stats (by_source, top_companies, freshness).
    // sortedJobs is current-run only — stats must use publicJobs (full 7-day window).
    const duration = Date.now() - startTime;
    stageTimings.step9_write_ms = Date.now() - _stepStart;
    const metadata = generateMetadata(publicJobs, dedupedJobs.length, duplicates, duration, tagStats, validationMetrics, seniorFilterMetrics, seniorJobs, zeroYieldCompanies, stageTimings);
    await writeMetadata(metadata, METADATA_OUTPUT_FILE);

    console.log('');
    console.log(`✅ Step 9 complete: Output files written`);
    console.log('');

    // Step 10: Print summary
    printSummary(sortedJobs, dedupedJobs.length, duplicates, duration);

    // Step 11: Print tag distribution
    printTagDistribution(sortedJobs);

    // Step 12: Git commit (unless dry run)
    _stepStart = Date.now();
    if (!isDryRun) {
      console.log('📝 Step 12: Committing to git...');
      console.log('━'.repeat(60));

      await gitCommit(sortedJobs.length);

      console.log('');
      console.log(`✅ Step 12 complete: Changes committed`);
      stageTimings.step12_commit_ms = Date.now() - _stepStart;
    } else {
      console.log('⏭️  Step 12: Skipping git commit (dry run)');
      stageTimings.step12_commit_ms = 0;
    }

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
function computeZeroYield(atsResult, fetcherResults, companyListPath) {
  try {
    const companyList = JSON.parse(fs.readFileSync(companyListPath, 'utf8'));

    // Build set of company names that produced jobs this run (ATS only)
    const companiesWithJobs = new Set(Object.keys(atsResult.stats.by_company || {}));

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
        if (name && !companiesWithJobs.has(name)) {
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
function generateMetadata(jobs, uniqueCount, duplicateCount, duration, tagStats, validationMetrics, seniorFilterMetrics, seniorJobs, zeroYieldCompanies, stageTimings) {
  const bySource = {};
  const byEmploymentType = {};
  const byInternship = { internship: 0, 'new-grad': 0, mid_level: 0 };
  const byRemote = { remote: 0, onsite: 0 };
  const companyCounts = {};
  const companyDomains = {};  // DASH-4b: track domain distribution per company

  const now = Date.now();
  const freshness = { last_1h: 0, last_6h: 0, last_24h: 0, last_48h: 0 };

  for (const job of jobs) {
    // Count by source
    bySource[job.source] = (bySource[job.source] || 0) + 1;

    // Count by employment type (handle null/missing/non-array)
    const types = job.employment_types || [];
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

  return {
    version: '1.0',
    generated: new Date().toISOString(),
    duration_ms: duration,

    total_jobs: jobs.length,
    unique_jobs: uniqueCount,
    duplicates_removed: duplicateCount,

    by_source: bySource,
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
    },

    // Tag statistics (Phase 1)
    tag_stats: tagStats,

    // Freshness — jobs posted within last N hours (entry-level pool)
    freshness,

    // Top 20 companies by job count (entry-level pool)
    top_companies,

    // GAP-6: Companies that returned 0 raw jobs this run (pre-filter).
    // Used by pipeline-alert.js for consecutive-failure detection.
    zero_yield_companies: zeroYieldCompanies || [],

    // INF-OBSERV-3: Per-stage timing breakdown (ms)
    stage_timings: stageTimings || {},
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

/**
 * Commit changes to git
 * @param {number} jobCount - Number of jobs for commit message
 */
async function gitCommit(jobCount) {
  const { execSync } = require('child_process');

  try {
    // Configure git
    execSync('git config user.email "bot@zapplyjobs.com"');
    execSync('git config user.name "Data Bot"');

    // Add output files
    execSync('git add .github/data/all_jobs.json');
    execSync('git add .github/data/jobs-metadata.json');
    execSync('git add .github/data/dedupe-store.json');
    execSync('git add .github/data/wd-totals-cache.json 2>/dev/null || true'); // AGG-SPEED-2: WD incremental fetch cache
    execSync('git add .github/data/filtered_jobs.json 2>/dev/null || true'); // senior-filter summary for analytics (PIPELINE-1)
    execSync('git add .github/data/filtered-samples.jsonl 2>/dev/null || true'); // AGG-DATA-8: sampled filtered jobs for FP spot-check
    // archive/ is NOT staged here — pushed separately to jobs-archive-private repo via workflow
    execSync('git add .github/data/descriptions-*.jsonl 2>/dev/null || true'); // per-source description sidecars (published)
    // descriptions.jsonl is Workday fetch cache — NOT staged (local state only, managed by Step 1b)

    // Check if there are changes
    const status = execSync('git status --porcelain', { encoding: 'utf8' });

    if (!status.trim()) {
      console.log('ℹ️ No changes to commit');
      return;
    }

    // Create commit message
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].substring(0, 5);

    const commitMessage = `Update jobs - ${dateStr} ${timeStr}\n\n${jobCount} jobs in shared database`;

    // Commit
    execSync(`git commit -m "${commitMessage}"`);

    console.log(`✅ Committed: ${jobCount} jobs`);

  } catch (error) {
    console.error('⚠️ Git commit failed:', error.message);
    throw error;
  }
}

// Run main function
if (require.main === module) {
  main();
}

module.exports = { main };
