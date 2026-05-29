#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { mergeCarryForward, RETIRED_CARRY_FORWARD_SOURCES } = require('../index');

function line(job) {
  return JSON.stringify(job);
}

const now = new Date().toISOString();

assert.ok(RETIRED_CARRY_FORWARD_SOURCES.has('jsearch'), 'jsearch must be retired');

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
  assert.strictEqual(publicJobs.length, 0, 'retired jsearch jobs must not carry forward');
}

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
}

console.log('PASS carry-forward retired source guard');
