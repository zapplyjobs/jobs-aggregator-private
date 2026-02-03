#!/usr/bin/env node

/**
 * Job Normalizer
 *
 * Normalizes jobs from different sources to a common format.
 * Currently handles JSearch only, but extensible for ATS APIs.
 */

const helpers = require('../utils/helpers');

/**
 * Normalize jobs from any source to common format
 * @param {Array} jobs - Array of raw job objects
 * @param {string} source - Source identifier
 * @returns {Array} - Normalized job objects
 */
function normalizeJobs(jobs, source) {
  if (!jobs || jobs.length === 0) {
    return [];
  }

  console.log(`📝 Normalizing ${jobs.length} jobs from ${source}...`);

  const normalized = jobs.map(job => normalizeSingleJob(job, source))
    .filter(job => job !== null);

  console.log(`✅ Normalized ${normalized.length} jobs`);
  return normalized;
}

/**
 * Normalize a single job
 * @param {Object} job - Raw job object
 * @param {string} source - Source identifier
 * @returns {Object|null} - Normalized job or null if invalid
 */
function normalizeSingleJob(job, source) {
  try {
    // Common fields (all sources)
    const normalized = {
      // Core identification
      id: generateId(job, source),
      fingerprint: helpers.generateFingerprint(job),

      // Job details
      title: extractTitle(job),
      company: extractCompany(job),
      company_slug: helpers.slugify(extractCompany(job)),
      location: extractLocation(job),
      remote: extractRemote(job),
      url: extractUrl(job),

      // Metadata
      posted_at: helpers.formatDate(extractDate(job)),
      source: source,
      employment_types: extractEmploymentTypes(job),
      experience_level: extractExperienceLevel(job),

      // Enrichment
      description: extractDescription(job),
      enriched: false,
      enriched_at: null,

      // Pre-computed filters
      is_internship: helpers.isInternship(job),
      is_new_grad: helpers.isNewGrad(job),
      is_remote: helpers.isRemote(job),
      is_us_only: helpers.isUSOnly(job),

      // Raw data reference (for debugging)
      _raw: extractRawData(job, source)
    };

    // Validate required fields
    if (!normalized.title || !normalized.company) {
      console.warn(`⚠️ Skipping job with missing title/company: ${JSON.stringify(job).substring(0, 100)}`);
      return null;
    }

    return normalized;

  } catch (error) {
    console.error('⚠️ Error normalizing job:', error.message);
    return null;
  }
}

/**
 * Generate unique ID
 * @param {Object} job - Job object
 * @param {string} source - Source prefix
 * @returns {string} - Unique ID
 */
function generateId(job, source) {
  return helpers.generateJobId(job, source);
}

/**
 * Extract title from job
 * @param {Object} job - Job object
 * @returns {string} - Job title
 */
function extractTitle(job) {
  return job.job_title || job.title || '';
}

/**
 * Extract company from job
 * @param {Object} job - Job object
 * @returns {string} - Company name
 */
function extractCompany(job) {
  return job.employer_name || job.company_name || job.company || '';
}

/**
 * Extract location from job
 * @param {Object} job - Job object
 * @returns {string} - Location string
 */
function extractLocation(job) {
  const city = job.job_city || job.city || '';
  const state = job.job_state || job.state || '';
  const country = job.job_country || job.country || '';

  if (city && state) {
    return `${city}, ${state}`;
  } else if (city && country) {
    return `${city}, ${country}`;
  } else if (city) {
    return city;
  } else if (state) {
    return state;
  } else if (country) {
    return country;
  }

  return 'Unknown';
}

/**
 * Extract remote flag
 * @param {Object} job - Job object
 * @returns {boolean} - True if remote
 */
function extractRemote(job) {
  if (typeof job.job_is_remote === 'boolean') {
    return job.job_is_remote;
  }
  if (typeof job.is_remote === 'boolean') {
    return job.is_remote;
  }

  // Check location string
  const location = extractLocation(job).toLowerCase();
  return location.includes('remote');
}

/**
 * Extract URL from job
 * @param {Object} job - Job object
 * @returns {string} - Application URL
 */
function extractUrl(job) {
  return job.job_apply_link ||
         job.job_google_link ||
         job.url ||
         job.apply_url ||
         '';
}

/**
 * Extract date from job
 * @param {Object} job - Job object
 * @returns {string|null} - Date string or null
 */
function extractDate(job) {
  return job.job_posted_at_datetime_utc ||
         job.posted_at ||
         job.created_at ||
         job.date ||
         null;
}

/**
 * Extract employment types
 * @param {Object} job - Job object
 * @returns {Array} - Employment type array
 */
function extractEmploymentTypes(job) {
  const types = job.job_employment_type ||
                job.employment_type ||
                job.employment_types ||
                [];

  if (Array.isArray(types)) {
    return types.map(t => t.toUpperCase());
  } else if (typeof types === 'string') {
    return types.split(',').map(t => t.trim().toUpperCase());
  }

  return [];
}

/**
 * Extract experience level
 * @param {Object} job - Job object
 * @returns {string} - Experience level
 */
function extractExperienceLevel(job) {
  const title = (job.job_title || job.title || '').toLowerCase();

  // Senior indicators
  if (title.includes('senior') || title.includes('sr.') || title.includes('staff') ||
      title.includes('principal') || title.includes('lead') ||
      title.includes('director') || title.includes('manager')) {
    return 'senior';
  }

  // Mid indicators
  if (title.includes('mid') || title.includes('ii') || title.includes('2')) {
    return 'mid';
  }

  // Default to entry level
  return 'entry';
}

/**
 * Extract description
 * @param {Object} job - Job object
 * @returns {string|null} - Description or null
 */
function extractDescription(job) {
  return job.job_description ||
         job.description ||
         null;
}

/**
 * Extract raw data for debugging
 * @param {Object} job - Job object
 * @param {string} source - Source identifier
 * @returns {Object} - Raw data subset
 */
function extractRawData(job, source) {
  const raw = {
    source: source,
    extracted_at: new Date().toISOString()
  };

  // Source-specific fields
  if (source === 'jsearch') {
    raw.job_id = job.job_id;
    raw.job_publisher = job.job_publisher;
  }

  return raw;
}

module.exports = {
  normalizeJobs,
  normalizeSingleJob
};
