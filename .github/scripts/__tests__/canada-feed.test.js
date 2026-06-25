#!/usr/bin/env node
'use strict';

// CANADA-LANE feed partition tests.
// Mirrors us-snapshot.test.js: exercises the producer-owned tag-driven partition (buildCanadaTechFeed,
// buildCanadaInternshipsFeed, buildCanadaSentinelChecks) exported from ../index. No framework —
// plain node + assert, run by the gate workflow (.github/workflows/gate.yml).

const assert = require('assert');
const {
  buildCanadaTechFeed,
  buildCanadaInternshipsFeed,
  buildCanadaSentinelChecks,
} = require('../index');

// --- Fixtures -----------------------------------------------------------------

// Pure canada tech job (Toronto, software, entry-level) — must be in BOTH the tech feed and the
// internships (entry_level + internship) feed.
const canadaTechEntry = {
  id: 'workday-can-1', source: 'workday', company_name: 'Shopify', title: 'iOS Engineer',
  location: 'Toronto, ON', tags: { locations: ['canada'], employment: 'entry_level', domains: ['software'] },
};

// Dual-tagged canada+us tech job (AGG-8 multi-country rule). Must be KEPT in the canada feed
// (dual-tag policy: a "Canada; United States" job appears in BOTH us_jobs and canada feeds).
const canadaUsDual = {
  id: 'oracle-can-2', source: 'oracle', company_name: 'Oracle', title: 'Data Scientist',
  location: 'Canada; United States', tags: { locations: ['canada', 'us'], employment: 'mid_level', domains: ['data_science'] },
};

// Canada tech internship — must be in the tech feed AND the internships feed.
const canadaTechIntern = {
  id: 'ashby-can-3', source: 'ashby', company_name: 'Ashby', title: 'ML Intern',
  location: 'Vancouver, BC', tags: { locations: ['canada'], employment: 'internship', domains: ['ai'] },
};

// Canada NON-tech job (product domain) — must NOT be in the canada TECH feed.
const canadaNonTech = {
  id: 'greenhouse-can-4', source: 'greenhouse', company_name: 'Foo', title: 'Product Manager',
  location: 'Montreal, QC', tags: { locations: ['canada'], employment: 'mid_level', domains: ['product'] },
};

// US-only tech job — must NOT be in the canada feed (zero US leak into canada lane).
const usOnlyTech = {
  id: 'greenhouse-us-5', source: 'greenhouse', company_name: 'Bar', title: 'Backend Engineer',
  location: 'San Francisco, CA', tags: { locations: ['us'], employment: 'mid_level', domains: ['software'] },
};

// Suspicious leak: tagged canada-ONLY (no us, no remote) but raw location text reads US-only
// (US cue matches, canada cue does not). The sentinel must FLAG this (suspicious_us_only_location).
const suspiciousUsOnly = {
  id: 'lever-leak-6', source: 'lever', company_name: 'Leaky', title: 'Frontend Engineer',
  location: 'Austin, TX', tags: { locations: ['canada'], employment: 'mid_level', domains: ['software'] },
};

const POOL = [canadaTechEntry, canadaUsDual, canadaTechIntern, canadaNonTech, usOnlyTech];

// --- 1. Partition correctness -------------------------------------------------

const feed = buildCanadaTechFeed(POOL);
const ids = feed.jobs.map(j => j.id);

assert.ok(ids.includes('workday-can-1'), 'pure canada tech job must be in the canada tech feed');
assert.ok(ids.includes('oracle-can-2'), 'dual-tagged canada+us tech job must be KEPT (dual-tag policy)');
assert.ok(ids.includes('ashby-can-3'), 'canada tech internship must be in the canada tech feed');
assert.ok(!ids.includes('greenhouse-can-4'), 'canada NON-tech job must NOT be in the canada tech feed');
assert.ok(!ids.includes('greenhouse-us-5'), 'US-only tech job must NOT leak into the canada feed');

// Summary counts.
assert.strictEqual(feed.summary.canada_tech_jobs, 3, 'canada_tech_jobs count');
assert.strictEqual(feed.summary.canada_jobs, 4, 'canada_jobs total (incl. the non-tech canada row)');
assert.strictEqual(feed.summary.canada_tech_internships, 1, 'canada_tech_internships count');
assert.strictEqual(feed.summary.contract_version, 'canada-tech-feed-v1', 'contract_version stamp');
assert.deepStrictEqual(
  [...feed.summary.included_domains].sort(),
  ['ai', 'data_science', 'hardware', 'software'],
  'included_domains must be the tech slice',
);

console.log('PASS partition correctness (canada tag + tech domain selection, dual-tag keep, US-exclusion)');

// --- 2. Internships lane (entry_level + internship subset) --------------------

const internships = buildCanadaInternshipsFeed(feed.jobs);
const internIds = internships.map(j => j.id);

assert.ok(internIds.includes('workday-can-1'), 'entry_level canada tech job must be in internships feed');
assert.ok(internIds.includes('ashby-can-3'), 'internship canada tech job must be in internships feed');
assert.ok(!internIds.includes('oracle-can-2'), 'mid_level canada tech job must NOT be in internships feed');
assert.strictEqual(internIds.length, 2, 'internships feed = entry_level + internship only');

console.log('PASS internships lane (entry_level + internship subset of canada tech feed)');

// --- 3. Sentinel FP guard -----------------------------------------------------

// 3a. Clean pool (no suspicious leaks) — sentinel passes.
const cleanChecks = buildCanadaSentinelChecks(feed.jobs);
assert.strictEqual(cleanChecks.passed, true, 'clean canada tech feed must pass sentinel checks');
assert.strictEqual(cleanChecks.checks.missing_canada_tag, 0, 'no missing-canada-tag in clean feed');
assert.strictEqual(cleanChecks.checks.non_tech_domain, 0, 'no non-tech-domain in clean feed');
assert.strictEqual(cleanChecks.checks.suspicious_us_only_location, 0, 'no suspicious US-only in clean feed');

// 3b. Pool WITH a suspicious leak — sentinel flags it and does NOT pass.
const leakyChecks = buildCanadaSentinelChecks([...feed.jobs, suspiciousUsOnly]);
assert.strictEqual(leakyChecks.passed, false, 'a US-only-text canada-tagged row must fail the sentinel');
assert.strictEqual(leakyChecks.checks.suspicious_us_only_location, 1, 'suspicious_us_only_location must count the leak');
assert.ok(leakyChecks.suspicious_us_only_samples.some(s => s.id === 'lever-leak-6'), 'leak sample must be captured');

// 3c. A dual-tagged (canada+us) row with US-only text must NOT flag — the us tag disqualifies
// canadaOnly, so a genuine dual-country posting is never a false alarm.
const dualUsTextChecks = buildCanadaSentinelChecks([canadaUsDual]);
assert.strictEqual(dualUsTextChecks.passed, true, 'dual-tagged canada+us row must not trigger the sentinel');

console.log('PASS sentinel FP guard (clean passes, US-only leak flagged, dual-tag whitelisted)');

// --- 4. Empty input -----------------------------------------------------------

const empty = buildCanadaTechFeed([]);
assert.strictEqual(empty.jobs.length, 0, 'empty pool yields empty canada tech feed');
assert.strictEqual(empty.summary.canada_tech_jobs, 0, 'empty pool yields zero canada_tech_jobs');
assert.strictEqual(empty.summary.canada_jobs, 0, 'empty pool yields zero canada_jobs');
assert.strictEqual(empty.summary.sentinel_false_positive_checks.passed, true, 'empty feed must still pass the sentinel');
assert.strictEqual(buildCanadaInternshipsFeed(empty.jobs).length, 0, 'empty pool yields empty internships feed');

console.log('PASS empty input (empty feeds, sentinel still passes)');

console.log('\n✅ canada-feed: all partition/sentinel/dual-tag/empty checks passed');
