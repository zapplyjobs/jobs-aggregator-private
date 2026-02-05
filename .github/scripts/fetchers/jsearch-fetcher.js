#!/usr/bin/env node

/**
 * JSearch API Fetcher
 *
 * Fetches jobs from JSearch API (RapidAPI)
 * Paid tier: 10,000 requests/month (~333 requests/day with safety margin)
 *
 * Features:
 * - Multi-query per run (3 queries = 72/day < 333 quota)
 * - Query rotation (distributes queries across hourly runs)
 * - Rate limiting (respects daily quota)
 * - Usage tracking
 *
 * UPDATED 2026-02-05: Added entry-level queries for New-Grad-Jobs
 * - Mix of internship and entry-level queries (7 total, rotates 3 per run)
 * - Total: 96 runs × 3 queries = 288 requests/day (within 333 quota)
 */

const fs = require('fs');
const path = require('path');

// Configuration
const JSEARCH_API_KEY = process.env.JSEARCH_API_KEY;
const JSEARCH_BASE_URL = 'https://jsearch.p.rapidapi.com/search';
const MAX_REQUESTS_PER_DAY = 300; // Paid tier: 10,000/month ÷ 30 = ~333/day (using 300 for safety)
const QUERIES_PER_RUN = 3; // Run 3 queries per workflow run
const USAGE_FILE = path.join(process.cwd(), '.github', 'data', 'jsearch-usage.json');

// Query sets for Tagged Streams Aggregator
// Organized by job type to ensure good coverage for all repos
const QUERY_SETS = {
  // Internship queries (for Internships-2026)
  internships: [
    'software engineer intern internship co-op summer program',
    'data science intern internship analytics',
    'nursing intern internship healthcare medical'
  ],
  // Entry-level queries (for New-Grad-Jobs-2026)
  entryLevel: [
    'entry level software engineer new graduate',
    'associate software engineer',
    'junior software engineer'
  ],
  // Mixed queries for broad coverage
  mixed: [
    'software engineer intern',  // Internship
    'entry level software engineer'  // Entry-level
  ]
};

// Use all queries - rotates through internship, entry-level, and mixed
const ALL_QUERIES = [
  ...QUERY_SETS.internships,
  ...QUERY_SETS.entryLevel,
  ...QUERY_SETS.mixed
];

/**
 * Select which queries to run based on hour
 * Rotates through query sets to ensure diverse coverage
 * @param {number} hour - Current UTC hour
 * @returns {Array} - Array of query strings to run
 */
function selectQueriesForHour(hour) {
  // Each hour runs 3 different queries
  // Rotate through ALL_QUERIES (7 total: 3 internships, 3 entryLevel, 1 mixed)
  // Pattern: hour 0 = [0,2,4], hour 1 = [1,3,5], hour 2 = [2,4,6], etc.

  const startIndex = (hour * QUERIES_PER_RUN) % ALL_QUERIES.length;
  const queries = [];

  for (let i = 0; i < QUERIES_PER_RUN; i++) {
    const index = (startIndex + i) % ALL_QUERIES.length;
    queries.push(ALL_QUERIES[index]);
  }

  return queries;
}

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
 * Make a single API request to JSearch
 * @param {string} query - Search query
 * @param {number} requestNum - Request number for logging
 * @returns {Promise<Array>} - Array of job objects
 */
async function makeAPIRequest(query, requestNum) {
  console.log(`📡 JSearch API - Query ${requestNum}/${QUERIES_PER_RUN}: "${query}"`);

  // Build API request
  const url = new URL(JSEARCH_BASE_URL);
  url.searchParams.append('query', `${query} United States`);
  url.searchParams.append('page', '1');
  url.searchParams.append('num_pages', 20);  // Up to 200 jobs per request (was 10, trying more)
  url.searchParams.append('date_posted', 'month');
  url.searchParams.append('country', 'us');

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

  // Diagnostic logging
  console.log(`✅ Query ${requestNum} returned ${jobs.length} jobs`);
  if (data.jobs_count !== undefined) {
    console.log(`   API reports total available: ${data.jobs_count} jobs`);
  }
  if (data.pages !== undefined) {
    console.log(`   Pages returned: ${data.pages}, Requested: 20`);
  }
  if (data.parameters) {
    console.log(`   API parameters:`, JSON.stringify(data.parameters));
  }

  return jobs;
}

/**
 * Fetch jobs from JSearch API (multiple queries)
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
  console.log(`📊 Running ${QUERIES_PER_RUN} queries this run`);

  try {
    // Select queries based on current hour
    const currentHour = new Date().getUTCHours();
    const queries = selectQueriesForHour(currentHour);

    console.log(`🕐 Hour ${currentHour}: Running queries:`, queries.map((q, i) => `${i + 1}. "${q.substring(0, 40)}..."`));

    // Execute all queries for this run
    let allJobs = [];
    for (let i = 0; i < queries.length; i++) {
      // Check quota before each request
      if (usage.requests >= MAX_REQUESTS_PER_DAY) {
        console.log(`⏸️ Daily limit reached after ${i} queries, stopping`);
        break;
      }

      const jobs = await makeAPIRequest(queries[i], i + 1);
      allJobs.push(...jobs);

      // Update usage tracking
      usage.requests++;
      usage.remaining = MAX_REQUESTS_PER_DAY - usage.requests;
      usage.queries_executed.push(queries[i]);

      // Track metrics
      if (!usage.metrics.jobs_per_query[queries[i]]) {
        usage.metrics.jobs_per_query[queries[i]] = [];
      }
      usage.metrics.jobs_per_query[queries[i]].push(jobs.length);
      usage.metrics.total_jobs += jobs.length;
    }

    saveUsageTracking(usage);

    const avgJobsPerRequest = usage.metrics.total_jobs / usage.requests;
    console.log(`📊 Total jobs fetched this run: ${allJobs.length} (avg ${avgJobsPerRequest.toFixed(1)} jobs/request)`);
    console.log(`📊 Total jobs fetched today: ${usage.metrics.total_jobs}`);

    return normalizeJobs(allJobs);

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
  QUERIES_PER_RUN,
  ALL_QUERIES
};
