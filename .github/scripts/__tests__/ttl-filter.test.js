#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { resolvePostedAt, applicableTtlMs } = require('../index');

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

assert.deepStrictEqual(publicJobs.map(job => job.id), ['valid-internship']);

console.log('PASS TTL filter removes beyond-window jobs');
