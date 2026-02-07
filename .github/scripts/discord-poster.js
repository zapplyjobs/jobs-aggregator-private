#!/usr/bin/env node

/**
 * Discord Poster - Aggregator Script
 *
 * Fetches jobs from all repos and posts to Discord
 * Implements global deduplication across repos
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Import modules
const Router = require('./src/routing/router');
const Location = require('./src/routing/location');
const PostedJobsManager = require('./src/data/posted-jobs-manager-v2');
const GlobalDedupeManager = require('./src/data/global-dedupe-manager');
const { LOCATION_CHANNEL_CONFIG, CHANNEL_CONFIG } = require('./src/discord/config');

// GitHub token for API requests
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// Repositories to fetch jobs from
const REPOS = [
  { owner: 'zapplyjobs', repo: 'New-Grad-Jobs-2026', name: 'New-Grad' },
  { owner: 'zapplyjobs', repo: 'Internships-2026', name: 'Internships' }
];

// Data directory
const DATA_DIR = path.join(process.cwd(), '.github', 'data');

/**
 * Fetch file content from GitHub API
 */
function fetchGitHubFile(owner, repo, filePath) {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;

    https.get(url, {
      headers: {
        'User-Agent': 'Zapply-Aggregator',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.content) {
            resolve(Buffer.from(json.content, 'base64').toString('utf8'));
          } else {
            resolve(null);
          }
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Format job location for display
 */
function formatLocation(job) {
  const city = job.job_city || '';
  const state = job.job_state || '';
  const isRemote = job.job_is_remote || false;

  if (isRemote) {
    return 'Remote';
  }

  if (city && state) {
    return `${city}, ${state}`;
  } else if (city) {
    return city;
  } else if (state) {
    return state;
  }

  return 'Not specified';
}

/**
 * Generate minimal job fingerprint for deduplication
 */
function generateMinimalJobFingerprint(job) {
  const crypto = require('crypto');

  // Use URL as primary key (most unique identifier)
  const url = job.job_apply_link || job.job_google_link || job.url || '';
  const title = (job.job_title || '').toLowerCase().trim();
  const company = (job.employer_name || '').toLowerCase().trim();

  // Create fingerprint from URL + title + company
  const fingerprintData = `${url}|${title}|${company}`;
  return crypto.createHash('sha256').update(fingerprintData).digest('hex');
}

/**
 * Post single job to Discord channel
 */
async function postJobToDiscord(job, channelId, discordClient) {
  const channel = await discordClient.channels.fetch(channelId);
  if (!channel) {
    throw new Error(`Channel not found: ${channelId}`);
  }

  // Format job for Discord
  const location = formatLocation(job);
  const salary = job.job_min_salary || job.job_max_salary
    ? `$${job.job_min_salary || 0} - $${job.job_max_salary || 0}`
    : 'Not specified';

  const embed = {
    title: job.job_title || 'Untitled Position',
    url: job.job_apply_link || job.job_google_link || '#',
    color: 0x00D26A, // Zapply green
    fields: [
      {
        name: 'Company',
        value: job.employer_name || 'Unknown',
        inline: true
      },
      {
        name: 'Location',
        value: location,
        inline: true
      },
      {
        name: 'Type',
        value: job.job_job_type || 'Not specified',
        inline: true
      }
    ],
    footer: {
      text: `${job._sourceRepo || 'Unknown'} • Posted: ${new Date(job.job_posted_at_datetime_utc || Date.now()).toLocaleDateString()}`
    }
  };

  // Add salary if available
  if (salary !== 'Not specified') {
    embed.fields.push({
      name: 'Salary',
      value: salary,
      inline: true
    });
  }

  const message = await channel.send({ embeds: [embed] });
  return message;
}

/**
 * Main execution
 */
async function main() {
  console.log('🚀 Aggregator Discord Poster - Starting...');

  // Initialize Discord client
  const { Client, GatewayIntentBits } = require('discord.js');
  const discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages
    ]
  });

  await discordClient.login(DISCORD_TOKEN);
  console.log('✅ Discord client connected');

  // Initialize managers
  const postedJobsManager = new PostedJobsManager();
  const globalDedupeManager = new GlobalDedupeManager();

  // Fetch jobs from all repos
  console.log('\n📡 Fetching jobs from repos...');
  const allJobs = [];

  for (const repo of REPOS) {
    console.log(`  📥 ${repo.name}...`);

    try {
      const jobsData = await fetchGitHubFile(repo.owner, repo.repo, '.github/data/current_jobs.json');

      if (jobsData) {
        const jobs = JSON.parse(jobsData);
        // Add source repo to each job
        jobs.forEach(job => {
          job._sourceRepo = repo.name;
        });
        allJobs.push(...jobs);
        console.log(`    ✅ Got ${jobs.length} jobs`);
      } else {
        console.log(`    ⚠️  No current_jobs.json found`);
      }
    } catch (error) {
      console.error(`    ❌ Error: ${error.message}`);
    }
  }

  console.log(`\n📊 Total jobs fetched: ${allJobs.length}`);

  // Global deduplication (in-memory for current batch)
  console.log('\n🔄 Deduplicating jobs within batch...');
  const seenFingerprints = new Set();
  const uniqueJobs = allJobs.filter(job => {
    const fingerprint = generateMinimalJobFingerprint(job);
    if (seenFingerprints.has(fingerprint)) {
      console.log(`  ⏭️  Skipping batch duplicate: ${job.job_title} @ ${job.employer_name}`);
      return false;
    }
    seenFingerprints.add(fingerprint);
    return true;
  });

  console.log(`✅ After batch deduplication: ${uniqueJobs.length} jobs`);

  // Get channels from environment
  const channels = {
    // New-Grad channels
    tech: process.env.DISCORD_TECH_CHANNEL_ID,
    ai: process.env.DISCORD_AI_CHANNEL_ID,
    ds: process.env.DISCORD_DS_CHANNEL_ID,
    finance: process.env.DISCORD_FINANCE_CHANNEL_ID,
    bayArea: process.env.DISCORD_BAY_AREA_CHANNEL_ID,
    ny: process.env.DISCORD_NY_CHANNEL_ID,
    pnw: process.env.DISCORD_PNW_CHANNEL_ID,
    remoteUsa: process.env.DISCORD_REMOTE_USA_CHANNEL_ID,
    otherUsa: process.env.DISCORD_OTHER_USA_CHANNEL_ID,

    // Internships channels
    sales: process.env.DISCORD_SALES_CHANNEL_ID,
    marketing: process.env.DISCORD_MARKETING_CHANNEL_ID,
    other: process.env.DISCORD_OTHER_CHANNEL_ID,
    bayAreaInt: process.env.DISCORD_BAY_AREA_INT_CHANNEL_ID,
    socalInt: process.env.DISCORD_SOCAL_INT_CHANNEL_ID
  };

  // Post jobs
  console.log('\n📤 Posting jobs to Discord...');
  let postedCount = 0;
  let skippedCount = 0;

  for (const job of uniqueJobs) {
    try {
      // Generate fingerprint for this job
      const fingerprint = generateMinimalJobFingerprint(job);

      // Check if already posted globally (across all runs, 14-day TTL)
      if (globalDedupeManager.hasBeenPosted(fingerprint)) {
        console.log(`  ⏭️  Skipping (already posted globally): ${job.job_title} @ ${job.employer_name}`);
        skippedCount++;
        continue;
      }

      // Check if already posted locally (this run's database)
      if (postedJobsManager.hasBeenPosted(job)) {
        skippedCount++;
        continue;
      }

      // Route job to channels (get both industry and location channels)
      const industryRouting = Router.getJobChannelDetails(job, CHANNEL_CONFIG);
      const locationChannelId = Location.getJobLocationChannel(job);

      const channelsToPost = [];

      // Add industry channel
      if (industryRouting && industryRouting.channelId) {
        channelsToPost.push({
          channelId: industryRouting.channelId,
          category: industryRouting.category,
          type: 'industry'
        });
      }

      // Add location channel (if applicable)
      if (locationChannelId) {
        channelsToPost.push({
          channelId: locationChannelId,
          category: industryRouting?.category || 'tech',
          type: 'location'
        });
      }

      // Post to each channel
      for (const channelInfo of channelsToPost) {
        const envVarName = Object.keys(process.env).find(key => process.env[key] === channelInfo.channelId);

        if (!envVarName) {
          console.log(`  ⚠️  Channel ID ${channelInfo.channelId} not found in environment`);
          continue;
        }

        const message = await postJobToDiscord(job, channelInfo.channelId, discordClient);

        // Track posting in local manager
        postedJobsManager.markAsPostedToChannel(
          job,
          message.id,
          channelInfo.channelId,
          channelInfo.category
        );

        // Track posting in global dedupe store
        const fingerprint = generateMinimalJobFingerprint(job);
        globalDedupeManager.markAsPosted(
          fingerprint,
          job.job_id || job.id,
          job._sourceRepo,
          channelInfo.channelId,
          message.id
        );
      }

      postedCount++;
      console.log(`  ✅ Posted: ${job.job_title} @ ${job.employer_name}`);
    } catch (error) {
      console.error(`  ❌ Error posting ${job.job_title}: ${error.message}`);
    }
  }

  console.log(`\n📊 Posting Summary:`);
  console.log(`  ✅ Posted: ${postedCount} jobs`);
  console.log(`  ⏭️  Skipped (already posted): ${skippedCount} jobs`);

  // Save databases
  console.log('\n💾 Saving databases...');
  postedJobsManager.savePostedJobs();
  globalDedupeManager.saveStore();
  console.log('✅ Databases saved');

  // Logout
  await discordClient.destroy();

  console.log('\n✅ Aggregator run complete!');
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error.message);
  console.error(error.stack);
  process.exit(1);
});
