#!/usr/bin/env node

/**
 * Consumer Utilities - Tag-based job filtering for repositories
 *
 * Enables repositories to consume the shared tagged jobs feed
 * and filter by domain-specific criteria.
 *
 * Usage:
 *   const { fetchJobsFromAggregator, filterByTags } = require('./consumer-utils');
 *   const jobs = await fetchJobsFromAggregator();
 *   const filtered = filterByTags(jobs, { employment: 'internship' });
 */

const https = require('https');

// Aggregator output URL (raw GitHub content)
// NOTE: This is a PRIVATE repo - consumers need authentication to fetch
const AGGREGATOR_URL = 'https://raw.githubusercontent.com/zapplyjobs/jobs-aggregator-private/main/.github/data/all_jobs.json';
const METADATA_URL = 'https://raw.githubusercontent.com/zapplyjobs/jobs-aggregator-private/main/.github/data/jobs-metadata.json';

/**
 * Fetch jobs from the aggregator
 * @param {string} url - Optional custom URL (for testing)
 * @returns {Promise<Array>} - Array of job objects
 */
async function fetchJobsFromAggregator(url = AGGREGATOR_URL) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          // Parse JSONL (one JSON per line)
          const lines = data.trim().split('\n').filter(line => line);
          const jobs = lines.map(line => {
            try {
              return JSON.parse(line);
            } catch (error) {
              console.warn('⚠️ Failed to parse line:', line.substring(0, 50));
              return null;
            }
          }).filter(job => job !== null);

          resolve(jobs);
        } catch (error) {
          reject(new Error(`Failed to parse jobs: ${error.message}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch metadata from the aggregator
 * @returns {Promise<Object>} - Metadata object
 */
async function fetchMetadata(url = METADATA_URL) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error(`Failed to parse metadata: ${error.message}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Filter jobs by tags
 * @param {Array} jobs - Array of tagged jobs
 * @param {Object} filters - Tag filters
 * @param {string} filters.employment - Employment type (exact match)
 * @param {Array<string>} filters.domains - Domain tags (any match)
 * @param {Array<string>} filters.locations - Location tags (any match)
 * @param {string} filters.experience - Experience level (exact match)
 * @param {Array<string>} filters.special - Special tags (any match)
 * @returns {Array} - Filtered jobs
 */
function filterByTags(jobs, filters = {}) {
  if (!Array.isArray(jobs)) {
    console.warn('filterByTags: jobs is not an array');
    return [];
  }

  return jobs.filter(job => {
    // Skip jobs without tags
    if (!job.tags) {
      return false;
    }

    // Employment filter (mutually exclusive - exact match)
    if (filters.employment && job.tags.employment !== filters.employment) {
      return false;
    }

    // Domains filter (multi-select - any match)
    if (filters.domains && filters.domains.length > 0) {
      if (!job.tags.domains || !Array.isArray(job.tags.domains)) {
        return false;
      }
      const hasMatchingDomain = filters.domains.some(d => job.tags.domains.includes(d));
      if (!hasMatchingDomain) {
        return false;
      }
    }

    // Locations filter (multi-select - any match)
    if (filters.locations && filters.locations.length > 0) {
      if (!job.tags.locations || !Array.isArray(job.tags.locations)) {
        return false;
      }
      const hasMatchingLocation = filters.locations.some(l => job.tags.locations.includes(l));
      if (!hasMatchingLocation) {
        return false;
      }
    }

    // Experience filter (mutually exclusive - exact match)
    if (filters.experience && job.tags.experience !== filters.experience) {
      return false;
    }

    // Special filter (multi-select - any match)
    if (filters.special && filters.special.length > 0) {
      if (!job.tags.special || !Array.isArray(job.tags.special)) {
        // No special tags is OK - just don't filter by special
        return true;
      }
      const hasMatchingSpecial = filters.special.some(s => job.tags.special.includes(s));
      if (!hasMatchingSpecial) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Create a filter configuration for a specific repository
 * @param {string} repo - Repository name (internships, software, data_science, hardware, nursing, remote)
 * @returns {Object} - Filter configuration
 */
function getFilterConfig(repo) {
  const configs = {
    internships: {
      employment: 'internship',
      domains: ['software', 'data_science', 'hardware', 'nursing', 'product', 'general']
    },
    software: {
      domains: ['software'],
      locations: ['us', 'remote']
    },
    data_science: {
      domains: ['data_science'],
      locations: ['us', 'remote']
    },
    hardware: {
      domains: ['hardware'],
      locations: ['us', 'remote']
    },
    nursing: {
      domains: ['nursing'],
      locations: ['us', 'remote']
    },
    product: {
      domains: ['product'],
      locations: ['us', 'remote']
    },
    remote: {
      locations: ['remote']
    }
  };

  return configs[repo] || {};
}

/**
 * Fetch and filter jobs for a specific repository
 * @param {string} repo - Repository name
 * @param {Object} customFilters - Optional custom filters to override defaults
 * @returns {Promise<Array>} - Filtered jobs
 */
async function fetchJobsForRepo(repo, customFilters = null) {
  try {
    const jobs = await fetchJobsFromAggregator();
    const filters = customFilters || getFilterConfig(repo);
    const filtered = filterByTags(jobs, filters);

    console.log(`📊 ${repo}: ${filtered.length}/${jobs.length} jobs match filters`);

    return filtered;
  } catch (error) {
    console.error(`❌ Error fetching jobs for ${repo}:`, error.message);
    return [];
  }
}

/**
 * Print filter statistics
 * @param {Array} jobs - All jobs
 * @param {Object} filters - Applied filters
 * @param {Array} filtered - Filtered jobs
 */
function printFilterStats(jobs, filters, filtered) {
  console.log('');
  console.log('📊 Filter Statistics:');
  console.log('━'.repeat(60));

  // Before/after counts
  console.log(`Input jobs: ${jobs.length}`);
  console.log(`Filtered jobs: ${filtered.length}`);
  console.log(`Filtered out: ${jobs.length - filtered.length} (${(((jobs.length - filtered.length) / jobs.length) * 100).toFixed(1)}%)`);

  // Applied filters
  console.log('');
  console.log('Applied filters:');
  if (filters.employment) console.log(`  employment: ${filters.employment}`);
  if (filters.domains) console.log(`  domains: ${filters.domains.join(', ')}`);
  if (filters.locations) console.log(`  locations: ${filters.locations.join(', ')}`);
  if (filters.experience) console.log(`  experience: ${filters.experience}`);
  if (filters.special) console.log(`  special: ${filters.special.join(', ')}`);

  console.log('');
}

/**
 * Write jobs to JSONL file (for local testing)
 * @param {Array} jobs - Jobs to write
 * @param {string} filePath - Output file path
 * @returns {Promise<void>}
 */
async function writeJobsToFile(jobs, filePath) {
  const fs = require('fs');
  const path = require('path');

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const jsonlContent = jobs.map(job => JSON.stringify(job)).join('\n') + '\n';
  fs.writeFileSync(filePath, jsonlContent, 'utf8');

  console.log(`✅ Wrote ${jobs.length} jobs to ${filePath}`);
}

module.exports = {
  fetchJobsFromAggregator,
  fetchMetadata,
  filterByTags,
  getFilterConfig,
  fetchJobsForRepo,
  printFilterStats,
  writeJobsToFile,
  AGGREGATOR_URL,
  METADATA_URL
};
