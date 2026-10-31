import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePolicy } from '../src/config.js';
import { Limiter } from '../src/limiter.js';
import { RunLog } from '../src/runlog.js';
import { MemoryStore } from '../src/store.js';

const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const httpError = (status, message) => Object.assign(new Error(message), { status });

export const CENTRAL = 'acme/central/.github/workflows/build.yml';

/**
 * A workflow run shaped like GitHub's. `calls` lists the reusable workflows it
 * uses, as "owner/repo/.github/workflows/file.yml@ref".
 */
export function fakeRun(runId, opts = {}) {
  const {
    login,
    type = 'User',
    actorLogin = login,
    event = 'push',
    attempt = 1,
    repo = 'acme/web',
    name = 'CI',
    path = '.github/workflows/ci.yml@main',
    calls = [],
    branch = 'main',
    headRepo = repo,
    prs = [],
    title = 'Update README.md',
    createdAt = '2026-10-29T17:00:00Z',
    startedAt = createdAt,
    updatedAt = startedAt,
    status = 'queued',
    conclusion = null,
  } = opts;
  return {
    id: runId,
    name,
    run_attempt: attempt,
    event,
    path,
    head_branch: branch,
    head_sha: 'abc123',
    display_title: title,
    html_url: `https://github.com/${repo}/actions/runs/${runId}`,
    created_at: createdAt,
    run_started_at: startedAt,
    updated_at: updatedAt,
    status,
    conclusion,
    actor: { login: actorLogin, type },
    triggering_actor: { login, type },
    repository: { full_name: repo },
    head_repository: { full_name: headRepo },
    pull_requests: prs.map(({ number, base = 'main' }) => ({ number, head: { ref: branch }, base: { ref: base } })),
    referenced_workflows: calls.map((call) => ({ path: call, sha: 'def456', ref: 'refs/heads/main' })),
  };
}

/** Stands in for GitHubApp: knows a few runs, records what the app asks it to do. */
export class FakeGitHub {
  constructor() {
    this.runs = new Map();
    this.jobStatuses = new Map();
    this.cancelled = [];
    this.checkRuns = [];
    this.lookups = 0;
    this.cancelError = null;
  }

  addRun(runId, opts) {
    const run = fakeRun(runId, opts);
    this.runs.set(`${runId}:${run.run_attempt}`, run);
    return run;
  }

  async getRunAttempt(installationId, repo, runId, attempt) {
    this.lookups += 1;
    await nextTick();
    const run = this.runs.get(`${runId}:${attempt}`);
    if (!run) throw httpError(404, 'Not Found');
    return run;
  }

  async cancelRun(installationId, repo, runId) {
    await nextTick();
    if (this.cancelError) throw this.cancelError;
    this.cancelled.push(runId);
    return {};
  }

  async getJob(installationId, repo, jobId) {
    await nextTick();
    const status = this.jobStatuses.get(jobId);
    if (!status) throw httpError(404, 'Not Found');
    return { id: jobId, status };
  }

  async createCheckRun(installationId, repo, checkRun) {
    this.checkRuns.push({ repo, ...checkRun });
    return { id: this.checkRuns.length };
  }
}

export { httpError };

/** A log function that remembers what it was given. */
export function recordingLog() {
  const entries = [];
  const log = (level, msg, fields = {}) => entries.push({ level, msg, ...fields });
  log.entries = entries;
  return log;
}

export function jobEvent(
  action,
  { job, run, attempt = 1, org = 'acme', repo = 'web', sha = 'abc123', workflow = 'CI', startedAt, runner },
) {
  return {
    action,
    installation: { id: 42 },
    repository: { full_name: `${org}/${repo}`, owner: { login: org } },
    workflow_job: {
      id: job,
      run_id: run,
      run_attempt: attempt,
      head_sha: sha,
      workflow_name: workflow,
      name: `job ${job}`,
      status: action,
      created_at: '2026-10-29T17:00:01Z',
      started_at: startedAt ?? '2026-10-29T17:00:01Z',
      runner_name: runner ?? null,
    },
  };
}

/** A workflow_run delivery. Takes the same options as fakeRun. */
export function runEvent(action, { run, ...opts }) {
  const workflowRun = fakeRun(run, opts);
  const [owner] = workflowRun.repository.full_name.split('/');
  return {
    action,
    installation: { id: 42 },
    repository: { full_name: workflowRun.repository.full_name, owner: { login: owner } },
    workflow_run: workflowRun,
  };
}

/** A temporary directory, removed when the test ends. */
export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'job-limiter-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A limiter wired to fakes. Enforcing by default so tests can see cancellations. */
export function makeLimiter(env = {}, { runLogFile = null, now } = {}) {
  const github = new FakeGitHub();
  const log = recordingLog();
  const store = new MemoryStore(now ? { now } : {});
  const policy = parsePolicy({ DRY_RUN: 'false', MAX_JOBS_PER_USER: '2', ...env });
  const runLog = runLogFile ? new RunLog({ file: runLogFile, log, ...(now ? { now } : {}) }) : null;
  const limiter = new Limiter({ policy, store, github, runLog, log });
  const queue = (job, run, extra = {}) => limiter.handle('workflow_job', jobEvent('queued', { job, run, ...extra }));
  const jobUpdate = (action, job, run, extra = {}) =>
    limiter.handle('workflow_job', jobEvent(action, { job, run, ...extra }));
  const runUpdate = (action, run, opts) => limiter.handle('workflow_run', runEvent(action, { run, ...opts }));
  return { limiter, store, github, log, policy, runLog, queue, jobUpdate, runUpdate };
}
