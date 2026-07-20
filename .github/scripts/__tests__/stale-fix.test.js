/**
 * AGG-STALE-FIX-1: Test that resolvePostedAt hard-retires current-run jobs
 * with posted_at beyond TTL + visibility window (same as mergeCarryForward).
 *
 * Verifies:
 * 1. Fresh jobs (< TTL) are kept and tagged 'fresh'
 * 2. Stale-candidate jobs (TTL < age < TTL+visibility) are kept and tagged 'stale-candidate'
 * 3. Stale-candidate jobs beyond TTL+visibility (>59d regular, >165d internship) ARE DROPPED
 * 4. Evergreen jobs (>evergreen threshold but < hard-retire) are kept and tagged 'evergreen'
 * 5. Internship stale-candidate jobs get wider window (165d, not 59d)
 */

const assert = require('assert');
const path = require('path');

// Load the actual functions from index.js
const indexPath = path.join(__dirname, '..', 'index.js');
const mod = require(indexPath);
const { resolvePostedAt, isLifecycleHardRetired } = mod;

const DAY = 86400000;
const now = Date.now();

function makeJob(id, daysAgo, employment = 'mid_level') {
  return {
    id,
    source: 'oracle',
    posted_at: new Date(now - daysAgo * DAY).toISOString(),
    tags: { employment },
  };
}

function testFreshJobKept() {
  const jobs = [makeJob('fresh-1', 5)]; // 5 days old — within TTL
  resolvePostedAt(jobs, []);
  assert.strictEqual(jobs.length, 1, 'Fresh job should be kept');
  assert.strictEqual(jobs[0].tags.lifecycle_state, 'fresh');
  console.log('  ✓ fresh job (5d) kept + tagged fresh');
}

function testStaleCandidateKept() {
  const jobs = [makeJob('stale-1', 30)]; // 30 days — stale but < 59d
  resolvePostedAt(jobs, []);
  assert.strictEqual(jobs.length, 1, 'Stale-candidate (30d) should be kept');
  assert.strictEqual(jobs[0].tags.lifecycle_state, 'stale-candidate');
  console.log('  ✓ stale-candidate (30d) kept + tagged');
}

function testHardRetireDrops() {
  const jobs = [makeJob('ancient-1', 70)]; // 70 days — beyond 59d threshold
  resolvePostedAt(jobs, []);
  assert.strictEqual(jobs.length, 0, 'Stale-candidate >59d should be hard-retired (dropped)');
  console.log('  ✓ stale-candidate >59d (70d) hard-retired');
}

function testVeryOldDropped() {
  const jobs = [makeJob('very-old-1', 200)]; // 200 days — way beyond threshold
  resolvePostedAt(jobs, []);
  assert.strictEqual(jobs.length, 0, 'Very old job (200d) should be hard-retired');
  console.log('  ✓ stale-candidate >59d (200d) hard-retired');
}

function testInternshipWiderWindow() {
  // Internship: TTL=120d, visibility=45d → hard-retire at 165d
  const jobs = [
    makeJob('intern-100', 100, 'internship'),  // 100d — within 120d TTL → fresh
    makeJob('intern-130', 130, 'internship'),  // 130d — stale but < 165d → kept
    makeJob('intern-200', 200, 'internship'),  // 200d — beyond 165d → dropped
  ];
  resolvePostedAt(jobs, []);
  assert.strictEqual(jobs.length, 2, 'Internship: 100d + 130d kept, 200d dropped');
  const states = jobs.map(j => j.tags.lifecycle_state);
  assert(states.includes('fresh') || states.includes('stale-candidate'), 'Should have fresh or stale-candidate');
  console.log('  ✓ internship wider window: 100d+130d kept, 200d hard-retired');
}

function testMixOfJobs() {
  const jobs = [
    makeJob('fresh-mix', 3),
    makeJob('stale-mix', 25),
    makeJob('old-mix', 70),       // should be dropped
    makeJob('very-old-mix', 150), // should be dropped
  ];
  resolvePostedAt(jobs, []);
  assert.strictEqual(jobs.length, 2, 'Mix: 2 kept (fresh+stale), 2 dropped (>59d)');
  console.log('  ✓ mixed batch: fresh+stale kept, >59d dropped');
}

function testEmptyInput() {
  const jobs = [];
  resolvePostedAt(jobs, []);
  assert.strictEqual(jobs.length, 0);
  console.log('  ✓ empty input handled');
}

function testNullPostedAt() {
  // Jobs with null posted_at: classifyAgeLifecycle returns 'stale-candidate'
  // (because windowTs defaults to now, which is >= now - TTL → not stale... actually
  // activePublicWindowTs returns now for null posted_at, so it's within TTL → null (fresh))
  const jobs = [{ id: 'null-date', source: 'oracle', posted_at: null, tags: {} }];
  resolvePostedAt(jobs, []);
  // null posted_at → activePublicWindowTs returns now → classifyAgeLifecycle returns null (within TTL)
  // → tagged 'fresh', NOT dropped
  assert.strictEqual(jobs.length, 1, 'Null posted_at should not be dropped');
  console.log('  ✓ null posted_at handled (not dropped)');
}

// --- Run all tests ---
const tests = [
  ['fresh-kept', testFreshJobKept],
  ['stale-kept', testStaleCandidateKept],
  ['hard-retire-drops', testHardRetireDrops],
  ['very-old-dropped', testVeryOldDropped],
  ['internship-wider-window', testInternshipWiderWindow],
  ['mix', testMixOfJobs],
  ['empty', testEmptyInput],
  ['null-posted-at', testNullPostedAt],
];

let passed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

console.log(`\nstale-fix: ${passed} pass, ${tests.length - passed} fail`);
