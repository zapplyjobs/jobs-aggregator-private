#!/usr/bin/env node

/**
 * Utility Functions for Jobs Data Fetcher
 *
 * Common helpers used across fetchers, processors, and the main orchestrator.
 */

const crypto = require('crypto');

/**
 * Generate a unique job ID
 * @param {Object} job - Job object
 * @param {string} source - Source prefix ('js', 'gh', 'lv', 'ash', 'usajobs')
 * @returns {string} - Unique ID
 */
function generateJobId(job, source = 'unknown') {
  const companySlug = slugify(job.employer_name || job.company_name || 'unknown');
  const jobTitleSlug = slugify(job.job_title || job.title || 'unknown');

  // Extract job ID from URL or generate from title+company
  let jobIdSuffix;
  if (job.job_id) {
    jobIdSuffix = String(job.job_id);
  } else if (job.job_google_link) {
    const match = job.job_google_link.match(/\/([a-z0-9-]+)\/?$/i);
    jobIdSuffix = match ? match[1] : hashString(`${jobTitleSlug}-${companySlug}`);
  } else {
    jobIdSuffix = hashString(`${jobTitleSlug}-${companySlug}-${job.location || ''}`);
  }

  return `${source}-${companySlug}-${jobIdSuffix}`.toLowerCase();
}

/**
 * Generate a fingerprint for deduplication
 * @param {Object} job - Job object
 * @returns {string} - SHA-256 hash
 */
function generateFingerprint(job) {
  const title = (job.job_title || job.title || '').toLowerCase().trim();
  const company = (job.employer_name || job.company_name || '').toLowerCase().trim();
  const location = (job.job_city || job.location || '').toLowerCase().trim();

  const normalized = `${title}|${company}|${location}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Slugify a string for use in URLs/IDs
 * @param {string} str - String to slugify
 * @returns {string} - Slugified string
 */
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^\w\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-')      // Spaces to hyphens
    .replace(/-+/g, '-')       // Collapse multiple hyphens
    .trim();
}

/**
 * Hash a string (for fallback ID generation)
 * @param {string} str - String to hash
 * @returns {string} - Hex hash
 */
function hashString(str) {
  return crypto.createHash('sha256').update(str).digest('hex').substring(0, 12);
}

/**
 * Check if a job is an internship
 * @param {Object} job - Job object
 * @returns {boolean} - True if internship
 */
function isInternship(job) {
  const title = (job.job_title || job.title || '').toLowerCase();
  const description = (job.job_description || '').toLowerCase();
  const employmentTypes = job.job_employment_type || [];

  // Check employment type field first
  if (employmentTypes.some(t => t.includes('INTERN') || t.includes('INTERN'))) {
    return true;
  }

  // Check title for internship keywords
  const internKeywords = ['intern', 'internship', 'co-op', 'coop'];
  if (internKeywords.some(kw => title.includes(kw))) {
    return true;
  }

  // Check description for internship program mentions
  if (description.includes('internship program') ||
      description.includes('intern program') ||
      description.includes('summer intern')) {
    return true;
  }

  return false;
}

/**
 * Check if a job is new grad / entry level
 * @param {Object} job - Job object
 * @returns {boolean} - True if new grad / entry level
 */
function isNewGrad(job) {
  const title = (job.job_title || job.title || '').toLowerCase();
  const description = (job.job_description || '').toLowerCase();
  const employmentTypes = job.job_employment_type || [];

  // Check employment type
  if (employmentTypes.some(t => t.includes('FULLTIME'))) {
    // Full-time, check if entry level
    const entryKeywords = [
      'new grad', 'new graduate', 'entry level', 'entry-level',
      'junior', 'associate', 'graduate software'
    ];

    if (entryKeywords.some(kw => title.includes(kw))) {
      return true;
    }

    // Check description for entry-level indicators
    if (description.includes('0 years') ||
        description.includes('recent graduate') ||
        description.includes('new graduate')) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a job is remote
 * @param {Object} job - Job object
 * @returns {boolean} - True if remote
 */
function isRemote(job) {
  const title = (job.job_title || job.title || '').toLowerCase();
  const location = (job.job_city || job.job_location || '').toLowerCase();
  const description = (job.job_description || '').toLowerCase();

  // Check explicit remote flag
  if (job.job_is_remote === true || job.is_remote === true) {
    return true;
  }

  // Check title
  if (title.includes('remote')) {
    return true;
  }

  // Check location
  if (location === 'remote' || location.includes('remote')) {
    return true;
  }

  return false;
}

/**
 * Check if a job is US-only
 * @param {Object} job - Job object
 * @returns {boolean} - True if US-only
 */
function isUSOnly(job) {
  const location = (job.job_city || job.job_location || '').toLowerCase();
  const country = (job.job_country || '').toLowerCase();
  const description = (job.job_description || '').toLowerCase();

  // Explicit US check
  if (country === 'united states' || country === 'us') {
    return true;
  }

  // Check location for US cities/states
  const usStates = [
    'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
    'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
    'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
    'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
    'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
    'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina',
    'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
    'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas',
    'utah', 'vermont', 'virginia', 'washington', 'west virginia',
    'wisconsin', 'wyoming', 'dc', 'wa', 'ca', 'tx', 'ny', 'sf', 'seattle'
  ];

  if (usStates.some(state => location.includes(state))) {
    return true;
  }

  // Check for US-only language in description
  if (description.includes('must be authorized to work in the us') ||
      description.includes('us-based only') ||
      description.includes('united states only')) {
    return true;
  }

  // Default: true if no international indicators
  const internationalIndicators = [
    'canada', 'uk', 'united kingdom', 'europe', 'asia', 'remote - global',
    'remote - any', 'worldwide', 'any location'
  ];

  if (internationalIndicators.some(ind =>
    location.includes(ind) || description.includes(ind))) {
    return false;
  }

  return true;
}

/**
 * Delay helper
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format date to ISO string
 * @param {Date|string} date - Date to format
 * @returns {string} - ISO 8601 string
 */
function formatDate(date) {
  if (!date) return new Date().toISOString();

  if (typeof date === 'string') {
    return new Date(date).toISOString();
  }

  return date.toISOString();
}

module.exports = {
  generateJobId,
  generateFingerprint,
  slugify,
  hashString,
  isInternship,
  isNewGrad,
  isRemote,
  isUSOnly,
  delay,
  formatDate
};
