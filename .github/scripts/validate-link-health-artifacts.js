#!/usr/bin/env node
'use strict';

const fs = require('fs');

const DEFAULT_FILES = {
  linkHealth: 'agg-link-health.json',
  candidates: 'stale-job-candidates.json',
  history: 'stale-job-history.json',
  tombstones: 'stale-job-tombstones.json',
  verification: 'link-verification-sample.json',
  confidence: 'source-confidence-sample.json',
};

function parseArgs(argv) {
  const args = { ...DEFAULT_FILES, printSummary: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--link-health') args.linkHealth = argv[++i];
    else if (arg === '--candidates') args.candidates = argv[++i];
    else if (arg === '--history') args.history = argv[++i];
    else if (arg === '--tombstones') args.tombstones = argv[++i];
    else if (arg === '--verification') args.verification = argv[++i];
    else if (arg === '--confidence') args.confidence = argv[++i];
    else if (arg === '--print-summary') args.printSummary = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node .github/scripts/validate-link-health-artifacts.js [--print-summary]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function loadJson(path) {
  if (!fs.existsSync(path)) throw new Error(`missing artifact: ${path}`);
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIsoOrNull(value, path) {
  if (value == null) return;
  assert(typeof value === 'string' && !Number.isNaN(Date.parse(value)), `${path} must be ISO timestamp or null`);
}

function assertObject(value, path) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${path} must be object`);
}

function assertArray(value, path) {
  assert(Array.isArray(value), `${path} must be array`);
}

function validateLinkHealth(obj) {
  assertIsoOrNull(obj.checked_at, 'agg-link-health.checked_at');
  assertObject(obj.sample_window, 'agg-link-health.sample_window');
  assert(Number.isFinite(obj.sample_window.minAgeDays), 'agg-link-health.sample_window.minAgeDays must be number');
  assert(Number.isFinite(obj.sample_window.maxAgeDays), 'agg-link-health.sample_window.maxAgeDays must be number');
  assert(Number.isFinite(obj.per_group), 'agg-link-health.per_group must be number');
  assertObject(obj.summary, 'agg-link-health.summary');
  assertArray(obj.results, 'agg-link-health.results');
  for (const [group, summary] of Object.entries(obj.summary)) {
    assertObject(summary, `agg-link-health.summary.${group}`);
    for (const field of ['candidates', 'checked', 'dead', 'uncertain']) {
      assert(Number.isFinite(summary[field]), `agg-link-health.summary.${group}.${field} must be number`);
    }
  }
}

function validateCandidates(obj) {
  assertIsoOrNull(obj.checked_at, 'stale-job-candidates.checked_at');
  assertArray(obj.dead, 'stale-job-candidates.dead');
}

function validateHistory(obj) {
  assertIsoOrNull(obj.checked_at, 'stale-job-history.checked_at');
  assertObject(obj.history, 'stale-job-history.history');
}

function validateTombstones(obj) {
  assert(obj.artifact_type === 'stale_tombstone_candidates', 'stale-job-tombstones.artifact_type mismatch');
  assertIsoOrNull(obj.generated_at, 'stale-job-tombstones.generated_at');
  assert(obj.source_artifact === 'stale-job-history.json', 'stale-job-tombstones.source_artifact mismatch');
  assertObject(obj.policy, 'stale-job-tombstones.policy');
  assert(obj.policy.lifecycle_state === 'stale_candidate', 'stale-job-tombstones.policy.lifecycle_state must be stale_candidate');
  assert(obj.policy.automatic_removal === false, 'stale-job-tombstones.policy.automatic_removal must be false');
  assert(obj.policy.removal_authority === 'none', 'stale-job-tombstones.policy.removal_authority must be none');
  assertObject(obj.summary, 'stale-job-tombstones.summary');
  assert(Number.isFinite(obj.summary.total), 'stale-job-tombstones.summary.total must be number');
  assertArray(obj.tombstones, 'stale-job-tombstones.tombstones');
  for (const row of obj.tombstones) {
    assert(row.lifecycle_state === 'stale_candidate', 'tombstone row lifecycle_state must be stale_candidate');
    assertIsoOrNull(row.first_dead_seen_at, 'tombstone.first_dead_seen_at');
    assertIsoOrNull(row.last_dead_seen_at, 'tombstone.last_dead_seen_at');
    assert(Number.isFinite(row.hit_count), 'tombstone.hit_count must be number');
  }
}

function validateVerification(obj) {
  assert(obj.artifact_type === 'link_verification_sample', 'link-verification-sample.artifact_type mismatch');
  assertIsoOrNull(obj.generated_at, 'link-verification-sample.generated_at');
  assertObject(obj.policy, 'link-verification-sample.policy');
  assert(obj.policy.coverage === 'sample_only', 'link-verification-sample.policy.coverage must be sample_only');
  assert(obj.policy.full_pool_proof === false, 'link-verification-sample.policy.full_pool_proof must be false');
  assertObject(obj.summary, 'link-verification-sample.summary');
  for (const field of ['total_checked', 'verified_live', 'stale_candidate', 'uncertain']) {
    assert(Number.isFinite(obj.summary[field]), `link-verification-sample.summary.${field} must be number`);
  }
  assertArray(obj.samples, 'link-verification-sample.samples');
  for (const sample of obj.samples) {
    assert(['verified_live', 'stale_candidate', 'uncertain'].includes(sample.lifecycle_state), 'sample lifecycle_state invalid');
    assertIsoOrNull(sample.last_checked_at, 'sample.last_checked_at');
    assertIsoOrNull(sample.last_verified_live_at, 'sample.last_verified_live_at');
    if (sample.lifecycle_state === 'verified_live') {
      assert(sample.last_verified_live_at, 'verified_live sample must have last_verified_live_at');
    }
  }
}

function validateConfidence(obj) {
  assert(obj.artifact_type === 'source_confidence_sample', 'source-confidence-sample.artifact_type mismatch');
  assertIsoOrNull(obj.generated_at, 'source-confidence-sample.generated_at');
  assertObject(obj.policy, 'source-confidence-sample.policy');
  assert(obj.policy.coverage === 'sample_and_metadata', 'source-confidence-sample.policy.coverage must be sample_and_metadata');
  assert(obj.policy.dashboard_ready === true, 'source-confidence-sample.policy.dashboard_ready must be true');
  assert(obj.policy.full_source_health_proof === false, 'source-confidence-sample.policy.full_source_health_proof must be false');
  assertArray(obj.group_candidate_window, 'source-confidence-sample.group_candidate_window');
  assertObject(obj.summary, 'source-confidence-sample.summary');
  for (const field of ['sources', 'sample_checked', 'sample_verified_live', 'sample_uncertain', 'sample_stale_candidate', 'tombstone_sources']) {
    assert(Number.isFinite(obj.summary[field]), `source-confidence-sample.summary.${field} must be number`);
  }
  assertArray(obj.sources, 'source-confidence-sample.sources');
  for (const row of obj.sources) {
    assert(typeof row.source === 'string' && row.source, 'source row must have source');
    assert(['no_sample', 'sample_verified_live', 'mixed_sample', 'uncertain_sample', 'watch_stale_candidate'].includes(row.confidence), `invalid confidence for ${row.source}`);
    assertIsoOrNull(row.sample_last_checked_at, `${row.source}.sample_last_checked_at`);
    assertIsoOrNull(row.sample_last_verified_live_at, `${row.source}.sample_last_verified_live_at`);
    assertIsoOrNull(row.latest_tombstone_seen_at, `${row.source}.latest_tombstone_seen_at`);
  }
}

function validateArtifacts(paths) {
  const artifacts = {
    linkHealth: loadJson(paths.linkHealth),
    candidates: loadJson(paths.candidates),
    history: loadJson(paths.history),
    tombstones: loadJson(paths.tombstones),
    verification: loadJson(paths.verification),
    confidence: loadJson(paths.confidence),
  };

  validateLinkHealth(artifacts.linkHealth);
  validateCandidates(artifacts.candidates);
  validateHistory(artifacts.history);
  validateTombstones(artifacts.tombstones);
  validateVerification(artifacts.verification);
  validateConfidence(artifacts.confidence);

  assert(artifacts.verification.summary.total_checked === artifacts.linkHealth.results.length, 'verification total_checked must equal link-health results length');
  assert(artifacts.confidence.summary.sample_checked === artifacts.verification.summary.total_checked, 'confidence sample_checked must equal verification total_checked');
  assert(artifacts.tombstones.summary.total === artifacts.tombstones.tombstones.length, 'tombstone summary total must equal row count');

  return artifacts;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifacts = validateArtifacts(args);
  if (args.printSummary) {
    console.log(JSON.stringify({
      ok: true,
      checked_at: artifacts.linkHealth.checked_at,
      link_health_results: artifacts.linkHealth.results.length,
      tombstones: artifacts.tombstones.summary.total,
      verification: artifacts.verification.summary,
      confidence: artifacts.confidence.summary,
    }, null, 2));
  } else {
    console.log('PASS link-health artifact contract');
  }
}

if (require.main === module) main();

module.exports = { validateArtifacts, parseArgs };
