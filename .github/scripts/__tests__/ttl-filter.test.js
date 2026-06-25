#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { resolvePostedAt, applicableTtlMs, LIFECYCLE_VERSION } = require('../index');

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const oldRegular = { id: 'old-regular', posted_at: daysAgo(15), tags: { employment: 'entry_level' } };
const validInternship = { id: 'valid-internship', posted_at: daysAgo(119), tags: { employment: 'internship' } };
const oldInternship = { id: 'old-internship', posted_at: daysAgo(121), tags: { employment: 'internship' } };
const legacyInternship = { id: 'legacy-internship', posted_at: daysAgo(121), employment_type: 'internship', tags: { employment: 'entry_level' } };

assert.ok(applicableTtlMs(validInternship) > applicableTtlMs(oldRegular), 'internship TTL must exceed regular TTL');

const publicJobs = [oldRegular, validInternship, oldInternship, legacyInternship];
resolvePostedAt(publicJobs, []);

// AGG-LIFECYCLE-1: previously these stale jobs were DROPPED; now they are KEPT + tagged.
assert.deepStrictEqual(
  publicJobs.map(job => job.id).sort(),
  ['legacy-internship', 'old-internship', 'old-regular', 'valid-internship'],
  'all jobs must survive — TAG-AND-KEEP, no drops'
);

const byId = Object.fromEntries(publicJobs.map(j => [j.id, j]));
assert.strictEqual(byId['valid-internship'].tags.lifecycle_state, 'evergreen', 'within-window but >10d internship is evergreen');
assert.strictEqual(byId['old-regular'].tags.lifecycle_state, 'stale-candidate', 'beyond-TTL regular is stale-candidate');
assert.strictEqual(byId['old-internship'].tags.lifecycle_state, 'stale-candidate', 'beyond-TTL internship is stale-candidate');
assert.strictEqual(byId['legacy-internship'].tags.lifecycle_state, 'stale-candidate', 'beyond-TTL legacy internship is stale-candidate');
for (const job of publicJobs) {
  assert.strictEqual(job.tags.lifecycle_version, LIFECYCLE_VERSION, `${job.id} must carry lifecycle_version`);
}

console.log('PASS AGG-LIFECYCLE-1 TTL tag-and-keep (no drops; stale jobs tagged stale-candidate)');
