import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseRunFilters, readRuns, RunLog, toCsv } from '../src/runlog.js';
import { CENTRAL, makeLimiter, recordingLog, tempDir } from './helpers.js';

const callsCentral = { calls: [`${CENTRAL}@main`], event: 'pull_request', path: '.github/workflows/pr.yml@main' };

function setup(t, env = {}) {
  const file = join(tempDir(t), 'logs', 'runs.jsonl');
  return { file, ...makeLimiter({ TARGET_WORKFLOWS: CENTRAL, ...env }, { runLogFile: file }) };
}

test('logs who called the central workflow, from which repo and branch, and when', async (t) => {
  const { file, queue, jobUpdate, runUpdate } = setup(t);
  const pr = {
    login: 'alice',
    ...callsCentral,
    branch: 'feature-x',
    prs: [{ number: 12, base: 'main' }],
    title: 'Add search',
    createdAt: '2026-10-29T17:00:00Z',
  };

  await runUpdate('requested', 10, pr);
  await queue(1, 10);
  await queue(2, 10);
  await jobUpdate('in_progress', 1, 10, { startedAt: '2026-10-29T17:00:30Z', runner: 'runner-1' });
  await jobUpdate('in_progress', 2, 10, { startedAt: '2026-10-29T17:00:20Z' });
  await jobUpdate('completed', 1, 10);
  await jobUpdate('completed', 2, 10);
  await runUpdate('completed', 10, { ...pr, status: 'completed', conclusion: 'success', updatedAt: '2026-10-29T17:05:00Z' });

  // A run of some other workflow is not logged.
  await runUpdate('requested', 11, { login: 'alice' });
  await queue(3, 11);

  const rows = await readRuns(file);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    runId: 10,
    attempt: 1,
    requestedAt: '2026-10-29T17:00:00Z',
    user: 'alice',
    actor: 'alice',
    org: 'acme',
    repo: 'acme/web',
    branch: 'feature-x',
    baseBranches: ['main'],
    prs: [12],
    event: 'pull_request',
    workflow: 'CI',
    workflowPath: 'acme/web/.github/workflows/pr.yml',
    calledWorkflow: `${CENTRAL}@main`,
    calledWorkflowSha: 'def456',
    headRepo: null,
    sha: 'abc123',
    title: 'Add search',
    url: 'https://github.com/acme/web/actions/runs/10',
    jobs: 2,
    decision: 'admitted',
    active: 0,
    limit: 2,
    startedAt: '2026-10-29T17:00:20Z',
    completedAt: '2026-10-29T17:05:00Z',
    durationSeconds: 300,
    conclusion: 'success',
  });
});

test('cancellations are logged with the count that caused them', async (t) => {
  const { file, github, queue } = setup(t, { MAX_JOBS_PER_USER: '1' });
  github.addRun(1, { login: 'alice', ...callsCentral });
  github.addRun(2, { login: 'alice', ...callsCentral, repo: 'acme/api' });

  await queue(1, 1);
  await queue(2, 2, { repo: 'api' });

  const byRun = Object.fromEntries((await readRuns(file)).map((row) => [row.runId, row]));
  assert.equal(byRun[1].decision, 'admitted');
  assert.deepEqual(
    { decision: byRun[2].decision, active: byRun[2].active, limit: byRun[2].limit, repo: byRun[2].repo },
    { decision: 'cancelled', active: 1, limit: 1, repo: 'acme/api' },
  );
});

test('dry run logs would_cancel, and exempt bots are logged without being limited', async (t) => {
  const { file, github, queue } = setup(t, { MAX_JOBS_PER_USER: '1', DRY_RUN: 'true' });
  github.addRun(1, { login: 'alice', ...callsCentral });
  github.addRun(2, { login: 'alice', ...callsCentral });
  github.addRun(3, { login: 'renovate[bot]', type: 'Bot', ...callsCentral });

  await queue(1, 1);
  await queue(2, 2);
  await queue(3, 3);
  await queue(4, 3);

  const byRun = Object.fromEntries((await readRuns(file)).map((row) => [row.runId, row]));
  assert.equal(byRun[2].decision, 'would_cancel');
  assert.equal(byRun[3].decision, 'exempt');
  assert.equal(byRun[3].user, 'renovate[bot]');
  assert.equal(byRun[3].jobs, 2);
  assert.deepEqual(github.cancelled, []);
});

test('a re-run gets its own row, charged to whoever re-ran it', async (t) => {
  const { file, github, queue } = setup(t);
  github.addRun(5, {
    login: 'bob',
    actorLogin: 'alice',
    attempt: 2,
    ...callsCentral,
    createdAt: '2026-10-29T17:00:00Z',
    startedAt: '2026-10-29T18:00:00Z',
  });

  await queue(1, 5, { attempt: 2 });

  const [row] = await readRuns(file);
  assert.deepEqual(
    { user: row.user, actor: row.actor, attempt: row.attempt, requestedAt: row.requestedAt },
    { user: 'bob', actor: 'alice', attempt: 2, requestedAt: '2026-10-29T18:00:00Z' },
  );
});

test('pull requests from forks record the fork', async (t) => {
  const { file, github, queue } = setup(t);
  github.addRun(6, { login: 'outsider', ...callsCentral, headRepo: 'outsider/web', branch: 'patch-1' });

  await queue(1, 6);

  const [row] = await readRuns(file);
  assert.equal(row.headRepo, 'outsider/web');
  assert.equal(row.branch, 'patch-1');
});

test('filters by person, repo, branch, decision and time, newest first', async (t) => {
  const file = join(tempDir(t), 'runs.jsonl');
  const runLog = new RunLog({ file, log: recordingLog() });
  const add = (runId, fields, decision) => {
    const key = `${runId}:1`;
    runLog.runSeen(key, { runId, attempt: 1, ...fields }, { installationId: 42, repo: fields.repo });
    if (decision) runLog.decision(key, { decision });
  };
  add(1, { user: 'alice', actor: 'alice', repo: 'acme/web', branch: 'main', requestedAt: '2026-10-01T10:00:00Z' }, 'admitted');
  add(2, { user: 'bob', actor: 'alice', repo: 'acme/web', branch: 'fix', requestedAt: '2026-10-15T10:00:00Z' }, 'cancelled');
  add(3, { user: 'bob', actor: 'bob', repo: 'acme/api', branch: 'main', requestedAt: '2026-10-20T10:00:00Z' }, 'admitted');

  const ids = async (filters) => (await readRuns(file, filters)).map((row) => row.runId);
  assert.deepEqual(await ids({}), [3, 2, 1]);
  assert.deepEqual(await ids({ user: 'ALICE' }), [2, 1], 'matches whoever started or re-ran it');
  assert.deepEqual(await ids({ repo: 'acme/web' }), [2, 1]);
  assert.deepEqual(await ids({ branch: 'main' }), [3, 1]);
  assert.deepEqual(await ids({ decision: 'cancelled' }), [2]);
  assert.deepEqual(await ids({ since: Date.parse('2026-10-10'), until: Date.parse('2026-10-20') }), [2]);
  assert.deepEqual(await ids({ limit: 1 }), [3]);
});

test('CSV export escapes values and defuses formulas', () => {
  const csv = toCsv(
    [
      {
        requestedAt: '2026-10-29T17:00:00Z',
        user: 'alice',
        branch: 'feature,"x"',
        baseBranches: ['main', 'release'],
        prs: [12, 13],
        title: '=HYPERLINK("http://evil.example")',
        jobs: 2,
        active: 0,
      },
    ],
    ['requestedAt', 'user', 'branch', 'baseBranches', 'prs', 'title', 'jobs', 'active', 'conclusion'],
  );
  const [header, line] = csv.trimEnd().split('\n');
  assert.equal(header, 'requestedAt,user,branch,baseBranches,prs,title,jobs,active,conclusion');
  assert.equal(line, '2026-10-29T17:00:00Z,alice,"feature,""x""",main release,12 13,"\'=HYPERLINK(""http://evil.example"")",2,0,');
});

test('a run whose "completed" webhook was missed is closed by the sweeper, even after a restart', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'runs.jsonl');
  const first = makeLimiter({ TARGET_WORKFLOWS: CENTRAL }, { runLogFile: file });
  await first.runUpdate('requested', 20, { login: 'alice', ...callsCentral });
  await first.queue(1, 20);
  await first.runUpdate('requested', 21, { login: 'alice', ...callsCentral });
  await first.queue(2, 21);

  // The app restarts; meanwhile run 20 failed and run 21 was deleted.
  const second = makeLimiter({ TARGET_WORKFLOWS: CENTRAL }, { runLogFile: file });
  assert.equal(await second.runLog.load(), 2);
  second.github.addRun(20, {
    login: 'alice',
    ...callsCentral,
    status: 'completed',
    conclusion: 'failure',
    updatedAt: '2026-10-29T17:09:00Z',
  });

  const swept = await second.limiter.sweep(0);

  assert.equal(swept.runs, 2);
  const byRun = Object.fromEntries((await readRuns(file)).map((row) => [row.runId, row]));
  assert.deepEqual([byRun[20].conclusion, byRun[20].completedAt], ['failure', '2026-10-29T17:09:00Z']);
  assert.equal(byRun[21].conclusion, 'deleted');
  assert.equal(second.runLog.openCount(), 0);
  assert.equal((await second.limiter.sweep(0)).runs, 0, 'closed runs are not checked again');
});

test('the same run seen twice is written once, and broken lines are skipped', async (t) => {
  const { file, runUpdate, queue } = setup(t);
  await runUpdate('requested', 30, { login: 'alice', ...callsCentral });
  await runUpdate('in_progress', 30, { login: 'alice', ...callsCentral });
  await queue(1, 30);
  await queue(1, 30); // duplicate delivery
  appendFileSync(file, 'not json\n{"type":"run","key":"31:1","runId":31,"us\n');

  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.startsWith('{"type":"run"'));
  assert.equal(lines.length, 2, 'one real run line, plus the truncated one');
  const rows = await readRuns(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jobs, 1);
});

test('filter values are checked before reading', () => {
  const get = (values) => (name) => values[name];
  assert.deepEqual(parseRunFilters(get({ user: ' alice ', since: '2026-10-01', limit: '50' })), {
    user: 'alice',
    since: Date.parse('2026-10-01'),
    limit: 50,
  });
  assert.throws(() => parseRunFilters(get({ since: 'last tuesday' })), /since must be a date/);
  assert.throws(() => parseRunFilters(get({ limit: '0' })), /limit must be/);
  assert.throws(() => parseRunFilters(get({ limit: 'all' })), /limit must be/);
});
