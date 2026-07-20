#!/usr/bin/env node
'use strict';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function truncate(text, max = 1000) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function classifyDispatchFailure(status) {
  if (status === 429) return { retryable: true, className: 'rate_limited' };
  if (status >= 500 && status <= 599) return { retryable: true, className: 'github_transient' };
  if (status === 401 || status === 403) return { retryable: false, className: 'auth' };
  if (status === 404) return { retryable: false, className: 'not_found' };
  if (status === 422) return { retryable: false, className: 'invalid_dispatch' };
  if (status >= 400 && status <= 499) return { retryable: false, className: 'client' };
  return { retryable: false, className: 'unexpected' };
}

function retryDelayMs(response, baseDelayMs, attempt) {
  const header = response?.headers?.get?.('retry-after');
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 10000);
  }
  return Math.min(baseDelayMs * (2 ** (attempt - 1)), 10000);
}

async function dispatchWorkflow(options) {
  const {
    token,
    owner = 'zapplyjobs',
    repo,
    workflow,
    ref = 'main',
    maxAttempts = 3,
    baseDelayMs = 1000,
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    log = console.log,
    warn = console.warn,
    error = console.error,
  } = options;

  if (!token) throw new Error('GH_PAT is required for workflow dispatch');
  if (!repo) throw new Error('DISPATCH_REPO is required');
  if (!workflow) throw new Error('DISPATCH_WORKFLOW is required');
  if (!fetchImpl) throw new Error('fetch is not available in this Node runtime');

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
  let lastFailure = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    let body = '';
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref }),
      });
      body = response.status === 204 ? '' : await response.text();
    } catch (err) {
      lastFailure = `network ${err?.message || err}`;
      if (attempt === maxAttempts) {
        error(`Workflow dispatch FAILED: ${owner}/${repo}/${workflow} attempt=${attempt}/${maxAttempts} class=network message=${err?.message || err}`);
        return false;
      }
      warn(`Workflow dispatch retry ${attempt}/${maxAttempts - 1}: ${owner}/${repo}/${workflow} — network ${err?.message || err}`);
      await sleepImpl(Math.min(baseDelayMs * (2 ** (attempt - 1)), 10000));
      continue;
    }

    if (response.status === 204) {
      log(`Workflow dispatch OK: ${owner}/${repo}/${workflow} ref=${ref} attempt=${attempt}/${maxAttempts}`);
      return true;
    }

    const classification = classifyDispatchFailure(response.status);
    lastFailure = `status=${response.status} class=${classification.className} body=${truncate(body)}`;
    if (!classification.retryable || attempt === maxAttempts) {
      error(`Workflow dispatch FAILED: ${owner}/${repo}/${workflow} attempt=${attempt}/${maxAttempts} ${lastFailure}`);
      return false;
    }

    warn(`Workflow dispatch retry ${attempt}/${maxAttempts - 1}: ${owner}/${repo}/${workflow} — ${lastFailure}`);
    await sleepImpl(retryDelayMs(response, baseDelayMs, attempt));
  }

  error(`Workflow dispatch FAILED: ${owner}/${repo}/${workflow} ${lastFailure || 'unknown failure'}`);
  return false;
}

async function main() {
  const ok = await dispatchWorkflow({
    token: process.env.GH_PAT,
    owner: process.env.DISPATCH_OWNER || 'zapplyjobs',
    repo: process.env.DISPATCH_REPO,
    workflow: process.env.DISPATCH_WORKFLOW,
    ref: process.env.DISPATCH_REF || 'main',
    maxAttempts: parsePositiveInt(process.env.DISPATCH_MAX_ATTEMPTS, 3),
    baseDelayMs: parsePositiveInt(process.env.DISPATCH_RETRY_DELAY_MS, 1000),
  });
  if (!ok) process.exit(1);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`Workflow dispatch fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  classifyDispatchFailure,
  dispatchWorkflow,
  retryDelayMs,
};
