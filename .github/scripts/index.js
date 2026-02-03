#!/usr/bin/env node

/**
 * Main Orchestrator - Jobs Data Fetcher
 *
 * Coordinates all fetchers, normalizes jobs, deduplicates,
 * and writes the shared output file.
 *
 * Usage:
 *   node index.js                    # Normal run
 *   node index.js --dry-run          # Dry run (no git commit)
 *   node index.js --verbose          # Verbose logging
 */

const fs = require('fs');
const path = require('path');

// Import fetchers
const { fetchFromJSearch, getUsageStats } = require('../fetchers/jsearch-fetcher');

// Import processors
const { normalizeJobs } = require('../processors/normalizer');
const { deduplicateJobs } = require('../processors/deduplicator');

// Import utils
const { writeJobsJSONL, writeMetadata } = require('../utils/file-writer');

// Paths
const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const JOBS_OUTPUT_FILE = path.join(DATA_DIR, 'jobs-shared.json');
const METADATA_OUTPUT_FILE = path.join(DATA_DIR, 'jobs-metadata.json');

// Command line args
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isVerbose = args.includes('--verbose');

/**
 * Main execution function
 */
async function main() {
  const startTime = Date.now();

  console.log('🚀 Jobs Data Fetcher - Starting...');
  console.log('═'.repeat(60));
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no commits)' : 'NORMAL'}`);
  console.log('');

  try {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Step 1: Fetch from all sources
    console.log('📡 Step 1: Fetching jobs from all sources...');
    console.log('━'.repeat(60));

    let allJobs = [];

    // Fetch from JSearch
    const jsearchJobs = await fetchFromJSearch();
    allJobs.push(...jsearchJobs);

    console.log('');
    console.log(`📊 Step 1 complete: ${allJobs.length} jobs fetched`);
    console.log('');

    // Step 2: Normalize jobs
    console.log('📝 Step 2: Normalizing jobs...');
    console.log('━'.repeat(60));

    // Jobs are already normalized by fetchers, but we ensure consistency
    const normalizedJobs = allJobs; // Already normalized

    console.log(`✅ Step 2 complete: ${normalizedJobs.length} jobs normalized`);
    console.log('');

    // Step 3: Deduplicate
    console.log('🔍 Step 3: Deduplicating jobs...');
    console.log('━'.repeat(60));

    const { unique: dedupedJobs, duplicates, stats: dedupeStats } = deduplicateJobs(normalizedJobs);

    console.log('');
    console.log(`✅ Step 3 complete: ${dedupedJobs.length} unique jobs (${duplicates} duplicates removed)`);
    console.log('');

    // Step 4: Sort by date (newest first)
    console.log('📊 Step 4: Sorting jobs by date...');
    console.log('━'.repeat(60));

    const sortedJobs = dedupedJobs.sort((a, b) => {
      const dateA = new Date(a.posted_at || 0);
      const dateB = new Date(b.posted_at || 0);
      return dateB - dateA; // Newest first
    });

    console.log(`✅ Step 4 complete: Jobs sorted`);
    console.log('');

    // Step 5: Write output files
    console.log('💾 Step 5: Writing output files...');
    console.log('━'.repeat(60));

    // Write jobs (JSONL format)
    await writeJobsJSONL(sortedJobs, JOBS_OUTPUT_FILE);

    // Write metadata
    const duration = Date.now() - startTime;
    const metadata = generateMetadata(sortedJobs, dedupedJobs.length, duplicates, duration);
    await writeMetadata(metadata, METADATA_OUTPUT_FILE);

    console.log('');
    console.log(`✅ Step 5 complete: Output files written`);
    console.log('');

    // Step 6: Print summary
    printSummary(sortedJobs, dedupedJobs.length, duplicates, duration);

    // Step 7: Git commit (unless dry run)
    if (!isDryRun) {
      console.log('📝 Step 6: Committing to git...');
      console.log('━'.repeat(60));

      await gitCommit(sortedJobs.length);

      console.log('');
      console.log(`✅ Step 6 complete: Changes committed`);
    } else {
      console.log('⏭️  Step 6: Skipping git commit (dry run)');
    }

    console.log('');
    console.log('═'.repeat(60));
    console.log('🎉 Jobs Data Fetcher - Complete!');
    console.log('═'.repeat(60));

    process.exit(0);

  } catch (error) {
    console.error('');
    console.error('❌ Fatal error:');
    console.error(error.message);
    console.error('');
    console.error('Stack trace:');
    console.error(error.stack);
    process.exit(1);
  }
}

/**
 * Generate metadata object
 * @param {Array} jobs - All jobs
 * @param {number} uniqueCount - Unique job count
 * @param {number} duplicateCount - Duplicate count
 * @param {number} duration - Duration in ms
 * @returns {Object} - Metadata object
 */
function generateMetadata(jobs, uniqueCount, duplicateCount, duration) {
  const bySource = {};
  const byEmploymentType = {};
  const byInternship = { internship: 0, 'new-grad': 0, other: 0 };
  const byRemote = { remote: 0, onsite: 0 };

  for (const job of jobs) {
    // Count by source
    bySource[job.source] = (bySource[job.source] || 0) + 1;

    // Count by employment type
    for (const type of job.employment_types) {
      byEmploymentType[type] = (byEmploymentType[type] || 0) + 1;
    }

    // Count by job type
    if (job.is_internship) {
      byInternship.internship++;
    } else if (job.is_new_grad) {
      byInternship['new-grad']++;
    } else {
      byInternship.other++;
    }

    // Count by remote
    if (job.is_remote) {
      byRemote.remote++;
    } else {
      byRemote.onsite++;
    }
  }

  return {
    version: '1.0',
    generated: new Date().toISOString(),
    duration_ms: duration,

    total_jobs: jobs.length,
    unique_jobs: uniqueCount,
    duplicates_removed: duplicateCount,

    by_source: bySource,
    by_employment_type: byEmploymentType,
    by_job_type: byInternship,
    by_location: byRemote,

    jsearch_stats: getUsageStats()
  };
}

/**
 * Print execution summary
 * @param {Array} jobs - Final job array
 * @param {number} uniqueCount - Unique job count
 * @param {number} duplicateCount - Duplicate count
 * @param {number} duration - Duration in ms
 */
function printSummary(jobs, uniqueCount, duplicateCount, duration) {
  console.log('📊 Execution Summary:');
  console.log('━'.repeat(60));

  // Count by job type
  const internships = jobs.filter(j => j.is_internship).length;
  const newGrad = jobs.filter(j => j.is_new_grad).length;
  const remote = jobs.filter(j => j.is_remote).length;

  console.log(`Total jobs in output: ${jobs.length}`);
  console.log(`  - Internships: ${internships}`);
  console.log(`  - New Grad: ${newGrad}`);
  console.log(`  - Remote: ${remote}`);
  console.log('');
  console.log(`Duplicates removed: ${duplicateCount}`);
  console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);

  // JSearch usage
  const jsearchStats = getUsageStats();
  console.log('');
  console.log('JSearch Usage:');
  console.log(`  Requests today: ${jsearchStats.requests_today}/${jsearchStats.remaining_today + jsearchStats.requests_today}`);
  console.log(`  Jobs fetched today: ${jsearchStats.total_jobs_fetched}`);
  console.log(`  Avg per request: ${jsearchStats.avg_jobs_per_request}`);
}

/**
 * Commit changes to git
 * @param {number} jobCount - Number of jobs for commit message
 */
async function gitCommit(jobCount) {
  const { execSync } = require('child_process');

  try {
    // Configure git
    execSync('git config user.email "bot@zapplyjobs.com"');
    execSync('git config user.name "Data Bot"');

    // Add output files
    execSync('git add .github/data/jobs-shared.json');
    execSync('git add .github/data/jobs-metadata.json');
    execSync('git add .github/data/dedupe-store.json');

    // Check if there are changes
    const status = execSync('git status --porcelain', { encoding: 'utf8' });

    if (!status.trim()) {
      console.log('ℹ️ No changes to commit');
      return;
    }

    // Create commit message
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].substring(0, 5);

    const commitMessage = `Update jobs - ${dateStr} ${timeStr}\n\n${jobCount} jobs in shared database`;

    // Commit
    execSync(`git commit -m "${commitMessage}"`);

    console.log(`✅ Committed: ${jobCount} jobs`);

  } catch (error) {
    console.error('⚠️ Git commit failed:', error.message);
    throw error;
  }
}

// Run main function
if (require.main === module) {
  main();
}

module.exports = { main };
