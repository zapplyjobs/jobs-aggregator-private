#!/usr/bin/env node
/**
 * generate-and-push-readmes.js — Centralized README generation + push.
 *
 * Runs at the END of the pipeline (after all data is processed + uploaded to R2).
 * For each board config in configs/, generates the README + pushes it directly
 * to the consumer repo. Consumer repos become pure display (no logic needed).
 *
 * Phase 2 of the consumer architecture improvement.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createReadmeGenerator } = require(path.join(__dirname, 'consumer/lib/readme-generator'));

const CONFIGS_DIR = path.join(process.cwd(), 'configs');
const DATA_DIR = path.join(process.cwd(), '.github', 'data');
const TEMP_DIR = path.join(process.cwd(), '.github', 'data', 'readme-temp');

// --- Helpers ---

function loadConfigs() {
  return fs.readdirSync(CONFIGS_DIR)
    .filter(f => f.endsWith('.json') && f !== '_index.json')
    .map(f => ({ ...JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, f), 'utf8')), _file: f }))
    .sort((a, b) => (a.repo || '').localeCompare(b.repo || ''));
}

function parseNdjson(text) {
  return text.trim().split(/\n+/).filter(Boolean).map(line => JSON.parse(line));
}

function loadJobsForBoard(config) {
  if (config.feedKey) {
    // Canada pattern: read the specific R2 feed file
    const feedPath = path.join(DATA_DIR, config.feedKey);
    if (fs.existsSync(feedPath)) {
      const raw = fs.readFileSync(feedPath, 'utf8');
      return parseNdjson(raw);
    }
    console.warn(`  ⚠️ Feed not found locally: ${config.feedKey}`);
    return [];
  }

  // US pattern: filter all_jobs using config.filters
  const allJobsPath = path.join(DATA_DIR, 'all_jobs.json');
  if (!fs.existsSync(allJobsPath)) {
    console.warn('  ⚠️ all_jobs.json not found');
    return [];
  }
  const allJobsRaw = fs.readFileSync(allJobsPath, 'utf8').trim();
  let allJobs;
  try { allJobs = JSON.parse(allJobsRaw); }
  catch { allJobs = allJobsRaw.split(/\n+/).filter(Boolean).map(l => JSON.parse(l)); }
  return filterJobs(allJobs, config.filters || {});
}

function filterJobs(jobs, filters) {
  return jobs.filter(job => {
    // Location filter
    if (filters.locations && filters.locations.length > 0) {
      const jobLocations = job.tags?.locations || [];
      const hasLocation = filters.locations.some(loc => jobLocations.includes(loc));
      if (!hasLocation) return false;
    }
    // Employment filter
    if (filters.employment) {
      if (job.tags?.employment !== filters.employment) return false;
    }
    // Domain filter
    if (filters.domains && filters.domains.length > 0) {
      const jobDomains = job.tags?.domains || [];
      const hasDomain = filters.domains.some(d => jobDomains.includes(d));
      if (!hasDomain) return false;
    }
    return true;
  });
}

function normalizeJob(row) {
  return {
    ...row,
    employer_name: row.company_name || row.employer_name || 'Unknown',
    job_title: row.title || row.job_title || '',
    job_location: row.location || row.job_location || '',
    job_posted_at: row.posted_at || row.job_posted_at_datetime_utc || row.job_posted_at || null,
    job_apply_link: row.apply_url || row.job_apply_link || row.url || '#',
  };
}

function pushReadme(repo, readmeContent) {
  const content = Buffer.from(readmeContent).toString('base64');
  // Get current file SHA (needed for update)
  let sha;
  try {
    sha = execSync(`gh api repos/zapplyjobs/${repo}/contents/README.md --jq '.sha'`, { encoding: 'utf8' }).trim();
  } catch (e) {
    throw new Error(`Failed to get README SHA for ${repo}: ${e.message}`);
  }
  // Write request body to file (avoids command-line argument length limits for large READMEs)
  const body = JSON.stringify({
    message: 'auto: regenerate README from pipeline (centralized)',
    content: content,
    sha: sha,
    branch: 'main'
  });
  const bodyFile = path.join(TEMP_DIR, 'push-body.json');
  fs.writeFileSync(bodyFile, body);
  // Push via --input (reads body from file, not command-line args)
  execSync(
    `gh api repos/zapplyjobs/${repo}/contents/README.md -X PUT --input ${bodyFile}`,
    { encoding: 'utf8', stdio: 'pipe' }
  );
}

// --- Main ---


function sendDiscordAlert(repo, reason) {
  const token = process.env.DISCORD_TEAM_TOKEN;
  const channel = process.env.DISCORD_PIPELINE_ALERT_CHANNEL_ID;
  if (!token || !channel) { console.log('  (Discord alert skipped — secrets not set)'); return; }
  const https = require('https');
  const body = JSON.stringify({
    embeds: [{ title: '⚠️ Consumer Board Alert', color: 0xe74c3c,
      description: '**' + repo + '**: ' + reason, footer: { text: new Date().toISOString() } }]
  });
  const req = https.request({
    hostname: 'discord.com', path: '/api/channels/' + channel + '/messages', method: 'POST',
    headers: { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, res => { console.log('  Discord alert: ' + res.statusCode); });
  req.on('error', e => console.error('  Discord alert failed: ' + e.message));
  req.setTimeout(5000, () => { req.destroy(); });
  req.write(body); req.end();
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  Generate + Push Consumer Board READMEs');
  console.log('═══════════════════════════════════════════\n');

  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const configs = loadConfigs();
  console.log(`Found ${configs.length} board configs\n`);

  let ok = 0, fail = 0;
  const boardCounts = [];
  const failedRepos = [];

  // Load previous counts for drop detection
  const prevCountsPath = path.join(DATA_DIR, 'board-counts.json');
  let prevCounts = {};
  if (fs.existsSync(prevCountsPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(prevCountsPath, 'utf8'));
      prevCounts = Object.fromEntries(prev.map(p => [p.repo, p.count]));
      console.log(`Loaded ${Object.keys(prevCounts).length} previous counts for drop detection\n`);
    } catch { console.log('Could not parse previous counts — starting fresh\n'); }
  }

  for (const config of configs) {
    const repo = config.repo || config._file;
    console.log(`▶ ${repo}:`);

    try {
      // 1. Load jobs for this board
      const rawJobs = loadJobsForBoard(config);
      const jobs = rawJobs.map(normalizeJob);
      console.log(`  Jobs: ${jobs.length}`);

      if (jobs.length === 0) {
        console.log(`  ⚠️ No jobs — skipping (board would be empty)`);
        continue;
      }

      // 2. Build stats
      const stats = { totalByCompany: {} };
      jobs.forEach(job => {
        const name = job.employer_name || 'Unknown';
        stats.totalByCompany[name] = (stats.totalByCompany[name] || 0) + 1;
      });

      // 3. Generate README using the shared library
      const boardTempDir = path.join(TEMP_DIR, config._file.replace('.json', ''));
      fs.mkdirSync(boardTempDir, { recursive: true });

      const categories = config.categories || {};
      const generator = createReadmeGenerator(config, categories, boardTempDir);
      await generator.updateReadme(jobs, [], null, stats);

      // 4. Read the generated README
      const readmePath = path.join(boardTempDir, 'README.md');
      if (!fs.existsSync(readmePath)) {
        throw new Error('readme-generator did not produce README.md');
      }
      const readmeContent = fs.readFileSync(readmePath, 'utf8');

      // 5. Push to consumer repo
      pushReadme(repo, readmeContent);
      console.log(`  ✅ Pushed README (${jobs.length} jobs, ${Object.keys(stats.totalByCompany).length} companies)`);
      ok++;
      boardCounts.push({ repo, count: jobs.length, companies: Object.keys(stats.totalByCompany).length, timestamp: new Date().toISOString() });
      // Count-drop detection (replaces per-repo alerts)
      const prev = prevCounts[repo];
      if (prev !== undefined) {
        if (jobs.length === 0) {
          console.warn(`  🚨 COUNT ZERO: ${repo} has 0 jobs (was ${prev})`);
          sendDiscordAlert(repo, `Job count hit 0 (was ${prev})`);
        } else if (jobs.length < prev * 0.5) {
          const dropPct = Math.round((1 - jobs.length / prev) * 100);
          console.warn(`  🚨 COUNT DROP: ${repo} dropped ${dropPct}% (${prev} → ${jobs.length})`);
          sendDiscordAlert(repo, `Job count dropped ${dropPct}% (${prev} → ${jobs.length})`);
        }
      }

    } catch (error) {
      console.error(`  ❌ ${error.message}`);
      fail++;
      failedRepos.push(repo);
    }
  }

  console.log(`\n${'═'.repeat(43)}`);
  console.log(`  Done: ${ok} succeeded, ${fail} failed`);
  if (fail > 0) {
    console.warn(`  ⚠️ Failed boards: ${failedRepos.join(', ')}`);
    sendDiscordAlert('pipeline-push', `${fail}/${ok + fail} boards failed to push: ${failedRepos.join(', ')}`);
  }

  // Write board counts for monitoring (consumer_count_zero_health will read from R2)
  const countsPath = path.join(DATA_DIR, 'board-counts.json');
  fs.writeFileSync(countsPath, JSON.stringify(boardCounts, null, 2));
  console.log(`\n📊 Board counts written to ${path.relative(process.cwd(), countsPath)}`);

  // Clean up temp
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });

  if (fail > 0) process.exitCode = 1;
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
