#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { classifyDispatchFailure, dispatchWorkflow, retryDelayMs } = require('../dispatch-workflow');

function response(status, body = '', headers = {}) {
  return {
    status,
    headers: { get: name => headers[name.toLowerCase()] || null },
    async text() { return body; },
  };
}

function fakeFetch(steps) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    const step = steps.shift();
    if (!step) return response(204);
    if (step.throw) throw step.throw;
    return step.response;
  };
  fn.calls = calls;
  return fn;
}

const base = {
  token: 'token',
  repo: 'jobs-data-2026',
  workflow: 'refresh-zjp-public-snapshot.yml',
  ref: 'main',
  baseDelayMs: 1,
  sleepImpl: async () => {},
  log: () => {},
  warn: () => {},
  error: () => {},
};

(async () => {
  assert.deepStrictEqual(classifyDispatchFailure(500), { retryable: true, className: 'github_transient' });
  assert.deepStrictEqual(classifyDispatchFailure(429), { retryable: true, className: 'rate_limited' });
  assert.deepStrictEqual(classifyDispatchFailure(401), { retryable: false, className: 'auth' });
  assert.deepStrictEqual(classifyDispatchFailure(422), { retryable: false, className: 'invalid_dispatch' });
  assert.strictEqual(retryDelayMs(response(429, '', { 'retry-after': '2' }), 1000, 1), 2000);

  {
    const fetchImpl = fakeFetch([{ response: response(204) }]);
    const ok = await dispatchWorkflow({ ...base, fetchImpl });
    assert.strictEqual(ok, true, '204 dispatch should succeed');
    assert.strictEqual(fetchImpl.calls.length, 1);
    assert.strictEqual(fetchImpl.calls[0].url, 'https://api.github.com/repos/zapplyjobs/jobs-data-2026/actions/workflows/refresh-zjp-public-snapshot.yml/dispatches');
    assert.strictEqual(JSON.parse(fetchImpl.calls[0].options.body).ref, 'main');
  }

  {
    const fetchImpl = fakeFetch([
      { response: response(500, '{"message":"internal"}') },
      { response: response(204) },
    ]);
    const ok = await dispatchWorkflow({ ...base, fetchImpl, maxAttempts: 3 });
    assert.strictEqual(ok, true, '500 should retry and then succeed');
    assert.strictEqual(fetchImpl.calls.length, 2);
  }

  {
    const fetchImpl = fakeFetch([
      { response: response(401, '{"message":"Requires authentication"}') },
    ]);
    const ok = await dispatchWorkflow({ ...base, fetchImpl, maxAttempts: 3 });
    assert.strictEqual(ok, false, '401 should fail loud without retry');
    assert.strictEqual(fetchImpl.calls.length, 1);
  }

  {
    const fetchImpl = fakeFetch([
      { throw: new Error('socket hang up') },
      { response: response(204) },
    ]);
    const ok = await dispatchWorkflow({ ...base, fetchImpl, maxAttempts: 2 });
    assert.strictEqual(ok, true, 'network failure should retry');
    assert.strictEqual(fetchImpl.calls.length, 2);
  }

  {
    const fetchImpl = fakeFetch([
      { response: response(500, '{"message":"internal"}') },
      { response: response(502, '{"message":"bad gateway"}') },
    ]);
    const ok = await dispatchWorkflow({ ...base, fetchImpl, maxAttempts: 2 });
    assert.strictEqual(ok, false, 'exhausted transient retries should fail loud');
    assert.strictEqual(fetchImpl.calls.length, 2);
  }

  await assert.rejects(
    () => dispatchWorkflow({ ...base, token: '', fetchImpl: fakeFetch([]) }),
    /GH_PAT is required/,
    'missing token should be a fatal config error'
  );

  console.log('PASS dispatch-workflow behavior');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
