#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const TECH_DOMAINS = new Set(['software', 'data_science', 'hardware', 'ai', 'finance']);
const DEFAULT_GROUPS = ['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'custom'];

function parseArgs(argv) {
  const args = { minAgeDays: 2, maxAgeDays: 4, perGroup: 8, groups: [...DEFAULT_GROUPS], writeDead: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--min-age-days') args.minAgeDays = Number(argv[++i]);
    else if (arg === '--max-age-days') args.maxAgeDays = Number(argv[++i]);
    else if (arg === '--per-group') args.perGroup = Number(argv[++i]);
    else if (arg === '--groups') args.groups = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--write-dead') args.writeDead = argv[++i];
  }
  return args;
}

async function loadJsonlFromR2(filename) {
  const client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  const resp = await client.send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: `data/${filename}`,
  }));
  const text = await resp.Body.transformToString();
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function ageDays(job) {
  return (Date.now() - new Date(job.posted_at || 0).getTime()) / 86400000;
}

function isConsumerVisible(job) {
  const domains = job.tags?.domains || [];
  const locations = job.tags?.locations || [];
  return locations.includes('us') && domains.some(d => TECH_DOMAINS.has(d));
}

function groupName(source) {
  return ['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters'].includes(source) ? source : 'custom';
}

function pickSample(arr, n) {
  const rows = [...arr].sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  if (rows.length <= n) return rows;
  const out = [];
  for (let i = 0; i < n; i++) out.push(rows[Math.floor(i * (rows.length - 1) / (n - 1))]);
  return out;
}

function checkUrl(url, redirects = 0) {
  return new Promise(resolve => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return resolve({ status: 'invalid_url', code: null, final_url: url });
    }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.request(parsed, {
      method: 'GET',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 ZJP-LinkHealth/1.0',
        'Accept': 'text/html,application/xhtml+xml',
      },
    }, res => {
      const code = res.statusCode;
      const loc = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(code) && loc && redirects < 5) {
        res.resume();
        return resolve(checkUrl(new URL(loc, parsed).toString(), redirects + 1));
      }
      res.resume();
      res.on('end', () => {
        const status = code >= 200 && code < 400 ? 'ok' : (code === 404 || code === 410 ? 'dead' : 'uncertain');
        resolve({ status, code, final_url: parsed.toString() });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'timeout', code: null, final_url: parsed.toString() });
    });
    req.on('error', err => resolve({ status: 'error', code: null, error: err.code || err.message, final_url: parsed.toString() }));
    req.end();
  });
}

(async function main() {
  const args = parseArgs(process.argv.slice(2));
  const jobs = await loadJsonlFromR2('all_jobs.json');
  const grouped = Object.fromEntries(args.groups.map(g => [g, []]));
  for (const job of jobs) {
    const group = groupName(job.source || 'unknown');
    if (!grouped[group]) continue;
    const age = ageDays(job);
    if (age < args.minAgeDays || age >= args.maxAgeDays) continue;
    if (!job.url || !isConsumerVisible(job)) continue;
    grouped[group].push(job);
  }
  const samples = [];
  for (const group of args.groups) {
    for (const job of pickSample(grouped[group], args.perGroup)) {
      samples.push({
        group,
        id: job.id,
        source: job.source,
        company_name: job.company_name,
        title: job.title,
        posted_at: job.posted_at,
        url: job.url,
      });
    }
  }
  const results = [];
  for (const item of samples) {
    results.push({ ...item, ...(await checkUrl(item.url)) });
  }
  const summary = {};
  let deadTotal = 0;
  for (const group of args.groups) {
    const arr = results.filter(r => r.group === group);
    summary[group] = {
      candidates: grouped[group].length,
      checked: arr.length,
      dead: arr.filter(r => r.status === 'dead').length,
      uncertain: arr.filter(r => !['ok', 'dead'].includes(r.status)).length,
    };
    deadTotal += summary[group].dead;
  }
  const checkedAt = new Date().toISOString();
  const output = {
    checked_at: checkedAt,
    sample_window: { minAgeDays: args.minAgeDays, maxAgeDays: args.maxAgeDays },
    per_group: args.perGroup,
    summary,
    results,
  };
  console.log(JSON.stringify(output, null, 2));
  if (args.writeDead) {
    const dead = results.filter(r => r.status === 'dead').map(r => ({
      id: r.id,
      source: r.source,
      company_name: r.company_name,
      title: r.title,
      url: r.url,
      checked_at: checkedAt,
      group: r.group,
    }));
    fs.writeFileSync(args.writeDead, JSON.stringify({ checked_at: checkedAt, dead }, null, 2) + '\n');
  }
  if (deadTotal > 0) process.exit(1);
})();
