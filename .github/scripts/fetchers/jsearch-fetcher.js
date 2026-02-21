#!/usr/bin/env node

/**
 * JSearch API Fetcher
 *
 * Fetches jobs from JSearch API (RapidAPI)
 * Paid tier: 10,000 requests/month (~333 requests/day with safety margin)
 *
 * Features:
 * - Single query per run (1 query × 96 runs/day = 96 requests/day << 333 quota)
 * - Query rotation (distributes queries across 15-min runs)
 * - Rate limiting (respects daily quota)
 * - Usage tracking
 *
 * UPDATED 2026-02-20: Redesigned query sets — one set per consumer domain
 * - 15 queries total (software:4, datascience:4, hardware:4, nursing:3)
 * - Rotates 1 per run: full domain coverage every 15 runs (~4 hours)
 * - Total: 96 runs × 1 query = 96 requests/day (well within 333 quota)
 */

const fs = require('fs');
const path = require('path');

// Configuration
const JSEARCH_API_KEY = process.env.JSEARCH_API_KEY;
const JSEARCH_BASE_URL = 'https://jsearch.p.rapidapi.com/search';
const MAX_REQUESTS_PER_DAY = 300; // Paid tier: 10,000/month ÷ 30 = ~333/day (using 300 for safety)
const QUERIES_PER_RUN = 1; // 1 query per run × 96 runs/day = 96 requests/day (<<333 quota)
const USAGE_FILE = path.join(process.cwd(), '.github', 'data', 'jsearch-usage.json');

// Query sets for Tagged Streams Aggregator
// One set per consumer repo domain. Each set covers both internship and entry-level
// so the tag-engine can split them correctly downstream.
const QUERY_SETS = {
  // Software Engineering (for New-Grad-Software-Engineering-Jobs-2026 + Internships)
  software: [
    'software engineer intern',
    'software engineer new graduate entry level',
    'junior software engineer',
    'associate software engineer'
  ],
  // Data Science (for New-Grad-Data-Science-Jobs-2026 + Internships)
  datascience: [
    'data science intern',
    'data scientist entry level new graduate',
    'data analyst entry level',
    'machine learning engineer entry level'
  ],
  // Hardware Engineering (for New-Grad-Hardware-Engineering-Jobs-2026)
  hardware: [
    'hardware engineer entry level new graduate',
    'electrical engineer entry level new graduate',
    'embedded systems engineer entry level',
    'firmware engineer entry level'
  ],
  // Nursing (for New-Grad-Nursing-Jobs-2026)
  nursing: [
    'registered nurse entry level new graduate',
    'new grad nurse RN',
    'nurse practitioner entry level'
  ]
};

// Flat list — all queries across all domains
// 15 total: rotates 3 per hour = 15 unique per 5-hour cycle = full coverage daily
const ALL_QUERIES = [
  ...QUERY_SETS.software,
  ...QUERY_SETS.datascience,
  ...QUERY_SETS.hardware,
  ...QUERY_SETS.nursing
];

/**
 * Select which queries to run based on hour
 * Rotates through query sets to ensure diverse coverage
 * @param {number} hour - Current UTC hour
 * @returns {Array} - Array of query strings to run
 */
function selectQueriesForHour(hour) {
  // Runs 1 query per 15-min interval
  // Rotate through ALL_QUERIES (15 total across 4 domains)
  // Full cycle every 15 runs (~4 hours) — all domains covered multiple times per day

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
