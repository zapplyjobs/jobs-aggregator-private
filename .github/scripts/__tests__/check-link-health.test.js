#!/usr/bin/env node
'use strict';

// AGG-DEADNESS-1 (bounded): coverage for the Simplify age-bypass sampler in check-link-health.js.
// The BAE class (Simplify-sourced, re-stamped posted_at=today every run) is ALWAYS age<minAgeDays,
// so it slips through the regular 2–4d age window. The bypass samples Simplify REGARDLESS of age so
// hard-404/410 dead links surface in the evidence feed. Bot-blocked companies (Tesla/Citadel) are
// excluded (budget/noise). 404/410 remain the only 'dead' codes in checkUrl (unchanged here).

const assert = require('assert');
const {
  parseArgs,
  buildSamples,
  isBotBlocked,
  BOT_BLOCKED_COMPANIES,
} = require('../check-link-health');

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function mkJob({ id, source, company_name, postedDaysAgo, url = 'https://boards.greenhouse.io/x/j', domains = ['software'], locations = ['us'] }) {
  return { id, source, company_name, title: `Job ${id}`, posted_at: daysAgo(postedDaysAgo), url, tags: { domains, locations } };
}

function groupIds(samples, group) {
  return samples.filter(s => s.group === group).map(s => s.id).sort();
}

// --- Case 1: the BAE class — Simplify job re-stamped today (age 0) MUST be sampled ---
{
  const jobs = [
    mkJob({ id: 'gh1', source: 'greenhouse', company_name: 'Acme', postedDaysAgo: 3 }),
    mkJob({ id: 'BAE1US118005', source: 'simplify', company_name: 'BAE Systems', postedDaysAgo: 0 }),
  ];
  const args = parseArgs([]);
  const { samples } = buildSamples(jobs, args);
  const simplifyFresh = groupIds(samples, 'simplify-fresh');
  assert.ok(simplifyFresh.includes('BAE1US118005'),
    're-stamped-fresh (age 0) Simplify job must be sampled via the age bypass — the whole point of AGG-DEADNESS-1');
  assert.ok(groupIds(samples, 'greenhouse').includes('gh1'), 'regular in-window greenhouse job still sampled');
  // And it must NOT leak into a regular group (age 0 < minAgeDays).
  assert.ok(!samples.some(s => s.id === 'BAE1US118005' && s.group !== 'simplify-fresh'),
    'age-0 Simplify job must only appear in simplify-fresh, never a regular age-windowed group');
  console.log('✓ case 1: BAE re-stamped-fresh Simplify job sampled via age bypass');
}

// --- Case 2: bot-blocked companies excluded from the Simplify pass ---
{
  const jobs = [
    mkJob({ id: 's1', source: 'simplify', company_name: 'BAE Systems', postedDaysAgo: 0 }),
    mkJob({ id: 's2', source: 'simplify', company_name: 'Tesla', postedDaysAgo: 0 }),
    mkJob({ id: 's3', source: 'simplify', company_name: 'Citadel Securities', postedDaysAgo: 0 }),
  ];
  const args = parseArgs([]);
  const { samples } = buildSamples(jobs, args);
  const simplifyFresh = groupIds(samples, 'simplify-fresh');
  assert.deepStrictEqual(simplifyFresh, ['s1'], 'Tesla + Citadel Securities must be excluded (bot-blocked); only BAE remains');
  assert.ok(isBotBlocked({ company_name: 'Citadel' }), 'isBotBlocked matches bare Citadel');
  assert.ok(BOT_BLOCKED_COMPANIES.has('tesla'), 'bot-block set contains tesla');
  console.log('✓ case 2: bot-blocked companies (Tesla/Citadel) excluded from Simplify pass');
}

// --- Case 3: non-consumer-visible Simplify jobs excluded (keeps the pool bounded + on-target) ---
{
  const jobs = [
    mkJob({ id: 'vis', source: 'simplify', company_name: 'BAE Systems', postedDaysAgo: 0, domains: ['software'], locations: ['us'] }),
    mkJob({ id: 'noloc', source: 'simplify', company_name: 'BAE Systems', postedDaysAgo: 0, locations: ['canada'] }),
    mkJob({ id: 'nodom', source: 'simplify', company_name: 'BAE Systems', postedDaysAgo: 0, domains: [] }),
    mkJob({ id: 'nourl', source: 'simplify', company_name: 'BAE Systems', postedDaysAgo: 0, url: '' }),
  ];
  const args = parseArgs([]);
  const { samples } = buildSamples(jobs, args);
  assert.deepStrictEqual(groupIds(samples, 'simplify-fresh'), ['vis'],
    'only US + tech-domain + has-url Simplify jobs are sampled');
  console.log('✓ case 3: non-consumer-visible Simplify jobs excluded');
}

// --- Case 4: dedup — a Simplify job already sampled in a regular group is not re-checked ---
{
  const jobs = [
    mkJob({ id: 'inwin', source: 'simplify', company_name: 'Foo', postedDaysAgo: 3 }), // in 2–4d window → 'custom'
    mkJob({ id: 'fresh', source: 'simplify', company_name: 'Foo', postedDaysAgo: 0 }),  // bypass only
  ];
  const args = parseArgs([]);
  const { samples } = buildSamples(jobs, args);
  assert.ok(groupIds(samples, 'custom').includes('inwin'), 'in-window Simplify job sampled via custom group');
  assert.ok(!groupIds(samples, 'simplify-fresh').includes('inwin'), 'in-window Simplify job deduped from simplify-fresh (no double HEAD)');
  assert.ok(groupIds(samples, 'simplify-fresh').includes('fresh'), 'fresh Simplify job sampled via bypass');
  console.log('✓ case 4: dedup prevents double-checking in-window Simplify jobs');
}

// --- Case 5: --no-simplify-bypass disables the pass entirely (reversibility) ---
{
  const jobs = [mkJob({ id: 'bae', source: 'simplify', company_name: 'BAE Systems', postedDaysAgo: 0 })];
  const args = parseArgs(['--no-simplify-bypass']);
  assert.strictEqual(args.simplifyBypass, false, '--no-simplify-bypass sets simplifyBypass false');
  const { samples, simplifyCandidates } = buildSamples(jobs, args);
  assert.strictEqual(groupIds(samples, 'simplify-fresh').length, 0, 'no simplify-fresh samples when bypass off');
  assert.strictEqual(simplifyCandidates, 0, 'no simplify candidates when bypass off');
  console.log('✓ case 5: --no-simplify-bypass fully disables the pass (reversible)');
}

// --- Case 6: --per-simplify bounds the sample (pool ~hundreds, sample stays small) ---
{
  const jobs = [];
  for (let i = 0; i < 40; i++) jobs.push(mkJob({ id: `s${i}`, source: 'simplify', company_name: 'BAE Systems', postedDaysAgo: 0 }));
  const args = parseArgs(['--per-simplify', '8']);
  assert.strictEqual(args.perSimplify, 8, '--per-simplify parsed');
  const { samples, simplifyCandidates } = buildSamples(jobs, args);
  assert.strictEqual(simplifyCandidates, 40, 'all 40 visible simplify jobs are candidates');
  assert.strictEqual(groupIds(samples, 'simplify-fresh').length, 8, 'sample bounded to per-simplify even when pool is larger');
  console.log('✓ case 6: --per-simplify bounds the Simplify sample');
}

console.log('\nAll AGG-DEADNESS-1 check-link-health tests passed.');
