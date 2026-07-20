#!/usr/bin/env node
'use strict';
// AGG-STALEUPSTREAM-1 (2026-07-04): orphan cleanup test.
// Asserts dropOrphanJobs removes jobs whose company left the active multi-tenant config AND are
// >14d unfetched, while KEEPING (a) configured-company jobs, (b) single-tenant-source jobs,
// (c) recently-fetched orphans (the 14d grace), and (d) orphans with no fetched_at (can't confirm age).
// Also: an empty active set is a no-op (safety — never flag everything as orphan).
const { dropOrphanJobs } = require('../index');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; } else { fail++; console.error(`  FAIL: ${name}`); } }

const DAY = 86400000;
const now = new Date('2026-07-04T12:00:00Z').getTime();
const ago = (d) => new Date(now - d * DAY).toISOString();
const activeWd = new Set(['Configured-Co']);
const activeSR = new Set(['Configured-SR']);

{
  const jobs = [
    { source: 'workday', company_name: 'Sanofi', fetched_at: ago(30) },          // orphan, old -> DROP
    { source: 'workday', company_name: 'Configured-Co', fetched_at: ago(30) },   // configured -> KEEP
    { source: 'workday', company_name: 'RecentlyRemoved', fetched_at: ago(3) },  // orphan, recent -> KEEP (grace)
    { source: 'greenhouse', company_name: 'Anything', fetched_at: ago(60) },     // single-tenant -> KEEP
    { source: 'smartrecruiters', company_name: 'Veolia', fetched_at: ago(40) },  // orphan SR, old -> DROP
    { source: 'smartrecruiters', company_name: 'Configured-SR', fetched_at: ago(30) }, // configured SR -> KEEP
    { source: 'workday', company_name: 'NoDate', fetched_at: null },             // no fetched_at -> KEEP
  ];
  const dropped = dropOrphanJobs(jobs, activeWd, activeSR, 14 * DAY, now);
  const remaining = jobs.map(j => j.company_name);
  check('dropped exactly 2 (Sanofi, Veolia)', dropped === 2);
  check('kept configured workday', remaining.includes('Configured-Co'));
  check('kept recent orphan (within 14d grace)', remaining.includes('RecentlyRemoved'));
  check('kept single-tenant (greenhouse) — not multi-tenant scope', remaining.includes('Anything'));
  check('kept configured smartrecruiters', remaining.includes('Configured-SR'));
  check('kept orphan with no fetched_at (cannot confirm age)', remaining.includes('NoDate'));
  check('removed Sanofi', !remaining.includes('Sanofi'));
  check('removed Veolia', !remaining.includes('Veolia'));
}

// Empty active set -> no-op (safety: never flag everything orphan if the list fails to load).
{
  const jobs = [{ source: 'workday', company_name: 'X', fetched_at: ago(30) }];
  check('empty active set -> no-op (safety)', dropOrphanJobs(jobs, new Set(), new Set(), 14 * DAY, now) === 0);
}

// Empty input.
{
  check('empty input -> 0 dropped', dropOrphanJobs([], activeWd, activeSR) === 0);
}

console.log(`\norphan-filter: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
