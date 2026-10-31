import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { GitHubApp } from '../src/github.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }); // the format GitHub hands out

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tokenResponse = (token) => json(201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() });

/** A fetch that routes token requests and API calls to separate handlers and records every call. */
function fakeFetch(api) {
  const calls = [];
  let tokens = 0;
  const fetch = async (url, init) => {
    calls.push({ url, ...init });
    if (url.endsWith('/access_tokens')) return tokenResponse(`ghs_${++tokens}`);
    return api(url, init, calls);
  };
  fetch.calls = calls;
  return fetch;
}

const makeApp = (fetch) => new GitHubApp({ appId: 12345, privateKey: pem, apiUrl: 'https://api.test', fetch, retryDelayMs: 0 });

test('signs a JWT GitHub can verify with the app public key', () => {
  const jwt = makeApp(fakeFetch(() => json(200, {}))).appJwt();
  const [header, payload, signature] = jwt.split('.');
  assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.iss, '12345');
  assert.ok(claims.exp - claims.iat <= 600, 'GitHub rejects app JWTs that live longer than 10 minutes');
});

test('reuses the installation token and sends the API version header', async () => {
  const fetch = fakeFetch(() => json(200, { id: 1, status: 'queued' }));
  const app = makeApp(fetch);

  await Promise.all([app.getJob(42, 'acme/web', 1), app.getJob(42, 'acme/web', 2)]);
  await app.getJob(42, 'acme/web', 3);

  assert.equal(fetch.calls.filter((call) => call.url.endsWith('/access_tokens')).length, 1);
  const apiCall = fetch.calls.find((call) => call.url === 'https://api.test/repos/acme/web/actions/jobs/3');
  assert.equal(apiCall.headers.authorization, 'Bearer ghs_1');
  assert.equal(apiCall.headers['x-github-api-version'], '2026-03-10');
});

test('retries server errors, then succeeds', async () => {
  let failures = 2;
  const fetch = fakeFetch(() => (failures-- > 0 ? json(502, { message: 'Bad Gateway' }) : json(200, { status: 'completed' })));

  const job = await makeApp(fetch).getJob(42, 'acme/web', 1);

  assert.equal(job.status, 'completed');
});

test('gets a fresh token once if GitHub says the current one is bad', async () => {
  const fetch = fakeFetch((url, init) =>
    init.headers.authorization === 'Bearer ghs_1' ? json(401, { message: 'Bad credentials' }) : json(202, {}),
  );

  await makeApp(fetch).cancelRun(42, 'acme/web', 7);

  const cancels = fetch.calls.filter((call) => call.url.endsWith('/actions/runs/7/cancel'));
  assert.deepEqual(
    cancels.map((call) => call.headers.authorization),
    ['Bearer ghs_1', 'Bearer ghs_2'],
  );
});

test('errors carry the HTTP status so callers can tell a 409 from a failure', async () => {
  const fetch = fakeFetch(() => json(409, { message: 'Cannot cancel a workflow run that is completed.' }));

  await assert.rejects(makeApp(fetch).cancelRun(42, 'acme/web', 7), (err) => err.status === 409);
});
