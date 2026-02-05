#!/usr/bin/env node

/**
 * Job Deduplicator
 *
 * Removes duplicate jobs using multiple strategies:
 * 1. ID-based deduplication (exact matches)
 * 2. Fingerprint-based deduplication (same job, different ID)
 *
 * Maintains a dedupe store for tracking seen jobs across runs.
 * UPDATED 2026-02-05: Added TTL-based cleanup to prevent job starvation
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEDUPE_STORE_FILE = path.join(process.cwd(), '.github', 'data', 'dedupe-store.json');
const DEDUPE_TTL_DAYS = 7; // Remove entries after 7 days
const DEDUPE_TTL_MS = DEDUPE_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Load dedupe store
 * @returns {Object} - { ids: Map, fingerprints: Map }
 * Note: Changed from Set to Map to track timestamps
 */
function loadDedupeStore() {
  try {
    if (!fs.existsSync(DEDUPE_STORE_FILE)) {
      return { ids: new Map(), fingerprints: new Map() };
    }

    const data = JSON.parse(fs.readFileSync(DEDUPE_STORE_FILE, 'utf8'));

    // Convert old Set format to new Map format with timestamps
    const ids = new Map();
    const fingerprints = new Map();

    if (data.ids) {
      if (Array.isArray(data.ids)) {
        // Old format: Array of IDs (no timestamps) - set current time
        const now = Date.now();
        for (const id of data.ids) {
          ids.set(id, now);
        }
      } else if (typeof data.ids === 'object') {
        // New format: Map-like object
        for (const [id, ts] of Object.entries(data.ids)) {
          ids.set(id, ts);
        }
      }
    }

    if (data.fingerprints) {
      if (Array.isArray(data.fingerprints)) {
        // Old format: Array of fingerprints (no timestamps) - set current time
        const now = Date.now();
        for (const fp of data.fingerprints) {
          fingerprints.set(fp, now);
        }
      } else if (typeof data.fingerprints === 'object') {
        // New format: Map-like object
        for (const [fp, ts] of Object.entries(data.fingerprints)) {
          fingerprints.set(fp, ts);
        }
      }
    }

    return { ids, fingerprints };

  } catch (error) {
    console.error('⚠️ Error loading dedupe store:', error.message);
    return { ids: new Map(), fingerprints: new Map() };
  }
}

/**
 * Save dedupe store
 * @param {Object} store - { ids: Map, fingerprints: Map }
 */
function saveDedupeStore(store) {
  try {
    const dir = path.dirname(DEDUPE_STORE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${DEDUPE_STORE_FILE}.tmp`;

    // Convert Maps to Objects for JSON serialization (preserves timestamps)
    const data = {
      ids: Object.fromEntries(store.ids),
      fingerprints: Object.fromEntries(store.fingerprints),
      last_updated: new Date().toISOString()
    };

    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, DEDUPE_STORE_FILE);

  } catch (error) {
    console.error('⚠️ Error saving dedupe store:', error.message);
  }
}

/**
 * Clean up old entries from dedupe store (older than TTL)
 * @param {Object} store - Dedupe store { ids: Map, fingerprints: Map }
 * @returns {Object} - Cleanup stats
 */
function cleanupOldEntries(store) {
  const now = Date.now();
  const cutoff = now - DEDUPE_TTL_MS;

  let removedIds = 0;
  let removedFingerprints = 0;

  // Clean old IDs
  for (const [id, timestamp] of store.ids.entries()) {
    if (timestamp < cutoff) {
      store.ids.delete(id);
      removedIds++;
    }
  }

  // Clean old fingerprints
  for (const [fp, timestamp] of store.fingerprints.entries()) {
    if (timestamp < cutoff) {
      store.fingerprints.delete(fp);
      removedFingerprints++;
    }
  }

  if (removedIds > 0 || removedFingerprints > 0) {
    console.log(`🧹 Cleaned ${removedIds} old IDs, ${removedFingerprints} old fingerprints (> ${DEDUPE_TTL_DAYS} days)`);
  }

  return { removed_ids: removedIds, removed_fingerprints: removedFingerprints };
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

  // Clean up old entries first (TTL-based)
  const cleanupStats = cleanupOldEntries(store);

  const unique = [];
  const duplicateIds = [];
  const duplicateFingerprints = [];
  const now = Date.now();

  for (const job of jobs) {
    // Check if already seen by ID
    if (store.ids.has(job.id)) {
      duplicateIds.push(job.id);
      // Update timestamp (job is still being posted)
      store.ids.set(job.id, now);
      continue;
    }

    // Check if already seen by fingerprint
    if (store.fingerprints.has(job.fingerprint)) {
      duplicateFingerprints.push(job.fingerprint);
      // Update timestamp (job is still being posted)
      store.fingerprints.set(job.fingerprint, now);
      continue;
    }

    // Unique job - add to result and mark as seen
    unique.push(job);
    store.ids.set(job.id, now);
    store.fingerprints.set(job.fingerprint, now);
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
    dedupe_rate: jobs.length > 0 ? ((totalDuplicates / jobs.length) * 100).toFixed(1) + '%' : '0%',
    cleanup_removed: cleanupStats.removed_ids + cleanupStats.removed_fingerprints
  };

  console.log(`✅ Deduplication complete:`);
  console.log(`   Input: ${stats.input} jobs`);
  console.log(`   Unique: ${stats.unique} jobs`);
  console.log(`   Duplicates (ID): ${stats.duplicates_by_id}`);
  console.log(`   Duplicates (fingerprint): ${stats.duplicates_by_fingerprint}`);
  console.log(`   Total removed: ${stats.total_duplicates} (${stats.dedupe_rate})`);
  if (stats.cleanup_removed > 0) {
    console.log(`   Old entries cleaned: ${stats.cleanup_removed}`);
  }

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
    saveDedupeStore({ ids: new Map(), fingerprints: new Map() });
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
