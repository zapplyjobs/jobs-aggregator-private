#!/usr/bin/env node
'use strict';

const fs = require('fs');

function parseArgs(argv) {
  const args = {
    input: 'agg-link-health.json',
    output: 'link-verification-sample.json',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input') args.input = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node .github/scripts/build-link-verification-sample.js [--input agg-link-health.json] [--output link-verification-sample.json]');
      process.exit(0);
    }
  }
  return args;
}

function loadJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function statusBucket(status) {
  if (status === 'ok') return 'verified_live';
  if (status === 'dead') return 'stale_candidate';
  return 'uncertain';
}

function buildVerificationSample(input) {
  const checkedAt = input.checked_at || new Date().toISOString();
  const results = Array.isArray(input.results) ? input.results : [];
  const samples = results.map(row => ({
    id: row.id,
    lifecycle_state: statusBucket(row.status),
    source: row.source || null,
    group: row.group || null,
    company_name: row.company_name || null,
    title: row.title || null,
    posted_at: row.posted_at || null,
    url: row.url || null,
    final_url: row.final_url || null,
    last_checked_at: checkedAt,
    last_verified_live_at: row.status === 'ok' ? checkedAt : null,
    status: row.status || null,
    code: row.code ?? null,
    error: row.error || null,
  }));

  const summary = {
    total_checked: samples.length,
    verified_live: 0,
    stale_candidate: 0,
    uncertain: 0,
    by_group: {},
    by_status: {},
  };

  for (const row of samples) {
    if (row.lifecycle_state === 'verified_live') summary.verified_live += 1;
    else if (row.lifecycle_state === 'stale_candidate') summary.stale_candidate += 1;
    else summary.uncertain += 1;
    const group = row.group || 'unknown';
    summary.by_group[group] = (summary.by_group[group] || 0) + 1;
    const status = row.status || 'unknown';
    summary.by_status[status] = (summary.by_status[status] || 0) + 1;
  }

  return {
    generated_at: new Date().toISOString(),
    source_artifact: 'agg-link-health.json',
    artifact_type: 'link_verification_sample',
    policy: {
      coverage: 'sample_only',
      full_pool_proof: false,
      note: 'This artifact records live/dead/uncertain evidence for the sampled URLs checked by Check Link Health. Do not present sampled verification as full-pool freshness proof.',
    },
    sample_window: input.sample_window || null,
    per_group: input.per_group ?? null,
    summary,
    samples,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sample = buildVerificationSample(loadJson(args.input));
  const text = JSON.stringify(sample, null, 2) + '\n';
  fs.writeFileSync(args.output, text);
  console.log(text);
}

if (require.main === module) main();

module.exports = { buildVerificationSample, parseArgs };
