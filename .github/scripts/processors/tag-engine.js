/**
 * Tag Engine - Rule-based job tagging
 *
 * Applies multi-layer tags to jobs based on:
 * - Title analysis (keyword matching)
 * - Description analysis (keyword matching)
 * - Employment type field (from API)
 * - Company name lookup (special tags)
 * - Location analysis (location tags)
 *
 * Phase 1: Rule-based implementation (target: >85% accuracy)
 * Phase 2: ML enhancement (if accuracy <85%)
 */

/**
 * Tag a single job with all tag categories
 * @param {Object} job - Normalized job object
 * @returns {Object} - Job with tags property added
 */
function tagJob(job) {
  const taggedJob = { ...job };

  taggedJob.tags = {
    employment: tagEmployment(job),
    domains: tagDomains(job),
    locations: tagLocations(job),
    experience: tagExperience(job),
    special: tagSpecial(job)
  };

  return taggedJob;
}

/**
 * Tag an array of jobs
 * @param {Array} jobs - Job array
 * @returns {Array} - Jobs with tags
 */
function tagJobs(jobs) {
  if (!Array.isArray(jobs)) {
    console.warn('tagJobs: Expected array, got', typeof jobs);
    return [];
  }

  return jobs.map(job => tagJob(job));
}

/**
 * Tag employment type (mutually exclusive)
 * Priority: internship > senior > mid_level > entry_level
 */
function tagEmployment(job) {
  const title = (job.title || '').toLowerCase();
  const description = (job.description || '').toLowerCase();
  const employmentType = (job.employment_type || '').toLowerCase();

  // Check for internship (highest priority after senior)
  if (title.includes('intern') || title.includes('internship') || title.includes('co-op') || title.includes('coop')) {
    // Filter fake internships
    const fakePatterns = ['senior intern', 'sr. intern', 'principal intern', 'manager intern'];
    const isFakeIntern = fakePatterns.some(pattern => title.includes(pattern));

    if (!isFakeIntern) {
      return 'internship';
    }
  }

  // Check for senior level (highest priority)
  if (title.includes('senior') || title.includes('sr.') || title.includes('sr ') ||
      title.includes('principal') || title.includes('staff') || title.includes('lead')) {
    return 'senior';
  }

  // Check for mid-level
  if (title.includes('mid') || title.includes('mid-level') || title.includes('mid level')) {
    return 'mid_level';
  }

  // Default to entry level
  return 'entry_level';
}

/**
 * Tag domains (multi-select)
 * Returns array of matching domains
 */
function tagDomains(job) {
  const title = (job.title || '').toLowerCase();
  const description = (job.description || '').toLowerCase();
  const tags = [];

  // Software domain (removed bare 'developer' — too broad, matches 'developer relations', 'developer advocate')
  const softwareKeywords = [
    'software engineer', 'software developer', 'full stack', 'fullstack',
    'frontend', 'back end', 'backend', 'web developer', 'web dev',
    'mobile developer', 'ios developer', 'android developer',
    'devops', 'sre', 'site reliability', 'platform engineer',
    'swe'
  ];
  if (softwareKeywords.some(kw => title.includes(kw))) {
    tags.push('software');
  }

  // Data Science domain (title-only, specific keywords — avoid broad terms like 'analytics', 'intelligence')
  const dataScienceKeywords = [
    'data scientist', 'data engineer', 'data analyst',
    'machine learning', 'ml engineer', 'ai engineer'
  ];
  if (dataScienceKeywords.some(kw => title.includes(kw))) {
    tags.push('data_science');
  }

  // Hardware domain
  const hardwareKeywords = [
    'hardware engineer', 'embedded', 'firmware', 'electrical engineer',
    'chip design', 'fpga', 'pcb', 'vlsi', 'robotics', 'mechatronics'
  ];
  if (hardwareKeywords.some(kw => title.includes(kw))) {
    tags.push('hardware');
  }

  // Nursing domain (title-only, specific credentials — removed 'healthcare', 'clinical', 'patient care'
  // which also appear in non-nursing titles like 'Clinical Data Analyst', 'Healthcare Software Engineer')
  const nursingKeywords = [
    'registered nurse', 'nurse practitioner', 'nursing', 'lpn', 'lvn', 'cna'
  ];
  if (nursingKeywords.some(kw => title.includes(kw))) {
    tags.push('nursing');
  }

  // Product domain
  const productKeywords = [
    'product manager', 'pm', 'product designer', 'ux designer',
    'ui designer', 'user experience', 'product owner', 'product marketing'
  ];
  if (productKeywords.some(kw => title.includes(kw))) {
    tags.push('product');
  }

  // Default to general if no matches
  if (tags.length === 0) {
    tags.push('general');
  }

  return tags;
}

/**
 * Non-US location indicators (city names, countries, regions)
 * Used to detect ATS jobs with non-US locations (ATS normalizer sets job.location
 * as a string but doesn't populate job.job_country, so is_us_only is unreliable for ATS)
 */
const NON_US_LOCATIONS = [
  // Countries
  'canada', 'mexico', 'ireland', 'united kingdom', 'uk', 'germany', 'france',
  'netherlands', 'india', 'singapore', 'japan', 'australia', 'brazil', 'spain',
  'sweden', 'denmark', 'norway', 'finland', 'switzerland', 'poland', 'czechia',
  'romania', 'argentina', 'chile', 'colombia', 'peru', 'israel', 'turkey',
  'south korea', 'china', 'taiwan', 'new zealand', 'south africa', 'portugal',
  // Common non-US cities that appear in ATS feeds
  'toronto', 'vancouver', 'montreal', 'ottawa', 'calgary', // Canada
  'london', 'manchester', 'edinburgh', // UK
  'dublin', 'cork', // Ireland
  'berlin', 'munich', 'hamburg', // Germany
  'amsterdam', 'rotterdam', // Netherlands
  'bengaluru', 'bangalore', 'mumbai', 'hyderabad', 'pune', 'chennai', 'delhi', // India
  'singapore',
  'sydney', 'melbourne', 'brisbane', // Australia
  'tokyo', 'osaka', // Japan
  'mexico city', 'guadalajara', 'monterrey', // Mexico
  'paris', 'lyon', // France
  'stockholm', 'gothenburg', // Sweden
  'tel aviv', 'jerusalem', // Israel
  'zurich', 'geneva', // Switzerland
  'warsaw', 'krakow', // Poland
  'prague', // Czechia
  'bucharest', // Romania
  'madrid', 'barcelona', // Spain
  'lisbon', 'porto', // Portugal
];

/**
 * Tag locations (multi-select)
 * Handles both JSearch format (job.is_us_only, job.is_remote)
 * and ATS format (job.location as string, no job_country field)
 */
function tagLocations(job) {
  const tags = [];

  // Combine all location fields for checking
  const locationStr = (
    job.location || job.job_city || job.job_location || job.job_country || ''
  ).toLowerCase();

  // Check for explicit non-US location in location string
  const isExplicitlyNonUS = NON_US_LOCATIONS.some(place => locationStr.includes(place));
  if (isExplicitlyNonUS) {
    // Don't add 'us' tag — skip to remote check
  } else if (job.is_us_only === true) {
    // JSearch jobs: trust is_us_only flag
    tags.push('us');
  } else if (locationStr && !isExplicitlyNonUS) {
    // ATS jobs with a location that didn't match non-US list: check for US indicators
    const usStates = [
      'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
      'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
      'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
      'minnesota','mississippi','missouri','montana','nebraska','nevada',
      'new hampshire','new jersey','new mexico','new york','north carolina',
      'north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
      'south carolina','south dakota','tennessee','texas','utah','vermont',
      'virginia','washington','west virginia','wisconsin','wyoming','district of columbia',
      // Abbreviations and common city names
      ', ca', ', tx', ', ny', ', wa', ', fl', ', il', ', ga', ', pa', ', oh', ', nc',
      'san francisco', 'new york', 'los angeles', 'chicago', 'seattle', 'austin',
      'boston', 'denver', 'atlanta', 'miami', 'dallas', 'houston', 'phoenix',
      'remote' // Remote-only with no country = assume US for ATS companies
    ];
    if (usStates.some(s => locationStr.includes(s))) {
      tags.push('us');
    }
    // If location exists but doesn't match US or non-US list, don't assume US
  }

  // Check for remote
  if (job.is_remote === true) {
    tags.push('remote');
  } else if (locationStr.includes('remote') && !isExplicitlyNonUS) {
    tags.push('remote');
  }

  // Check for on-site (not remote)
  if (job.is_remote === false && !tags.includes('remote')) {
    tags.push('on_site');
  }

  return tags;
}

/**
 * Tag experience level (mutually exclusive)
 */
function tagExperience(job) {
  const description = (job.description || '').toLowerCase();
  const title = (job.title || '').toLowerCase();

  // Look for experience keywords in title/description
  const noExpKeywords = ['no experience', '0 years', 'recent graduate', 'entry level', 'junior', 'associate'];
  if (noExpKeywords.some(kw => title.includes(kw) || description.includes(kw))) {
    return 'no_experience';
  }

  // Look for under 3 years
  const under3Keywords = ['1-3 years', 'under 3 years', '2 years', '0-2 years', 'early career'];
  if (under3Keywords.some(kw => description.includes(kw) || title.includes(kw))) {
    return 'under_3_years';
  }

  // Default to 3+ years
  return '3_plus_years';
}

/**
 * Tag special companies (multi-select)
 */
function tagSpecial(job) {
  const tags = [];
  const companyName = (job.company || '').toLowerCase();

  // FAANG companies
  const faangCompanies = [
    'facebook', 'meta', 'amazon', 'apple', 'netflix', 'google',
    'alphabet', 'microsoft', 'google', 'nvidia'
  ];
  if (faangCompanies.some(company => companyName.includes(company))) {
    tags.push('faang');
  }

  // Unicorn startups (approximate list)
  const unicornCompanies = [
    'stripe', 'plaid', 'databricks', 'snowflake', 'airbnb',
    'robinhood', 'doorash', 'instacart', 'coinbase', 'ribbit',
    'chime', 'rippling', 'epic', 'snowflake', 'plaid'
  ];
  if (unicornCompanies.some(company => companyName.includes(company))) {
    tags.push('unicorn');
  }

  // Fortune 500 (simplified - would need comprehensive list)
  const fortune500Companies = [
    'walmart', 'amazon', 'apple', 'cv health', 'unitedhealth',
    'mckesson', 'cardinal', 'exxon', 'at&t', 'costco'
  ];
  if (fortune500Companies.some(company => companyName.includes(company))) {
    tags.push('fortune500');
  }

  return tags;
}

/**
 * Generate tag statistics for a batch of jobs
 * @param {Array} jobs - Tagged jobs
 * @returns {Object} - Tag statistics
 */
function generateTagStats(jobs) {
  const stats = {
    employment: {},
    domains: {},
    locations: {},
    experience: {},
    special: {},
    total: jobs.length
  };

  jobs.forEach(job => {
    if (!job.tags) return;

    // Count employment tags (mutually exclusive)
    if (job.tags.employment) {
      stats.employment[job.tags.employment] = (stats.employment[job.tags.employment] || 0) + 1;
    }

    // Count domain tags (multi-select)
    if (job.tags.domains && Array.isArray(job.tags.domains)) {
      job.tags.domains.forEach(domain => {
        stats.domains[domain] = (stats.domains[domain] || 0) + 1;
      });
    }

    // Count location tags (multi-select)
    if (job.tags.locations && Array.isArray(job.tags.locations)) {
      job.tags.locations.forEach(location => {
        stats.locations[location] = (stats.locations[location] || 0) + 1;
      });
    }

    // Count experience tags (mutually exclusive)
    if (job.tags.experience) {
      stats.experience[job.tags.experience] = (stats.experience[job.tags.experience] || 0) + 1;
    }

    // Count special tags (multi-select)
    if (job.tags.special && Array.isArray(job.tags.special)) {
      job.tags.special.forEach(special => {
        stats.special[special] = (stats.special[special] || 0) + 1;
      });
    }
  });

  return stats;
}

module.exports = {
  tagJob,
  tagJobs,
  tagEmployment,
  tagDomains,
  tagLocations,
  tagExperience,
  tagSpecial,
  generateTagStats
};
