#!/usr/bin/env node
'use strict';

const fs = require('fs');

function parseArgs(argv) {
  const args = {
    linkHealth: 'agg-link-health.json',
    verification: 'link-verification-sample.json',
    tombstones: 'stale-job-tombstones.json',
    metadata: 'jobs-metadata.json',
    output: 'source-confidence-sample.json',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--link-health') args.linkHealth = argv[++i];
    else if (arg === '--verification') args.verification = argv[++i];
    else if (arg === '--tombstones') args.tombstones = argv[++i];
    else if (arg === '--metadata') args.metadata = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node .github/scripts/build-source-confidence-sample.js [--link-health agg-link-health.json] [--verification link-verification-sample.json] [--tombstones stale-job-tombstones.json] [--metadata jobs-metadata.json] [--output source-confidence-sample.json]');
      process.exit(0);
    }
  }
  return args;
}

function loadJson(path, fallback = null) {
  if (!path || !fs.existsSync(path)) return fallback;
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function emptySourceRow(source) {
  return {
    source,
    final_pool_count: null,
    sample_checked: 0,
    sample_verified_live: 0,
    sample_uncertain: 0,
    sample_stale_candidate: 0,
    sample_last_checked_at: null,
    sample_last_verified_live_at: null,
    latest_tombstone_seen_at: null,
    tombstone_count: 0,
    confidence: 'no_sample',
    notes: [],
  };
}

function bumpSource(row, sample) {
  row.sample_checked += 1;
  row.sample_last_checked_at = maxIso(row.sample_last_checked_at, sample.last_checked_at);
  if (sample.lifecycle_state === 'verified_live') {
    row.sample_verified_live += 1;
    row.sample_last_verified_live_at = maxIso(row.sample_last_verified_live_at, sample.last_verified_live_at);
  } else if (sample.lifecycle_state === 'stale_candidate') {
    row.sample_stale_candidate += 1;
  } else {
    row.sample_uncertain += 1;
  }
}

function maxIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return String(a) >= String(b) ? a : b;
}

function confidenceFor(row) {
  if (row.sample_stale_candidate > 0) return 'watch_stale_candidate';
  if (row.sample_uncertain > 0) return row.sample_verified_live > 0 ? 'mixed_sample' : 'uncertain_sample';
  if (row.sample_verified_live > 0) return 'sample_verified_live';
  return 'no_sample';
}

function buildSourceConfidence({ linkHealth, verification, tombstones, metadata }) {
  const sourceRows = new Map();
  const metadataBySource = metadata && metadata.by_source && typeof metadata.by_source === 'object' ? metadata.by_source : {};
  for (const [source, count] of Object.entries(metadataBySource)) {
    const row = emptySourceRow(source);
    row.final_pool_count = count;
    sourceRows.set(source, row);
  }

  for (const sample of verification.samples || []) {
    const source = sample.source || 'unknown';
    if (!sourceRows.has(source)) sourceRows.set(source, emptySourceRow(source));
    bumpSource(sourceRows.get(source), sample);
  }

  for (const tombstone of tombstones.tombstones || []) {
    const source = tombstone.source || 'unknown';
    if (!sourceRows.has(source)) sourceRows.set(source, emptySourceRow(source));
    const row = sourceRows.get(source);
    row.tombstone_count += 1;
    row.latest_tombstone_seen_at = maxIso(row.latest_tombstone_seen_at, tombstone.last_dead_seen_at);
  }

  for (const row of sourceRows.values()) {
    row.confidence = confidenceFor(row);
    if (row.final_pool_count === 0) row.notes.push('metadata_final_pool_zero');
    if (row.sample_checked === 0) row.notes.push('not_in_link_health_sample');
    if (row.sample_uncertain > 0) row.notes.push('sample_contains_uncertain_urls');
    if (row.tombstone_count > 0) row.notes.push('has_stale_candidate_history');
  }

  const groups = [];
  for (const [group, summary] of Object.entries(linkHealth.summary || {})) {
    groups.push({
      group,
      candidate_window_count: summary.candidates ?? null,
      checked: summary.checked ?? null,
      dead: summary.dead ?? null,
      uncertain: summary.uncertain ?? null,
      role_yield_delta_basis: 'candidate_window_count is sampled 2-4 day tech-US visible URL candidates from Check Link Health, not full-pool source yield delta.',
    });
  }

  const sources = [...sourceRows.values()].sort((a, b) => {
    const confidenceDiff = a.confidence.localeCompare(b.confidence);
    return confidenceDiff || a.source.localeCompare(b.source);
  });

  return {
    generated_at: new Date().toISOString(),
    artifact_type: 'source_confidence_sample',
    source_artifacts: ['agg-link-health.json', 'link-verification-sample.json', 'stale-job-tombstones.json', 'jobs-metadata.json'],
    policy: {
      coverage: 'sample_and_metadata',
      dashboard_ready: true,
      full_source_health_proof: false,
      note: 'This packet is safe for operator/DASH review as sampled source confidence. It must not be treated as complete fetcher health or full-pool source-yield proof.',
    },
    metadata_generated_at: metadata?.generated || metadata?.generated_at || null,
    checked_at: linkHealth.checked_at || verification.generated_at || null,
    group_candidate_window: groups,
    summary: {
      sources: sources.length,
      sample_checked: sources.reduce((sum, row) => sum + row.sample_checked, 0),
      sample_verified_live: sources.reduce((sum, row) => sum + row.sample_verified_live, 0),
      sample_uncertain: sources.reduce((sum, row) => sum + row.sample_uncertain, 0),
      sample_stale_candidate: sources.reduce((sum, row) => sum + row.sample_stale_candidate, 0),
      tombstone_sources: sources.filter(row => row.tombstone_count > 0).length,
    },
    sources,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const output = buildSourceConfidence({
    linkHealth: loadJson(args.linkHealth, { summary: {} }),
    verification: loadJson(args.verification, { samples: [] }),
    tombstones: loadJson(args.tombstones, { tombstones: [] }),
    metadata: loadJson(args.metadata, {}),
  });
  const text = JSON.stringify(output, null, 2) + '\n';
  fs.writeFileSync(args.output, text);
  console.log(text);
}

if (require.main === module) main();

module.exports = { buildSourceConfidence, parseArgs };
