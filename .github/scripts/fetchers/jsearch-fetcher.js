#!/usr/bin/env node

/**
 * JSearch API Fetcher
 *
 * Fetches jobs from JSearch API (RapidAPI)
 * Free tier: 200 requests/month (~6 requests/day with safety margin)
 *
 * Features:
 * - Query rotation (distributes queries across hourly runs)
 * - Rate limiting (respects daily quota)
 * - Usage tracking
 */

const fs = require('fs');
const path = require('path');

// Configuration
const JSEARCH_API_KEY = process.env.JSEARCH_API_KEY;
const JSEARCH_BASE_URL = 'https://jsearch.p.rapidapi.com/search';
const MAX_REQUESTS_PER_DAY = 6; // Free tier: 200/month ÷ 30 = ~6/day
const USAGE_FILE = path.join(process.cwd(), '.github', 'data', 'jsearch-usage.json');

// Query rotation - 5 queries for internships, new grad, remote
const QUERIES = [
  // Internship queries
  'software engineer intern',
  'software engineering internship',
  'data science intern',
  'machine learning intern',
  'product manager intern',
  // New grad queries
  'new grad software engineer',
  'entry level software engineer',
  'junior software engineer',
  'graduate software engineer',
  'associate software engineer',
  // Remote queries
  'remote software engineer',
  'remote developer',
  'work from home software engineer'
];

/**
 * Load or initialize usage tracking
 */
function loadUsageTracking() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
      const today = new Date().toISOString().split('T')[0];

      // Reset counter if new day
      if (data.date !== today) {
        return {
          date: today,
          requests: 0,
          remaining: MAX_REQUESTS_PER_DAY,
          queries_executed: [],
          metrics: { jobs_per_query: {}, total_jobs: 0 }
        };
      }
      return data;
    }
  } catch (error) {
    console.error('⚠️ Error loading usage tracking:', error.message);
  }

  // Initialize new tracking
  return {
    date: new Date().toISOString().split('T')[0],
    requests: 0,
    remaining: MAX_REQUESTS_PER_DAY,
    queries_executed: [],
    metrics: { jobs_per_query: {}, total_jobs: 0 }
  };
}

/**
 * Save usage tracking
 */
function saveUsageTracking(data) {
  try {
    const dir = path.dirname(USAGE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('⚠️ Error saving usage tracking:', error.message);
  }
}

/**
 * Fetch jobs from JSearch API
 * @returns {Promise<Array>} - Array of normalized job objects
 */
async function fetchFromJSearch() {
  // Check API key
  if (!JSEARCH_API_KEY || JSEARCH_API_KEY === 'YOUR_KEY_HERE') {
    console.error('❌ JSEARCH_API_KEY not set');
    return [];
  }

  // Load usage tracking
  const usage = loadUsageTracking();

  // Check rate limit
  if (usage.requests >= MAX_REQUESTS_PER_DAY) {
    console.log(`⏸️ JSearch daily limit reached (${usage.requests}/${MAX_REQUESTS_PER_DAY}), skipping this run`);
    return [];
  }

  console.log(`📊 JSearch quota: ${usage.remaining}/${MAX_REQUESTS_PER_DAY} requests remaining`);

  try {
    // Select query based on current hour (rotation)
    const currentHour = new Date().getUTCHours();
    const queryIndex = currentHour % QUERIES.length;
    const query = QUERIES[queryIndex];

    console.log(`📡 JSearch API - Query: "${query}" (${usage.requests + 1}/${MAX_REQUESTS_PER_DAY} today)`);

    // Build API request
    const url = new URL(JSEARCH_BASE_URL);
    url.searchParams.append('query', `${query} United States`);
    url.searchParams.append('page', '1');
    url.searchParams.append('num_pages', '10');  // Up to 100 jobs per request
    url.searchParams.append('date_posted', 'month');
    url.searchParams.append('employment_types', 'INTERN,FULLTIME');  // Both internships and entry level
    url.searchParams.append('job_requirements', 'no_experience,under_3_years_experience');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': JSEARCH_API_KEY,
        'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
      }
    });

    if (!response.ok) {
      console.error(`❌ JSearch API request failed: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json();
    const jobs = data.data || [];

    // Update usage tracking
    usage.requests++;
    usage.remaining = MAX_REQUESTS_PER_DAY - usage.requests;
    usage.queries_executed.push(query);

    // Track metrics
    if (!usage.metrics.jobs_per_query[query]) {
      usage.metrics.jobs_per_query[query] = [];
    }
    usage.metrics.jobs_per_query[query].push(jobs.length);
    usage.metrics.total_jobs += jobs.length;

    saveUsageTracking(usage);

    const avgJobsPerRequest = usage.metrics.total_jobs / usage.requests;
    console.log(`✅ JSearch returned ${jobs.length} jobs (avg ${avgJobsPerRequest.toFixed(1)} jobs/request)`);
    console.log(`📊 Total jobs fetched today: ${usage.metrics.total_jobs}`);

    return normalizeJobs(jobs);

  } catch (error) {
    console.error('❌ JSearch API error:', error.message);
    return [];
  }
}

/**
 * Normalize JSearch jobs to common format
 * @param {Array} jobs - Raw JSearch jobs
 * @returns {Array} - Normalized job objects
 */
function normalizeJobs(jobs) {
  const helpers = require('../utils/helpers');

  return jobs.map(job => {
    try {
      const normalized = {
        // Core identification
        id: helpers.generateJobId(job, 'js'),
        fingerprint: helpers.generateFingerprint(job),

        // Job details
        title: job.job_title || '',
        company: job.employer_name || '',
        company_slug: helpers.slugify(job.employer_name || ''),
        location: formatLocation(job),
        remote: job.job_is_remote || false,
        url: job.job_apply_link || job.job_google_link || '',

        // Metadata
        posted_at: helpers.formatDate(job.job_posted_at_datetime_utc),
        source: 'jsearch',
        employment_types: parseEmploymentTypes(job.job_employment_type),
        experience_level: parseExperienceLevel(job),

        // Enrichment
        description: job.job_description || null,
        enriched: false,
        enriched_at: null,

        // Pre-computed filters
        is_internship: helpers.isInternship(job),
        is_new_grad: helpers.isNewGrad(job),
        is_remote: helpers.isRemote(job),
        is_us_only: helpers.isUSOnly(job),

        // Raw data reference
        _raw: {
          job_id: job.job_id,
          job_publisher: job.job_publisher,
          job_latitude: job.job_latitude,
          job_longitude: job.job_longitude
        }
      };

      return normalized;

    } catch (error) {
      console.error('⚠️ Error normalizing job:', error.message);
      return null;
    }
  }).filter(job => job !== null);
}

/**
 * Format location from JSearch job
 * @param {Object} job - JSearch job object
 * @returns {string} - Formatted location
 */
function formatLocation(job) {
  const city = job.job_city || '';
  const state = job.job_state || '';

  if (city && state) {
    return `${city}, ${state}`;
  } else if (city) {
    return city;
  } else if (state) {
    return state;
  } else if (job.job_is_remote) {
    return 'Remote';
  }

  return 'Unknown';
}

/**
 * Parse employment types from JSearch
 * @param {string|string[]} types - Employment type(s)
 * @returns {Array} - Array of employment types
 */
function parseEmploymentTypes(types) {
  if (Array.isArray(types)) {
    return types.map(t => t.toUpperCase());
  } else if (typeof types === 'string') {
    return types.split(',').map(t => t.trim().toUpperCase());
  }
  return [];
}

/**
 * Parse experience level from job
 * @param {Object} job - Job object
 * @returns {string} - Experience level
 */
function parseExperienceLevel(job) {
  const title = (job.job_title || '').toLowerCase();
  const description = (job.job_description || '').toLowerCase();

  // Senior indicators
  if (title.includes('senior') || title.includes('sr.') || title.includes('staff') ||
      title.includes('principal') || title.includes('lead')) {
    return 'senior';
  }

  // Mid indicators
  if (title.includes('mid') || title.includes('mid-level')) {
    return 'mid';
  }

  // Entry level (default)
  return 'entry';
}

/**
 * Get current usage statistics
 * @returns {Object} - Usage stats
 */
function getUsageStats() {
  const usage = loadUsageTracking();
  return {
    date: usage.date,
    requests_today: usage.requests,
    remaining_today: usage.remaining,
    total_jobs_fetched: usage.metrics.total_jobs,
    avg_jobs_per_request: usage.requests > 0
      ? (usage.metrics.total_jobs / usage.requests).toFixed(1)
      : 0
  };
}

module.exports = {
  fetchFromJSearch,
  getUsageStats,
  MAX_REQUESTS_PER_DAY,
  QUERIES
};
