import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, parsePolicy } from '../src/config.js';

test('defaults are cautious: dry run, soft mode, 5 jobs, bots and schedules exempt', () => {
  const policy = parsePolicy({});
  assert.equal(policy.dryRun, true);
  assert.equal(policy.mode, 'soft');
  assert.equal(policy.defaultLimit, 5);
  assert.equal(policy.exemptBots, true);
  assert.equal(policy.explain, true);
  assert.deepEqual([...policy.exemptEvents], ['schedule']);
  assert.equal(policy.userLimits.size, 0);
});

test('parses per-person limits', () => {
  const policy = parsePolicy({ USER_LIMITS: 'Alice=10, renovate[bot]=2', DRY_RUN: 'false', MODE: 'HARD' });
  assert.equal(policy.userLimits.get('alice'), 10);
  assert.equal(policy.userLimits.get('renovate[bot]'), 2);
  assert.equal(policy.dryRun, false);
  assert.equal(policy.mode, 'hard');
});

test('rejects settings it cannot understand instead of guessing', () => {
  assert.throws(() => parsePolicy({ USER_LIMITS: 'alice' }), /login=limit/);
  assert.throws(() => parsePolicy({ USER_LIMITS: 'alice=two' }), /login=limit/);
  assert.throws(() => parsePolicy({ MODE: 'strict' }), /MODE/);
  assert.throws(() => parsePolicy({ DRY_RUN: 'maybe' }), /DRY_RUN/);
  assert.throws(() => parsePolicy({ MAX_JOBS_PER_USER: '-1' }), /MAX_JOBS_PER_USER/);
  assert.throws(() => parsePolicy({ MAX_JOBS_PER_USER: '2.5' }), /MAX_JOBS_PER_USER/);
});

test('an empty EXEMPT_EVENTS turns the schedule exemption off', () => {
  assert.equal(parsePolicy({ EXEMPT_EVENTS: '' }).exemptEvents.size, 0);
});

test('TARGET_WORKFLOWS narrows the app to the listed workflows', () => {
  assert.deepEqual(parsePolicy({}).targets, [], 'unset means every workflow');
  const { targets } = parsePolicy({
    TARGET_WORKFLOWS: 'acme/central/.github/workflows/build.yml, acme/central/.github/workflows/deploy-*.yml',
  });
  assert.deepEqual(
    targets.map((target) => target.pattern),
    ['acme/central/.github/workflows/build.yml', 'acme/central/.github/workflows/deploy-*.yml'],
  );
  assert.throws(() => parsePolicy({ TARGET_WORKFLOWS: 'build.yml' }), /TARGET_WORKFLOWS/);
});

test('the run log is on by default, and the admin endpoints need a long token', () => {
  const base = { GITHUB_APP_ID: '1', GITHUB_WEBHOOK_SECRET: 's', GITHUB_APP_PRIVATE_KEY: 'key' };
  assert.equal(loadConfig(base).runLogFile, 'runs.jsonl');
  assert.equal(loadConfig({ ...base, RUN_LOG_FILE: '/var/log/limiter/runs.jsonl' }).runLogFile, '/var/log/limiter/runs.jsonl');
  assert.equal(loadConfig({ ...base, RUN_LOG_FILE: '' }).runLogFile, null);
  assert.equal(loadConfig(base).adminToken, null);
  assert.throws(() => loadConfig({ ...base, ADMIN_TOKEN: 'short' }), /at least 16/);
  assert.equal(loadConfig({ ...base, ADMIN_TOKEN: 'a-long-enough-admin-token' }).adminToken, 'a-long-enough-admin-token');
});

test('loadConfig needs the app id, key and webhook secret', () => {
  assert.throws(() => loadConfig({}), /GITHUB_APP_ID/);
  assert.throws(() => loadConfig({ GITHUB_APP_ID: '1', GITHUB_WEBHOOK_SECRET: 's' }), /PRIVATE_KEY/);

  const config = loadConfig({
    GITHUB_APP_ID: '1',
    GITHUB_WEBHOOK_SECRET: 's',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN KEY-----\\nabc\\n-----END KEY-----',
    GITHUB_API_URL: 'https://ghe.example.com/api/v3/',
  });
  assert.equal(config.privateKey, '-----BEGIN KEY-----\nabc\n-----END KEY-----');
  assert.equal(config.apiUrl, 'https://ghe.example.com/api/v3');
  assert.equal(config.apiVersion, '2026-03-10');
  assert.equal(config.staleAfterMs, 900_000);
});
