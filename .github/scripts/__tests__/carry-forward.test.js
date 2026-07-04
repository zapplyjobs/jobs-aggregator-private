#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { mergeCarryForward, RETIRED_CARRY_FORWARD_SOURCES, LIFECYCLE_VERSION } = require('../index');

function line(job) {
  return JSON.stringify(job);
}

const now = new Date().toISOString();

assert.ok(RETIRED_CARRY_FORWARD_SOURCES.has('jsearch'), 'jsearch must be retired');

// Case 1: retired-source job is DROPPED upstream (OPERATOR 2026-07-03; reverses AGG-LIFECYCLE-1 tag-and-keep; dead never reaches R2/consumers).
{
  const publicJobs = [];
  mergeCarryForward(
    publicJobs,
    [line({
      id: 'js-stale-internship',
      source: 'jsearch',
      title: 'Software Engineering Intern',
      company_name: 'Dead Source',
      posted_at: now,
      tags: { employment: 'internship', domains: ['software'], locations: ['us'] },
    })],
    new Set(),
    new Set(),
    [],
    new Set()
  );
  assert.strictEqual(publicJobs.length, 0, 'retired jsearch dead jobs DROPPED upstream (not in pool)');
}

// Case 2: active non-fetched source carries forward within TTL, tagged 'carry-forward'.
{
  const publicJobs = [];
  mergeCarryForward(
    publicJobs,
    [line({
      id: 'greenhouse-live-carry',
      source: 'greenhouse',
      title: 'Software Engineer',
      company_name: 'Active Source',
      posted_at: now,
      tags: { employment: 'entry_level', domains: ['software'], locations: ['us'] },
    })],
    new Set(),
    new Set(),
    [],
    new Set()
  );
  assert.strictEqual(publicJobs.length, 1, 'active non-fetched sources still carry forward within TTL');
  assert.strictEqual(publicJobs[0].tags.lifecycle_state, 'carry-forward', 'alive prior-run job tagged carry-forward');
}

// Case 3: fresh job whose source fetched successfully is DROPPED upstream (OPERATOR 2026-07-03; closed/ghost = dead).
// (Uses a fresh posted_at so it reaches the closed→dead branch, not the TTL branch.)
{
  const publicJobs = [];
  mergeCarryForward(
    publicJobs,
    [line({
      id: 'greenhouse-closed-ghost',
      source: 'greenhouse',
      title: 'Quantitative Researcher Intern',
      company_name: 'Point72',
      posted_at: now,
      tags: { employment: 'internship', domains: ['software'], locations: ['us'] },
    })],
    new Set(),
    new Set(),
    [],
    new Set(['greenhouse'])
  );
  assert.strictEqual(publicJobs.length, 0, 'closed/ghost (dead) job DROPPED upstream (not in pool)');
}

// Case 7: STALE + DEAD job (old posted_at, source fetched OK but absent) is DROPPED upstream.
// OPERATOR-2026-07-04: dead takes precedence over age. Previously this leaked as stale-candidate
// (kept) because the age check fired before the dead check. Regression guard for the precedence fix.
{
  const publicJobs = [];
  const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30d old -> stale-candidate (>14d regular TTL)
  mergeCarryForward(
    publicJobs,
    [line({
      id: 'greenhouse-stale-dead',
      source: 'greenhouse',
      title: 'Backend Engineer',
      company_name: 'Closed Co',
      posted_at: staleDate,
      tags: { employment: 'entry_level', domains: ['software'], locations: ['us'] },
    })],
    new Set(),
    new Set(),
    [],
    new Set(['greenhouse'])  // greenhouse fetched OK this run -> job absent = dead
  );
  assert.strictEqual(publicJobs.length, 0, 'stale-candidate + dead (source absent) job DROPPED upstream (dead takes precedence over age)');
}


// Case 4: carry-forward Canada row, tagged 'carry-forward'; location tags recomputed.
{
  const publicJobs = [];
  mergeCarryForward(
    publicJobs,
    [line({
      id: 'workday-canada-carry',
      source: 'workday',
      title: 'Manufacturing Engineer',
      company_name: 'Magna',
      company_slug: 'magna',
      location: 'Mississauga, Ontario, CA',
      job_city: 'Mississauga',
      job_state: 'CA',
      posted_at: now,
      tags: { employment: 'entry_level', domains: ['manufacturing'], locations: ['us'], tag_engine_version: 30 },
    })],
    new Set(),
    new Set(),
    [],
    new Set()
  );
  assert.strictEqual(publicJobs.length, 1, 'carry-forward Canada row should remain in rolling pool');
  assert.strictEqual(publicJobs[0].tags.lifecycle_state, 'carry-forward', 'canada carry-forward tagged carry-forward');
  assert.deepStrictEqual(publicJobs[0].tags.locations, ['canada'], 'carry-forward location tags must be recomputed from current tagLocations logic');
}

// Case 5: carry-forward India row, tagged 'carry-forward'; stale us tag dropped.
{
  const publicJobs = [];
  mergeCarryForward(
    publicJobs,
    [line({
      id: 'workday-india-carry',
      source: 'workday',
      title: 'Memory Circuit Design Engineer',
      company_name: 'Micron',
      company_slug: 'micron',
      location: 'Hyderabad - Phoenix Aquila, India',
      job_city: 'Hyderabad - Phoenix Aquila',
      job_state: '',
      posted_at: now,
      tags: { employment: 'entry_level', domains: ['hardware'], locations: ['us'], tag_engine_version: 56 },
    })],
    new Set(),
    new Set(),
    [],
    new Set()
  );
  assert.strictEqual(publicJobs.length, 1, 'carry-forward India row should remain in rolling pool');
  assert.strictEqual(publicJobs[0].tags.lifecycle_state, 'carry-forward', 'india carry-forward tagged carry-forward');
  assert.deepStrictEqual(publicJobs[0].tags.locations, [], 'carry-forward India row must drop stale us tag');
}

// Case 6: carry-forward Heredia row, tagged 'carry-forward'; stale us tag dropped.
{
  const publicJobs = [];
  mergeCarryForward(
    publicJobs,
    [line({
      id: 'workday-heredia-carry',
      source: 'workday',
      title: 'Junior Analyst, Channel Operations',
      company_name: 'Baxter International',
      company_slug: 'baxter-international',
      location: 'La Aurora, Heredia',
      job_city: 'La Aurora',
      job_state: '',
      posted_at: now,
      tags: { employment: 'entry_level', domains: ['operations'], locations: ['us'], tag_engine_version: 56 },
    })],
    new Set(),
    new Set(),
    [],
    new Set()
  );
  assert.strictEqual(publicJobs.length, 1, 'carry-forward Heredia row should remain in rolling pool');
  assert.strictEqual(publicJobs[0].tags.lifecycle_state, 'carry-forward', 'heredia carry-forward tagged carry-forward');
  assert.deepStrictEqual(publicJobs[0].tags.locations, [], 'carry-forward Heredia row must drop stale us tag');
}

console.log('PASS carry-forward lifecycle tag-and-keep');
