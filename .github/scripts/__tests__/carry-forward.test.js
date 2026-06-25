#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { mergeCarryForward, RETIRED_CARRY_FORWARD_SOURCES, LIFECYCLE_VERSION } = require('../index');

function line(job) {
  return JSON.stringify(job);
}

const now = new Date().toISOString();

assert.ok(RETIRED_CARRY_FORWARD_SOURCES.has('jsearch'), 'jsearch must be retired');

// Case 1: retired-source job is now KEPT + tagged 'dead' (previously dropped).
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
  assert.strictEqual(publicJobs.length, 1, 'retired jsearch jobs are now KEPT (TAG-AND-KEEP)');
  assert.strictEqual(publicJobs[0].tags.lifecycle_state, 'dead', 'retired-source job tagged dead');
  assert.strictEqual(publicJobs[0].tags.lifecycle_version, LIFECYCLE_VERSION, 'dead job carries lifecycle_version');
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

// Case 3: fresh job whose source fetched successfully is KEPT + tagged 'dead' (ghost/closed).
// (Previously DROPPED via closed-detection. Uses a fresh posted_at so it reaches the closed branch
// rather than the TTL branch, isolating the closed→dead lifecycle path.)
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
  assert.strictEqual(publicJobs.length, 1, 'closed/ghost job is now KEPT (TAG-AND-KEEP)');
  assert.strictEqual(publicJobs[0].tags.lifecycle_state, 'dead', 'closed job tagged dead');
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
