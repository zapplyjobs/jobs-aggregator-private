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
const DEDUPE_TTL_DAYS = 14; // Remove entries after 14 days (matches ACTIVE_WINDOW_DAYS)
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
 *
 * Two separate concerns:
 *   1. OUTPUT: all jobs within the 14-day active window (full catalog for consumer repos)
 *   2. STORE: tracks every seen job+fingerprint for Discord re-post prevention
 *
 * A job is "within window" if its store entry was last seen within DEDUPE_TTL_MS.
 * Net-new jobs (not yet in store) are also included and added to the store.
 *
 * @param {Array} jobs - Array of normalized job objects
 * @returns {Object} - { unique: Array, duplicates: number, stats: Object }
 */
function deduplicateJobs(jobs) {
  console.log(`🔍 Processing ${jobs.length} jobs for 14-day active window...`);

  // Load existing dedupe store
  const store = loadDedupeStore();

  // Clean up old entries first (TTL-based) — removes entries > 14 days old
  const cleanupStats = cleanupOldEntries(store);

  const activeWindow = []; // All jobs within 14-day window (output)
  const newJobs = [];      // Jobs not previously seen (for logging)
  const now = Date.now();

  for (const job of jobs) {
    const seenById = store.ids.has(job.id);
    const seenByFp = store.fingerprints.has(job.fingerprint);

    if (seenById || seenByFp) {
      // Job already in store — update timestamp (still active) and include in output
      if (seenById) store.ids.set(job.id, now);
      if (seenByFp) store.fingerprints.set(job.fingerprint, now);
      activeWindow.push(job);
    } else {
      // Net-new job — add to store and include in output
      store.ids.set(job.id, now);
      store.fingerprints.set(job.fingerprint, now);
      activeWindow.push(job);
      newJobs.push(job);
    }
  }

  // Save updated store
  saveDedupeStore(store);

  // Calculate stats
  const previouslySeen = activeWindow.length - newJobs.length;
  const stats = {
    input: jobs.length,
    active_window: activeWindow.length,
    net_new: newJobs.length,
    previously_seen: previouslySeen,
    store_size: store.ids.size,
    cleanup_removed: cleanupStats.removed_ids + cleanupStats.removed_fingerprints
  };

  console.log(`✅ Active window built:`);
  console.log(`   Input: ${stats.input} jobs`);
  console.log(`   Output (14-day window): ${stats.active_window} jobs`);
  console.log(`   Net-new this run: ${stats.net_new} jobs`);
  console.log(`   Previously seen (refreshed): ${stats.previously_seen} jobs`);
  console.log(`   Store size: ${stats.store_size} entries`);
  if (stats.cleanup_removed > 0) {
    console.log(`   Expired entries cleaned: ${stats.cleanup_removed}`);
  }

  // Return active window as "unique" for backwards compatibility with callers
  return { unique: activeWindow, duplicates: previouslySeen, stats };
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
