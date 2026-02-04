#!/usr/bin/env node

/**
 * Tag Monitor - Accuracy tracking for tag engine
 *
 * Monitors tag distribution and generates accuracy reports.
 * Target: >85% accuracy (validated manually in Phase 3)
 *
 * Usage:
 *   const monitor = require('./processors/tag-monitor');
 *   const report = monitor.generateAccuracyReport(jobs);
 */

const fs = require('fs');
const path = require('path');

// Tag accuracy monitoring file
const MONITOR_FILE = path.join(process.cwd(), '.github', 'data', 'tag-monitor.json');

/**
 * Sample jobs for manual accuracy validation
 * @param {Array} jobs - All jobs
 * @param {number} sampleSize - Number of jobs to sample (default: 100)
 * @returns {Array} - Sampled jobs
 */
function sampleJobsForValidation(jobs, sampleSize = 100) {
  if (jobs.length === 0) return [];

  // Stratified sampling: ensure representation from each domain
  const sampled = [];
  const domains = ['software', 'data_science', 'hardware', 'nursing', 'product', 'general'];
  const samplesPerDomain = Math.ceil(sampleSize / domains.length);

  for (const domain of domains) {
    const domainJobs = jobs.filter(job =>
      job.tags && job.tags.domains && job.tags.domains.includes(domain)
    );

    // Random sample from this domain
    const shuffled = domainJobs.sort(() => 0.5 - Math.random());
    sampled.push(...shuffled.slice(0, samplesPerDomain));
  }

  // If we have more than needed, trim down
  return sampled.slice(0, sampleSize);
}

/**
 * Generate accuracy report with sampled jobs
 * @param {Array} jobs - All jobs
 * @returns {Object} - Accuracy report
 */
function generateAccuracyReport(jobs) {
  const sampledJobs = sampleJobsForValidation(jobs, 100);

  return {
    timestamp: new Date().toISOString(),
    total_jobs: jobs.length,
    sampled_count: sampledJobs.length,
    status: 'pending_validation', // Requires manual review
    target_accuracy: 0.85, // 85%
    samples: sampledJobs.map(job => ({
      id: job.id,
      title: job.title,
      company: job.company,
      tags: job.tags,
      // Manual validation fields (to be filled)
      validated: false,
      correct_tags: null,
      issues: []
    }))
  };
}

/**
 * Load previous monitoring data
 * @returns {Object} - Monitor data
 */
function loadMonitorData() {
  try {
    if (fs.existsSync(MONITOR_FILE)) {
      return JSON.parse(fs.readFileSync(MONITOR_FILE, 'utf8'));
    }
  } catch (error) {
    console.warn('⚠️ Error loading monitor data:', error.message);
  }

  return {
    created_at: new Date().toISOString(),
    reports: []
  };
}

/**
 * Save monitoring data
 * @param {Object} data - Monitor data
 */
function saveMonitorData(data) {
  try {
    const dir = path.dirname(MONITOR_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(MONITOR_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log('✅ Tag monitor data saved');
  } catch (error) {
    console.error('⚠️ Error saving monitor data:', error.message);
  }
}

/**
 * Add accuracy report to monitoring history
 * @param {Array} jobs - All jobs
 */
function recordAccuracyReport(jobs) {
  const data = loadMonitorData();
  const report = generateAccuracyReport(jobs);

  data.reports.push(report);

  // Keep only last 10 reports
  if (data.reports.length > 10) {
    data.reports = data.reports.slice(-10);
  }

  saveMonitorData(data);

  return report;
}

/**
 * Calculate tag distribution (for monitoring tag health)
 * @param {Array} jobs - All jobs
 * @returns {Object} - Tag distribution statistics
 */
function calculateTagDistribution(jobs) {
  const distribution = {
    employment: {},
    domains: {},
    locations: {},
    experience: {},
    special: {},
    total: jobs.length
  };

  jobs.forEach(job => {
    if (!job.tags) return;

    // Count employment (mutually exclusive)
    if (job.tags.employment) {
      distribution.employment[job.tags.employment] =
        (distribution.employment[job.tags.employment] || 0) + 1;
    }

    // Count domains (multi-select)
    if (job.tags.domains) {
      job.tags.domains.forEach(domain => {
        distribution.domains[domain] =
          (distribution.domains[domain] || 0) + 1;
      });
    }

    // Count locations (multi-select)
    if (job.tags.locations) {
      job.tags.locations.forEach(location => {
        distribution.locations[location] =
          (distribution.locations[location] || 0) + 1;
      });
    }

    // Count experience (mutually exclusive)
    if (job.tags.experience) {
      distribution.experience[job.tags.experience] =
        (distribution.experience[job.tags.experience] || 0) + 1;
    }

    // Count special (multi-select)
    if (job.tags.special) {
      job.tags.special.forEach(tag => {
        distribution.special[tag] =
          (distribution.special[tag] || 0) + 1;
      });
    }
  });

  return distribution;
}

/**
 * Validate tag health (check for anomalies)
 * @param {Object} distribution - Tag distribution from calculateTagDistribution
 * @returns {Array} - List of warnings
 */
function validateTagHealth(distribution) {
  const warnings = [];
  const total = distribution.total;

  // Check for low tag coverage
  const untagged = total - Object.values(distribution.employment).reduce((a, b) => a + b, 0);
  if (untagged > total * 0.05) {
    warnings.push(`${untagged} jobs (${((untagged/total)*100).toFixed(1)}%) missing employment tags`);
  }

  // Check for domain imbalance
  const domainCounts = Object.values(distribution.domains);
  const maxDomain = Math.max(...domainCounts);
  const minDomain = Math.min(...domainCounts);
  if (maxDomain > minDomain * 10) {
    warnings.push(`Domain imbalance: max ${maxDomain} vs min ${minDomain} jobs`);
  }

  // Check for low remote tag coverage
  const remoteJobs = distribution.locations.remote || 0;
  if (remoteJobs < total * 0.1) {
    warnings.push(`Only ${remoteJobs} (${((remoteJobs/total)*100).toFixed(1)}%) jobs tagged as remote`);
  }

  return warnings;
}

/**
 * Print tag distribution summary
 * @param {Array} jobs - All jobs
 */
function printTagDistribution(jobs) {
  const distribution = calculateTagDistribution(jobs);
  const warnings = validateTagHealth(distribution);

  console.log('');
  console.log('📊 Tag Distribution Summary:');
  console.log('━'.repeat(60));

  // Employment tags
  console.log('Employment:');
  for (const [tag, count] of Object.entries(distribution.employment)) {
    const pct = ((count / jobs.length) * 100).toFixed(1);
    console.log(`  ${tag}: ${count} (${pct}%)`);
  }

  // Domain tags
  console.log('Domains:');
  for (const [tag, count] of Object.entries(distribution.domains)) {
    const pct = ((count / jobs.length) * 100).toFixed(1);
    console.log(`  ${tag}: ${count} (${pct}%)`);
  }

  // Location tags
  console.log('Locations:');
  for (const [tag, count] of Object.entries(distribution.locations)) {
    const pct = ((count / jobs.length) * 100).toFixed(1);
    console.log(`  ${tag}: ${count} (${pct}%)`);
  }

  // Warnings
  if (warnings.length > 0) {
    console.log('');
    console.log('⚠️ Health Warnings:');
    warnings.forEach(w => console.log(`  - ${w}`));
  }

  console.log('');
}

module.exports = {
  sampleJobsForValidation,
  generateAccuracyReport,
  recordAccuracyReport,
  calculateTagDistribution,
  validateTagHealth,
  printTagDistribution,
  loadMonitorData,
  saveMonitorData
};
