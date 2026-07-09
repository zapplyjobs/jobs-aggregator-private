#!/usr/bin/env node
'use strict';

// AGG-LIFECYCLE-1: dedicated coverage for the lifecycle_state classifier + hard-retire guardrail.
// Covers precedence (dead > stale-candidate > evergreen > carry-forward > fresh), the evergreen
// age band, and the anti-flood hard-retire that bounds rolling-pool growth.

const assert = require('assert');
const {
  classifyAgeLifecycle,
  isLifecycleHardRetired,
  resolvePostedAt,
  mergeCarryForward,
  LIFECYCLE_EVERGREEN_THRESHOLD_DAYS,
  LIFECYCLE_VERSION,
} = require('../index');

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
function line(job) { return JSON.stringify(job); }

const REG = { employment: 'entry_level' };   // 14d TTL
const INT = { employment: 'internship' };     // 120d TTL

// --- classifyAgeLifecycle: age bands -------------------------------------------------
assert.strictEqual(classifyAgeLifecycle({ posted_at: null, tags: REG }), 'stale-candidate', 'null posted_at → stale-candidate');
assert.strictEqual(classifyAgeLifecycle({ posted_at: daysAgo(1), tags: REG }), null, '1d → fresh (null)');
assert.strictEqual(classifyAgeLifecycle({ posted_at: daysAgo(12), tags: REG }), 'evergreen', '12d (10d–14d band) → evergreen');
assert.strictEqual(classifyAgeLifecycle({ posted_at: daysAgo(20), tags: REG }), 'stale-candidate', '20d (>14d TTL) → stale-candidate');
assert.strictEqual(classifyAgeLifecycle({ posted_at: daysAgo(100), tags: INT }), 'evergreen', '100d internship (>10d evergreen band, <120d TTL) → evergreen');
assert.strictEqual(classifyAgeLifecycle({ posted_at: daysAgo(115), tags: INT }), 'evergreen', '115d internship (10d–120d band) → evergreen');
assert.strictEqual(classifyAgeLifecycle({ posted_at: daysAgo(125), tags: INT }), 'stale-candidate', '125d internship (>120d TTL) → stale-candidate');
assert.ok(LIFECYCLE_EVERGREEN_THRESHOLD_DAYS === 10, 'evergreen threshold matches evergreen-detector.js');

// --- isLifecycleHardRetired: anti-flood guardrail ------------------------------------
assert.strictEqual(isLifecycleHardRetired({ posted_at: daysAgo(20), tags: REG }), false, '20d regular (within TTL+45d) NOT hard-retired');
assert.strictEqual(isLifecycleHardRetired({ posted_at: daysAgo(70), tags: REG }), true, '70d regular (>14d+45d) hard-retired');
assert.strictEqual(isLifecycleHardRetired({ posted_at: daysAgo(125), tags: INT }), false, '125d internship (within 120d+45d) NOT hard-retired');
assert.strictEqual(isLifecycleHardRetired({ posted_at: daysAgo(200), tags: INT }), true, '200d internship (>120d+45d) hard-retired');
assert.strictEqual(isLifecycleHardRetired({ posted_at: null, tags: REG }), false, 'null posted_at never hard-retired (retained)');

// --- resolvePostedAt: current-run fresh / evergreen / stale-candidate ----------------
{
  // Current-run jobs are never hard-retired (they don't accumulate across runs); all are kept + tagged.
  const jobs = [
    { id: 'f1', posted_at: daysAgo(2),  tags: { ...REG } },
    { id: 'e1', posted_at: daysAgo(12), tags: { ...REG } },
    { id: 's1', posted_at: daysAgo(20), tags: { ...REG } },
    { id: 's2', posted_at: daysAgo(80), tags: { ...REG } }, // very old but current-run → kept
  ];
  resolvePostedAt(jobs, []);
  assert.deepStrictEqual(jobs.map(j => j.id).sort(), ['e1', 'f1', 's1', 's2'], 'all current-run jobs kept (no current-run hard-retire)');
  const byId = Object.fromEntries(jobs.map(j => [j.id, j]));
  assert.strictEqual(byId.f1.tags.lifecycle_state, 'fresh');
  assert.strictEqual(byId.e1.tags.lifecycle_state, 'evergreen');
  assert.strictEqual(byId.s1.tags.lifecycle_state, 'stale-candidate');
  assert.strictEqual(byId.s2.tags.lifecycle_state, 'stale-candidate');
}

// --- mergeCarryForward: OPERATOR 2026-07-03 — dead is DROPPED upstream (reverses AGG-LIFECYCLE-1 tag-and-keep) ---
// A closed job with a fresh date is 'dead' → DROPPED (not in pool), so it never reaches R2/consumers.
{
  const publicJobs = [];
  mergeCarryForward(publicJobs,
    [line({ id: 'closed-fresh', source: 'greenhouse', posted_at: daysAgo(2), tags: { ...REG } })],
    new Set(), new Set(), [], new Set(['greenhouse']));
  assert.strictEqual(publicJobs.length, 0, 'closed (dead) job DROPPED upstream — not in pool');
}
// A TTL-expired job from a successful source is DROPPED as dead (OPERATOR-2026-07-04: dead wins over age).
// Previously kept as stale-candidate; the 2026-07-04 precedence fix drops it — a confirmed-dead job
// (source fetched OK, absent) drops regardless of posted_at age. Age must not rescue a dead job.
{
  const publicJobs = [];
  mergeCarryForward(publicJobs,
    [line({ id: 'stale-closed', source: 'greenhouse', posted_at: daysAgo(30), tags: { ...REG } })],
    new Set(), new Set(), [], new Set(['greenhouse']));
  assert.strictEqual(publicJobs.length, 0, 'TTL-expired + dead (source absent) job DROPPED upstream (dead wins over age, 2026-07-04)');
}
// An evergreen-band job from a non-fetched source is 'evergreen'.
{
  const publicJobs = [];
  mergeCarryForward(publicJobs,
    [line({ id: 'ev-green', source: 'greenhouse', posted_at: daysAgo(12), tags: { ...REG } })],
    new Set(), new Set(), [], new Set());
  assert.strictEqual(publicJobs[0].tags.lifecycle_state, 'evergreen');
}
// A very-old prior-run job is hard-retired (anti-flood) and dropped.
{
  const publicJobs = [];
  mergeCarryForward(publicJobs,
    [line({ id: 'ancient', source: 'greenhouse', posted_at: daysAgo(400), tags: { ...INT } })],
    new Set(), new Set(), [], new Set());
  assert.strictEqual(publicJobs.length, 0, 'ancient prior-run job hard-retired (anti-flood)');
}
// INF-EXPAND-1 Phase 2 (2026-07-09): senior prior-run jobs now CARRY FORWARD (pipeline senior
// filter removed; consumers filter by tags.employment themselves). Pre-Phase-2 these were dropped.
{
  const publicJobs = [];
  mergeCarryForward(publicJobs,
    [line({ id: 'sen-prior', source: 'greenhouse', title: 'Senior Software Engineer', posted_at: daysAgo(2), tags: { ...REG } })],
    new Set(), new Set(), [], new Set());
  assert.strictEqual(publicJobs.length, 1, 'Phase 2: senior prior-run jobs carry forward (pipeline filter removed)');
}
// --- consumers replicate the pre-LIFECYCLE "dropped" set via {dead, stale-candidate} -
{
  const pool = [];
  mergeCarryForward(pool, [
    line({ id: 'alive',   source: 'lever',      posted_at: daysAgo(2),  tags: { ...REG } }), // not fetched → carry-forward
    line({ id: 'ghost',   source: 'greenhouse', posted_at: daysAgo(2),  tags: { ...REG } }), // fetched+absent → dead
    line({ id: 'expired', source: 'lever',      posted_at: daysAgo(30), tags: { ...REG } }), // not fetched but >14d → stale-candidate
  ], new Set(), new Set(), [], new Set(['greenhouse']));
  const visible = pool.filter(j => !['dead', 'stale-candidate'].includes(j.tags.lifecycle_state));
  assert.deepStrictEqual(visible.map(j => j.id), ['alive'], 'excluding {dead, stale-candidate} leaves only alive jobs (pre-LIFECYCLE parity)');
}

assert.ok(LIFECYCLE_VERSION === 1, 'lifecycle version knob present');

console.log('PASS AGG-LIFECYCLE-1 classification + hard-retire + precedence');
