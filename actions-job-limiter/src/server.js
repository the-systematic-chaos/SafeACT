import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseRunFilters, readRuns, toCsv } from './runlog.js';

/** GitHub caps webhook payloads at 25 MB. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const DEFAULT_RUNS_LIMIT = 1000;

/** Checks GitHub's X-Hub-Signature-256 header against the raw request body. */
export function verifySignature(secret, body, header) {
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function hasToken(req, adminToken) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length).trim());
  const expected = Buffer.from(adminToken);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * POST /webhook (or /)  receives GitHub deliveries
 * GET  /healthz         reports counts only, no names
 * GET  /runs            the run log, one row per run (JSON, or CSV with ?format=csv); needs ADMIN_TOKEN
 * GET  /active          who is using job slots right now; needs ADMIN_TOKEN
 */
export function createServer({ webhookSecret, limiter, store, policy, log, runLogFile = null, adminToken = null }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/healthz') {
      return send(res, 200, {
        ok: true,
        mode: policy.mode,
        dryRun: policy.dryRun,
        defaultLimit: policy.defaultLimit,
        targets: policy.targets.map((target) => target.pattern),
        runLog: Boolean(runLogFile),
        ...store.stats(),
      });
    }

    if (req.method === 'GET' && (path === '/runs' || path === '/active')) {
      if (!adminToken) return send(res, 404, { error: 'not found' }); // off until ADMIN_TOKEN is set
      if (!hasToken(req, adminToken)) {
        return send(res, 401, { error: 'missing or wrong token' }, { 'www-authenticate': 'Bearer' });
      }
      if (path === '/active') return send(res, 200, { users: limiter.activeUsers() });
      return sendRuns(res, url, { runLogFile, log });
    }

    if (req.method !== 'POST' || (path !== '/webhook' && path !== '/')) {
      return send(res, 404, { error: 'not found' });
    }

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('error', () => res.destroy());
    req.on('end', () => {
      if (tooLarge) return send(res, 413, { error: 'payload too large' });

      const body = Buffer.concat(chunks);
      const delivery = req.headers['x-github-delivery'];
      if (!verifySignature(webhookSecret, body, req.headers['x-hub-signature-256'])) {
        log('warn', 'refused a delivery with a missing or wrong signature', { delivery });
        return send(res, 401, { error: 'invalid signature' });
      }

      let payload;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        return send(res, 400, { error: 'body is not JSON' });
      }

      // Answer straight away (GitHub gives up after 10 seconds) and do the work afterwards.
      const event = req.headers['x-github-event'];
      send(res, 202, { ok: true });
      Promise.resolve()
        .then(() => limiter.handle(event, payload))
        .catch((err) => log('error', 'failed to process delivery', { event, delivery, error: err.message }));
    });
  });
}

function sendRuns(res, url, { runLogFile, log }) {
  if (!runLogFile) return send(res, 404, { error: 'the run log is turned off (RUN_LOG_FILE is empty)' });
  const format = url.searchParams.get('format') || 'json';
  if (format !== 'json' && format !== 'csv') return send(res, 400, { error: 'format must be json or csv' });
  let filters;
  try {
    filters = parseRunFilters((name) => url.searchParams.get(name) ?? undefined);
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
  filters.limit ??= DEFAULT_RUNS_LIMIT;

  readRuns(runLogFile, filters)
    .then((rows) => {
      if (format === 'json') return send(res, 200, { count: rows.length, runs: rows });
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="runs.csv"',
      });
      res.end(toCsv(rows));
    })
    .catch((err) => {
      log('error', 'could not read the run log', { error: err.message });
      send(res, 500, { error: 'could not read the run log' });
    });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
