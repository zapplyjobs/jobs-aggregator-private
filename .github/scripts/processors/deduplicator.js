#!/usr/bin/env node

/**
 * Job Deduplicator
 *
 * Removes duplicate jobs using multiple strategies:
 * 1. ID-based deduplication (exact matches)
 * 2. Fingerprint-based deduplication (same job, different ID)
 *
 * Maintains a dedupe store for tracking seen jobs across runs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEDUPE_STORE_FILE = path.join(process.cwd(), '.github', 'data', 'dedupe-store.json');

/**
 * Load dedupe store
 * @returns {Object} - { ids: Set, fingerprints: Set }
 */
function loadDedupeStore() {
  try {
    if (!fs.existsSync(DEDUPE_STORE_FILE)) {
      return { ids: new Set(), fingerprints: new Set() };
    }

    const data = JSON.parse(fs.readFileSync(DEDUPE_STORE_FILE, 'utf8'));

    return {
      ids: new Set(data.ids || []),
      fingerprints: new Set(data.fingerprints || [])
    };

  } catch (error) {
    console.error('⚠️ Error loading dedupe store:', error.message);
    return { ids: new Set(), fingerprints: new Set() };
  }
}

/**
 * Save dedupe store
 * @param {Object} store - { ids: Set, fingerprints: Set }
 */
function saveDedupeStore(store) {
  try {
    const dir = path.dirname(DEDUPE_STORE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${DEDUPE_STORE_FILE}.tmp`;

    // Convert Sets to Arrays for JSON serialization
    const data = {
      ids: Array.from(store.ids),
      fingerprints: Array.from(store.fingerprints),
      last_updated: new Date().toISOString()
    };

    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, DEDUPE_STORE_FILE);

  } catch (error) {
    console.error('⚠️ Error saving dedupe store:', error.message);
  }
}

/**
 * Clean up old entries from dedupe store (older than 90 days)
 * @param {Object} store - Dedupe store
 * @returns {Object} - Cleanup stats
 */
function cleanupOldEntries(store) {
  // Note: Current implementation doesn't track timestamps per entry
  // This is a placeholder for future enhancement
  return { removed: 0 };
}

/**
 * Deduplicate jobs
 * @param {Array} jobs - Array of normalized job objects
 * @returns {Object} - { unique: Array, duplicates: number, stats: Object }
 */
function deduplicateJobs(jobs) {
  console.log(`🔍 Deduplicating ${jobs.length} jobs...`);

  // Load existing dedupe store
  const store = loadDedupeStore();

  const unique = [];
  const duplicateIds = [];
  const duplicateFingerprints = [];

  for (const job of jobs) {
    // Check if already seen by ID
    if (store.ids.has(job.id)) {
      duplicateIds.push(job.id);
      continue;
    }

    // Check if already seen by fingerprint
    if (store.fingerprints.has(job.fingerprint)) {
      duplicateFingerprints.push(job.fingerprint);
      continue;
    }

    // Unique job - add to result and mark as seen
    unique.push(job);
    store.ids.add(job.id);
    store.fingerprints.add(job.fingerprint);
  }

  // Save updated store
  saveDedupeStore(store);

  // Calculate stats
  const totalDuplicates = duplicateIds.length + duplicateFingerprints.length;
  const stats = {
    input: jobs.length,
    unique: unique.length,
    duplicates_by_id: duplicateIds.length,
    duplicates_by_fingerprint: duplicateFingerprints.length,
    total_duplicates: totalDuplicates,
    dedupe_rate: jobs.length > 0 ? ((totalDuplicates / jobs.length) * 100).toFixed(1) + '%' : '0%'
  };

  console.log(`✅ Deduplication complete:`);
  console.log(`   Input: ${stats.input} jobs`);
  console.log(`   Unique: ${stats.unique} jobs`);
  console.log(`   Duplicates (ID): ${stats.duplicates_by_id}`);
  console.log(`   Duplicates (fingerprint): ${stats.duplicates_by_fingerprint}`);
  console.log(`   Total removed: ${stats.total_duplicates} (${stats.dedupe_rate})`);

  return { unique, duplicates: totalDuplicates, stats };
}

/**
 * Generate fingerprint for a job
 * @param {Object} job - Job object
 * @returns {string} - SHA-256 hash
 */
function generateFingerprint(job) {
  const title = (job.title || '').toLowerCase().trim();
  const company = (job.company || '').toLowerCase().trim();
  const location = (job.location || '').toLowerCase().trim();

  const normalized = `${title}|${company}|${location}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Reset dedupe store (use with caution!)
 * @returns {boolean} - Success status
 */
function resetDedupeStore() {
  try {
    if (fs.existsSync(DEDUPE_STORE_FILE)) {
      // Create backup
      const backupPath = `${DEDUPE_STORE_FILE}.backup-${Date.now()}`;
      fs.copyFileSync(DEDUPE_STORE_FILE, backupPath);
      console.log(`📁 Backup created: ${backupPath}`);
    }

    // Reset to empty state
    saveDedupeStore({ ids: new Set(), fingerprints: new Set() });
    console.log('✅ Dedupe store reset');
    return true;

  } catch (error) {
    console.error('❌ Error resetting dedupe store:', error.message);
    return false;
  }
}

/**
 * Get dedupe store statistics
 * @returns {Object} - Store stats
 */
function getDedupeStats() {
  const store = loadDedupeStore();

  return {
    total_ids: store.ids.size,
    total_fingerprints: store.fingerprints.size,
    store_file: DEDUPE_STORE_FILE,
    last_updated: fs.existsSync(DEDUPE_STORE_FILE)
      ? fs.statSync(DEDUPE_STORE_FILE).mtime.toISOString()
      : null
  };
}

module.exports = {
  deduplicateJobs,
  generateFingerprint,
  resetDedupeStore,
  getDedupeStats,
  loadDedupeStore,
  saveDedupeStore
};
