#!/usr/bin/env node
'use strict';

const fs = require('fs');

function parseArgs(argv) {
  const args = {
    historyIn: 'stale-job-history.json',
    output: 'stale-job-tombstones.json',
    minHitCount: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--history-in') args.historyIn = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
    else if (arg === '--min-hit-count') args.minHitCount = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node .github/scripts/build-stale-tombstones.js [--history-in stale-job-history.json] [--output stale-job-tombstones.json] [--min-hit-count 1]');
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.minHitCount) || args.minHitCount < 1) {
    throw new Error('--min-hit-count must be a positive number');
  }
  return args;
}

function loadJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function asHistoryMap(input) {
  if (!input || typeof input !== 'object') return {};
  if (input.history && typeof input.history === 'object' && !Array.isArray(input.history)) return input.history;
  if (Array.isArray(input.tombstones)) return Object.fromEntries(input.tombstones.map(row => [row.id, row]));
  return {};
}

function evidenceFor(row) {
  if (row.latest_code === 404 || row.latest_code === 410) return `http_${row.latest_code}`;
  if (row.latest_status) return String(row.latest_status);
  return 'link_health_dead';
}

function buildTombstones(historyInput, options = {}) {
  const minHitCount = options.minHitCount || 1;
  const history = asHistoryMap(historyInput);
  const tombstones = Object.values(history)
    .filter(row => row && row.id && (row.hit_count || 0) >= minHitCount)
    .map(row => ({
      id: row.id,
      lifecycle_state: 'stale_candidate',
      source: row.source || null,
      group: row.group || null,
      company_name: row.company_name || null,
      title: row.title || null,
      url: row.url || null,
      first_dead_seen_at: row.first_seen || null,
      last_dead_seen_at: row.last_seen || null,
      hit_count: row.hit_count || 0,
      latest_status: row.latest_status || null,
      latest_code: row.latest_code ?? null,
      evidence: evidenceFor(row),
    }))
    .sort((a, b) => {
      const timeDiff = String(b.last_dead_seen_at || '').localeCompare(String(a.last_dead_seen_at || ''));
      return timeDiff || a.id.localeCompare(b.id);
    });

  const bySource = {};
  const byGroup = {};
  const byCode = {};
  for (const row of tombstones) {
    const source = row.source || 'unknown';
    const group = row.group || 'unknown';
    const code = row.latest_code == null ? 'none' : String(row.latest_code);
    bySource[source] = (bySource[source] || 0) + 1;
    byGroup[group] = (byGroup[group] || 0) + 1;
    byCode[code] = (byCode[code] || 0) + 1;
  }

  return {
    generated_at: new Date().toISOString(),
    source_artifact: 'stale-job-history.json',
    artifact_type: 'stale_tombstone_candidates',
    policy: {
      lifecycle_state: 'stale_candidate',
      automatic_removal: false,
      removal_authority: 'none',
      note: 'Evidence feed only. Do not suppress all_jobs.json rows from this artifact without a separately approved recurrence policy and destination proof.',
    },
    summary: {
      total: tombstones.length,
      min_hit_count: minHitCount,
      by_source: bySource,
      by_group: byGroup,
      by_latest_code: byCode,
    },
    tombstones,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tombstones = buildTombstones(loadJson(args.historyIn), { minHitCount: args.minHitCount });
  const text = JSON.stringify(tombstones, null, 2) + '\n';
  fs.writeFileSync(args.output, text);
  console.log(text);
}

if (require.main === module) main();

module.exports = { buildTombstones, parseArgs };
