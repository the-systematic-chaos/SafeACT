import { appendFileSync, createReadStream, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { log as defaultLog } from './log.js';

const DAY = 24 * 60 * 60 * 1000;

/** Fields a "run" line contributes to its row. */
const RUN_FIELDS = [
  'runId',
  'attempt',
  'org',
  'repo',
  'workflow',
  'workflowPath',
  'calledWorkflow',
  'calledWorkflowSha',
  'user',
  'actor',
  'event',
  'branch',
  'headRepo',
  'prs',
  'baseBranches',
  'sha',
  'title',
  'url',
  'requestedAt',
];

/** Columns in CSV exports, in order. JSON rows carry a few more (org, workflowPath, sha...). */
export const COLUMNS = [
  'requestedAt',
  'user',
  'actor',
  'repo',
  'branch',
  'baseBranches',
  'prs',
  'event',
  'workflow',
  'calledWorkflow',
  'runId',
  'attempt',
  'jobs',
  'decision',
  'active',
  'limit',
  'conclusion',
  'startedAt',
  'completedAt',
  'durationSeconds',
  'title',
  'url',
];

/**
 * An append-only log of the runs the app watches, one JSON object per line:
 *
 *   run          who started it, from which repo and branch, when (written once per run attempt)
 *   job          one of its jobs was queued
 *   job_started  one of its jobs started on a runner
 *   decision     what the limiter did: admitted, exempt, would_cancel, cancelled, ...
 *   done         it finished
 *
 * readRuns() folds the lines into one row per run attempt. Appending small lines
 * keeps the file safe to read while it's being written, and easy to rotate.
 */
export class RunLog {
  constructor({ file, now = Date.now, log = defaultLog }) {
    this.file = file;
    this.now = now;
    this.log = log;
    /** key -> { open, installationId, repo, runId, attempt, touchedAt, closedAt } */
    this.runs = new Map();
    mkdirSync(dirname(file), { recursive: true });
  }

  /** Records a run the first time it's seen; later calls only note that it's still active. */
  runSeen(key, record, { installationId, repo }) {
    const known = this.runs.get(key);
    if (known) {
      known.touchedAt = this.now();
      return;
    }
    this.runs.set(key, {
      open: true,
      installationId,
      repo,
      runId: record.runId,
      attempt: record.attempt,
      touchedAt: this.now(),
    });
    this.write('run', key, { ...record, installationId });
  }

  jobQueued(key, job) {
    this.touch(key);
    this.write('job', key, { jobId: job.id, name: job.name ?? null, queuedAt: job.created_at ?? null });
  }

  jobStarted(key, job) {
    this.touch(key);
    this.write('job_started', key, {
      jobId: job.id,
      name: job.name ?? null,
      startedAt: job.started_at ?? null,
      runner: job.runner_name ?? null,
    });
  }

  decision(key, fields) {
    this.touch(key);
    this.write('decision', key, fields);
  }

  runDone(key, { conclusion, completedAt }) {
    const known = this.runs.get(key);
    if (known && !known.open) return;
    if (known) {
      known.open = false;
      known.closedAt = this.now();
    }
    this.write('done', key, { conclusion: conclusion ?? null, completedAt: completedAt ?? null });
  }

  /**
   * After a restart, finds runs from the last week that never got a "done" line,
   * so the sweeper can ask GitHub how they ended.
   */
  async load({ withinMs = 7 * DAY } = {}) {
    if (!existsSync(this.file)) return 0;
    const cutoff = this.now() - withinMs;
    for await (const event of readEvents(this.file)) {
      if (event.type === 'run') {
        if (!(Date.parse(event.at) >= cutoff) || this.runs.has(event.key)) continue;
        this.runs.set(event.key, {
          open: true,
          installationId: event.installationId,
          repo: event.repo,
          runId: event.runId,
          attempt: event.attempt,
          touchedAt: 0, // check on the first sweep
        });
      } else if (event.type === 'done') {
        const known = this.runs.get(event.key);
        if (known) {
          known.open = false;
          known.closedAt = this.now();
        }
      }
    }
    return this.openCount();
  }

  /** Asks GitHub about runs nothing has been heard about for a while, in case their "completed" webhook was missed. */
  async sweep(github, staleAfterMs) {
    const cutoff = this.now() - staleAfterMs;
    let checked = 0;
    for (const [key, run] of this.runs) {
      if (!run.open || run.touchedAt > cutoff) continue;
      if (!run.installationId || !run.repo) {
        this.runs.delete(key);
        continue;
      }
      run.touchedAt = this.now();
      checked += 1;
      try {
        const latest = await github.getRunAttempt(run.installationId, run.repo, run.runId, run.attempt);
        if (latest?.status === 'completed') {
          this.runDone(key, { conclusion: latest.conclusion, completedAt: latest.updated_at });
        }
      } catch (err) {
        if (err.status === 404) this.runDone(key, { conclusion: 'deleted', completedAt: null });
        else this.log('warn', 'could not refresh a run for the log', { repo: run.repo, runId: run.runId, error: err.message });
      }
    }
    this.prune();
    return checked;
  }

  openCount() {
    let open = 0;
    for (const run of this.runs.values()) if (run.open) open += 1;
    return open;
  }

  touch(key) {
    const known = this.runs.get(key);
    if (known) known.touchedAt = this.now();
  }

  prune() {
    const cutoff = this.now() - DAY;
    for (const [key, run] of this.runs) {
      if (!run.open && run.closedAt <= cutoff) this.runs.delete(key);
    }
  }

  write(type, key, fields) {
    const line = JSON.stringify({ type, at: new Date(this.now()).toISOString(), key, ...fields });
    try {
      appendFileSync(this.file, `${line}\n`);
    } catch (err) {
      this.log('error', 'could not write to the run log', { file: this.file, error: err.message });
    }
  }
}

/** One row per run attempt, newest first, optionally filtered. */
export async function readRuns(file, filters = {}) {
  if (!file || !existsSync(file)) return [];
  const rows = new Map();
  for await (const event of readEvents(file)) {
    let row = rows.get(event.key);
    if (!row) {
      row = newRow();
      rows.set(event.key, row);
    }
    applyEvent(row, event);
  }
  const result = [];
  for (const row of rows.values()) {
    const finished = finishRow(row);
    if (matchesFilters(finished, filters)) result.push(finished);
  }
  result.sort((a, b) => b._sort - a._sort);
  return filters.limit ? result.slice(0, filters.limit) : result;
}

/** Shared by GET /runs and the report command. `get(name)` returns the raw value or undefined. */
export function parseRunFilters(get) {
  const filters = {};
  for (const name of ['user', 'repo', 'branch', 'decision']) {
    const value = get(name)?.trim();
    if (value) filters[name] = value;
  }
  for (const name of ['since', 'until']) {
    const value = get(name)?.trim();
    if (!value) continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) {
      throw new Error(`${name} must be a date or time, like 2026-10-29 or 2026-10-29T17:00:00Z (got "${value}")`);
    }
    filters[name] = time;
  }
  const limit = get('limit')?.trim();
  if (limit) {
    const value = Number(limit);
    if (!Number.isInteger(value) || value < 1 || value > 100_000) {
      throw new Error(`limit must be a whole number from 1 to 100000 (got "${limit}")`);
    }
    filters.limit = value;
  }
  return filters;
}

export function toCsv(rows, columns = COLUMNS) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(','));
  return `${lines.join('\n')}\n`;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = Array.isArray(value) ? value.join(' ') : String(value);
  // Titles and branch names come from users. Keep a spreadsheet from running one as a formula.
  if ((typeof value === 'string' || Array.isArray(value)) && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function* readEvents(file) {
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a line cut short by a crash or a full disk
    }
    if (event && typeof event.key === 'string') yield event;
  }
}

function newRow() {
  return {
    runId: null,
    attempt: null,
    requestedAt: null,
    user: null,
    actor: null,
    org: null,
    repo: null,
    branch: null,
    baseBranches: [],
    prs: [],
    event: null,
    workflow: null,
    workflowPath: null,
    calledWorkflow: null,
    calledWorkflowSha: null,
    headRepo: null,
    sha: null,
    title: null,
    url: null,
    jobs: 0,
    decision: null,
    active: null,
    limit: null,
    startedAt: null,
    completedAt: null,
    durationSeconds: null,
    conclusion: null,
    jobIds: new Set(),
    firstSeenAt: null,
  };
}

function applyEvent(row, event) {
  row.firstSeenAt ??= event.at ?? null;
  switch (event.type) {
    case 'run':
      for (const field of RUN_FIELDS) if (event[field] !== undefined) row[field] = event[field];
      break;
    case 'job':
      if (event.jobId != null) row.jobIds.add(event.jobId);
      break;
    case 'job_started':
      if (event.jobId != null) row.jobIds.add(event.jobId);
      if (event.startedAt && !(Date.parse(row.startedAt) <= Date.parse(event.startedAt))) row.startedAt = event.startedAt;
      break;
    case 'decision':
      row.decision = event.decision ?? null;
      row.active = event.active ?? null;
      row.limit = event.limit ?? null;
      break;
    case 'done':
      row.conclusion = event.conclusion ?? null;
      row.completedAt = event.completedAt ?? null;
      break;
  }
}

function finishRow(row) {
  const { jobIds, firstSeenAt, ...out } = row;
  out.jobs = jobIds.size;
  const start = Date.parse(out.requestedAt);
  const end = Date.parse(out.completedAt);
  out.durationSeconds = Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 1000) : null;
  // Sort and filter on when the run was requested, or when the app first heard of it if that's unknown.
  Object.defineProperty(out, '_sort', { value: Date.parse(out.requestedAt ?? firstSeenAt) || 0, enumerable: false });
  return out;
}

function matchesFilters(row, { user, repo, branch, decision, since, until }) {
  const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  if (user && !same(row.user, user) && !same(row.actor, user)) return false;
  if (repo && !same(row.repo, repo)) return false;
  if (branch && row.branch !== branch) return false;
  if (decision && row.decision !== decision) return false;
  if (since !== undefined && !(row._sort >= since)) return false;
  if (until !== undefined && !(row._sort < until)) return false;
  return true;
}
