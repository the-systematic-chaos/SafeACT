import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import http from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { parsePolicy } from '../src/config.js';
import { GitHubApp } from '../src/github.js';
import { Limiter } from '../src/limiter.js';
import { RunLog } from '../src/runlog.js';
import { createServer, verifySignature } from '../src/server.js';
import { MemoryStore } from '../src/store.js';
import { CENTRAL, jobEvent, recordingLog, tempDir } from './helpers.js';

const SECRET = 'test-webhook-secret';
const APP_ID = '12345';
const ADMIN_TOKEN = 'admin-token-that-is-long-enough';

const sign = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('signature check accepts only the exact HMAC', () => {
  const body = Buffer.from('{"action":"queued"}');
  const good = sign('s3cret', body);
  const tampered = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0');
  assert.equal(verifySignature('s3cret', body, good), true);
  assert.equal(verifySignature('s3cret', body, tampered), false);
  assert.equal(verifySignature('other', body, good), false);
  assert.equal(verifySignature('s3cret', body, undefined), false);
});

/**
 * A stand-in for api.github.com that checks the app JWT and the installation token.
 * Runs 100 and 101 call the central workflow from acme/web; run 102 is some other workflow.
 */
function mockGitHub(publicKey) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const call = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    calls.push(call);
    const reply = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (req.headers['x-github-api-version'] !== '2026-03-10') return reply(400, { message: 'no API version' });

    if (req.method === 'POST' && req.url === '/app/installations/42/access_tokens') {
      const [header, payload, signature] = (req.headers.authorization ?? '').replace(/^Bearer /, '').split('.');
      const valid =
        signature &&
        verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'));
      const claims = valid ? JSON.parse(Buffer.from(payload, 'base64url')) : {};
      if (!valid || claims.iss !== APP_ID || claims.exp * 1000 <= Date.now()) return reply(401, { message: 'bad JWT' });
      return reply(201, { token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }

    if (req.headers.authorization !== 'Bearer ghs_test') return reply(401, { message: 'Bad credentials' });
    let match;
    if (req.method === 'GET' && (match = req.url.match(/^\/repos\/acme\/web\/actions\/runs\/(\d+)\/attempts\/(\d+)$/))) {
      const id = Number(match[1]);
      const callsCentral = id !== 102;
      return reply(200, {
        id,
        name: callsCentral ? 'PR checks' : 'Lint',
        run_attempt: Number(match[2]),
        event: 'pull_request',
        path: callsCentral ? '.github/workflows/pr.yml@feature-x' : '.github/workflows/lint.yml@feature-x',
        head_branch: 'feature-x',
        head_sha: 'abc123',
        display_title: 'Add search',
        html_url: `https://github.com/acme/web/actions/runs/${id}`,
        created_at: '2026-10-29T17:00:00Z',
        run_started_at: '2026-10-29T17:00:00Z',
        triggering_actor: { login: 'alice', type: 'User' },
        actor: { login: 'alice', type: 'User' },
        head_repository: { full_name: 'acme/web' },
        pull_requests: [{ number: 7, head: { ref: 'feature-x' }, base: { ref: 'main' } }],
        referenced_workflows: callsCentral ? [{ path: `${CENTRAL}@main`, sha: 'def456', ref: 'refs/heads/main' }] : [],
      });
    }
    if (req.method === 'POST' && /^\/repos\/acme\/web\/actions\/runs\/\d+\/cancel$/.test(req.url)) return reply(202, {});
    if (req.method === 'POST' && req.url === '/repos/acme/web/check-runs') return reply(201, { id: 1 });
    return reply(404, { message: 'Not Found' });
  });
  return { server, calls };
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the condition');
}

test('end to end: only the central workflow is limited, and the log shows who, where and when', async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const api = mockGitHub(publicKey);
  const apiUrl = await listen(api.server);

  const runLogFile = join(tempDir(t), 'runs.jsonl');
  const store = new MemoryStore();
  const policy = parsePolicy({ MAX_JOBS_PER_USER: '1', DRY_RUN: 'false', TARGET_WORKFLOWS: CENTRAL });
  const github = new GitHubApp({
    appId: APP_ID,
    privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    apiUrl,
    apiVersion: '2026-03-10',
  });
  const log = recordingLog();
  const runLog = new RunLog({ file: runLogFile, log });
  const limiter = new Limiter({ policy, store, github, runLog, log });
  const app = createServer({ webhookSecret: SECRET, limiter, store, policy, log, runLogFile, adminToken: ADMIN_TOKEN });
  const url = await listen(app);
  t.after(() => {
    app.close();
    api.server.close();
  });

  const deliver = (payload, secret = SECRET, event = 'workflow_job') => {
    const body = JSON.stringify(payload);
    return fetch(`${url}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': crypto.randomUUID(),
        'x-hub-signature-256': sign(secret, body),
      },
      body,
    });
  };
  const admin = (path, token = ADMIN_TOKEN) =>
    fetch(`${url}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  // Deliveries without the right signature never reach the limiter.
  assert.equal((await fetch(`${url}/webhook`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await deliver(jobEvent('queued', { job: 1, run: 100 }), 'wrong-secret')).status, 401);
  assert.equal(api.calls.length, 0);

  // A run of some other workflow is looked up once, then ignored.
  assert.equal((await deliver(jobEvent('queued', { job: 3, run: 102 }))).status, 202);
  await waitFor(() => store.getRun('102:1')?.info);
  await tick();
  assert.equal(store.activeCount('acme/alice'), 0);

  // alice's first central run fits under her limit of 1...
  assert.equal((await deliver(jobEvent('queued', { job: 1, run: 100 }))).status, 202);
  await waitFor(() => store.activeCount('acme/alice') === 1);

  // ...her second one doesn't.
  assert.equal((await deliver(jobEvent('queued', { job: 2, run: 101 }))).status, 202);
  const cancel = await waitFor(() => api.calls.find((call) => call.url === '/repos/acme/web/actions/runs/101/cancel'));
  assert.equal(cancel.method, 'POST');
  const check = await waitFor(() => api.calls.find((call) => call.url === '/repos/acme/web/check-runs'));
  assert.equal(check.body.name, 'Job limit: CI');
  assert.equal(check.body.head_sha, 'abc123');
  assert.equal(api.calls.filter((call) => call.url.endsWith('/access_tokens')).length, 1, 'token is cached');
  assert.ok(!api.calls.some((call) => /\/runs\/10[02]\/cancel/.test(call.url)));

  // The log needs the admin token.
  assert.equal((await admin('/runs', null)).status, 401);
  assert.equal((await admin('/runs', 'wrong-token-that-is-long-enough')).status, 401);
  assert.equal((await admin('/runs?since=yesterday-ish')).status, 400);

  const { count, runs } = await (await admin('/runs')).json();
  assert.equal(count, 2, 'the other workflow is not in the log');
  const byRun = Object.fromEntries(runs.map((row) => [row.runId, row]));
  for (const id of [100, 101]) {
    assert.equal(byRun[id].user, 'alice');
    assert.equal(byRun[id].repo, 'acme/web');
    assert.equal(byRun[id].branch, 'feature-x');
    assert.deepEqual(byRun[id].baseBranches, ['main']);
    assert.deepEqual(byRun[id].prs, [7]);
    assert.equal(byRun[id].requestedAt, '2026-10-29T17:00:00Z');
    assert.equal(byRun[id].calledWorkflow, `${CENTRAL}@main`);
  }
  assert.equal(byRun[100].decision, 'admitted');
  assert.equal(byRun[101].decision, 'cancelled');

  const csv = await admin('/runs?format=csv&user=alice&decision=cancelled');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  const [header, line, extra] = (await csv.text()).trimEnd().split('\n');
  assert.ok(header.startsWith('requestedAt,user,actor,repo,branch'));
  assert.ok(line.startsWith('2026-10-29T17:00:00Z,alice,alice,acme/web,feature-x,main,7,pull_request'));
  assert.equal(extra, undefined);

  assert.deepEqual(await (await admin('/active')).json(), {
    users: [{ org: 'acme', user: 'alice', active: 1, limit: 1 }],
  });

  const health = await (await fetch(`${url}/healthz`)).json();
  assert.deepEqual(
    { ok: health.ok, dryRun: health.dryRun, trackedJobs: health.trackedJobs, targets: health.targets },
    { ok: true, dryRun: false, trackedJobs: 1, targets: [CENTRAL] },
  );
  assert.ok(!log.entries.some((entry) => entry.level === 'error'));
});

test('without ADMIN_TOKEN the log endpoints are off', async (t) => {
  const store = new MemoryStore();
  const policy = parsePolicy({});
  const limiter = new Limiter({ policy, store, github: {}, log: recordingLog() });
  const app = createServer({ webhookSecret: SECRET, limiter, store, policy, log: recordingLog(), runLogFile: 'x.jsonl' });
  const url = await listen(app);
  t.after(() => app.close());

  for (const path of ['/runs', '/active']) {
    const res = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    assert.equal(res.status, 404, path);
  }
});
