import { readFileSync } from 'node:fs';
import { compileTargets } from './workflows.js';

/**
 * Everything is configured through environment variables, so the same build can
 * run in dry-run mode first and then enforce, without code changes.
 */
export function loadConfig(env = process.env) {
  return {
    port: integer(env, 'PORT', 3000, 0),
    appId: required(env, 'GITHUB_APP_ID'),
    privateKey: privateKey(env),
    webhookSecret: required(env, 'GITHUB_WEBHOOK_SECRET'),
    apiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
    apiVersion: env.GITHUB_API_VERSION || '2026-03-10',
    sweepIntervalMs: integer(env, 'SWEEP_INTERVAL_SECONDS', 300, 1) * 1000,
    staleAfterMs: integer(env, 'STALE_AFTER_SECONDS', 900, 1) * 1000,
    // Unset means the default file; set-but-empty turns the run log off.
    runLogFile: env.RUN_LOG_FILE === undefined ? 'runs.jsonl' : env.RUN_LOG_FILE.trim() || null,
    adminToken: adminToken(env),
    policy: parsePolicy(env),
  };
}

/** Protects GET /runs and GET /active. Unset means those endpoints are off. */
function adminToken(env) {
  const token = env.ADMIN_TOKEN?.trim();
  if (!token) return null;
  if (token.length < 16) throw new Error('ADMIN_TOKEN must be at least 16 characters long');
  return token;
}

/** The rules the limiter applies. Safe by default: dry run, soft mode. */
export function parsePolicy(env = {}) {
  const mode = (env.MODE || 'soft').trim().toLowerCase();
  if (mode !== 'soft' && mode !== 'hard') {
    throw new Error(`MODE must be "soft" or "hard" (got "${env.MODE}")`);
  }
  return {
    // Only runs that are, or call, one of these workflows are limited and logged. Empty means all runs.
    targets: compileTargets(list(env.TARGET_WORKFLOWS, [])),
    defaultLimit: integer(env, 'MAX_JOBS_PER_USER', 5, 0),
    userLimits: userLimits(env.USER_LIMITS),
    exemptActors: new Set(list(env.EXEMPT_ACTORS, []).map((name) => name.toLowerCase())),
    exemptEvents: new Set(list(env.EXEMPT_EVENTS, ['schedule']).map((name) => name.toLowerCase())),
    exemptBots: flag(env, 'EXEMPT_BOTS', true),
    mode,
    dryRun: flag(env, 'DRY_RUN', true),
    explain: flag(env, 'EXPLAIN_WITH_CHECK_RUN', true),
  };
}

function required(env, name) {
  const value = env[name];
  if (!value || !value.trim()) throw new Error(`Missing required environment variable ${name}`);
  return value.trim();
}

function integer(env, name, fallback, min) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be a whole number of at least ${min} (got "${raw}")`);
  }
  return value;
}

function flag(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} must be true or false (got "${raw}")`);
}

/** Comma-separated list. Unset means the default; set-but-empty means "none". */
function list(raw, fallback) {
  if (raw === undefined) return fallback;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** USER_LIMITS="alice=10,renovate[bot]=2" */
function userLimits(raw) {
  const limits = new Map();
  for (const item of list(raw, [])) {
    const [login, value, extra] = item.split('=').map((part) => part.trim());
    const limit = Number(value);
    if (!login || value === undefined || value === '' || extra !== undefined || !Number.isInteger(limit) || limit < 0) {
      throw new Error(`USER_LIMITS entries look like login=limit, separated by commas (got "${item}")`);
    }
    limits.set(login.toLowerCase(), limit);
  }
  return limits;
}

function privateKey(env) {
  if (env.GITHUB_APP_PRIVATE_KEY) return env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
  if (env.GITHUB_APP_PRIVATE_KEY_PATH) return readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
  throw new Error(
    'Set GITHUB_APP_PRIVATE_KEY (the PEM text) or GITHUB_APP_PRIVATE_KEY_PATH (a path to the .pem file)',
  );
}
