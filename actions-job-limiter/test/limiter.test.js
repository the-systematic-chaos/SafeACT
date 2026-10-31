import assert from 'node:assert/strict';
import { test } from 'node:test';
import { httpError, makeLimiter, runEvent } from './helpers.js';

test('lets a person run up to their limit, then cancels their next run and says why', async () => {
  const { github, store, queue } = makeLimiter({ MAX_JOBS_PER_USER: '2' });
  github.addRun(1, { login: 'alice' });
  github.addRun(2, { login: 'alice' });
  github.addRun(3, { login: 'bob' });

  await queue(1, 1);
  await queue(2, 1);
  await queue(3, 2, { sha: 'def456' });
  await queue(4, 3);

  assert.deepEqual(github.cancelled, [2]);
  assert.equal(store.activeCount('acme/alice'), 2);
  assert.equal(store.activeCount('acme/bob'), 1);
  const [check] = github.checkRuns;
  assert.equal(check.name, 'Job limit: CI');
  assert.equal(check.head_sha, 'def456');
  assert.equal(check.conclusion, 'neutral');
  assert.equal(check.output.title, 'alice is at the job limit (2/2)');
  assert.doesNotMatch(check.output.summary, /max-parallel/, 'the matrix hint is only for hard mode');
});

test('soft mode lets a run it admitted finish, even past the limit', async () => {
  const { github, store, queue } = makeLimiter({ MAX_JOBS_PER_USER: '2' });
  github.addRun(1, { login: 'alice' });

  for (const job of [1, 2, 3, 4, 5]) await queue(job, 1);

  assert.deepEqual(github.cancelled, []);
  assert.equal(store.activeCount('acme/alice'), 5);
});

test('hard mode cancels the run whose job takes the person over the limit', async () => {
  const { github, store, queue } = makeLimiter({ MODE: 'hard', MAX_JOBS_PER_USER: '2' });
  github.addRun(1, { login: 'alice' });

  await queue(1, 1);
  await queue(2, 1);
  assert.deepEqual(github.cancelled, []);
  await queue(3, 1);

  assert.deepEqual(github.cancelled, [1]);
  assert.equal(store.activeCount('acme/alice'), 0, 'the cancelled run stops counting');
  assert.match(github.checkRuns[0].output.summary, /max-parallel/);
});

test('finished jobs free up room', async () => {
  const { github, queue, jobUpdate } = makeLimiter({ MAX_JOBS_PER_USER: '1' });
  for (const run of [1, 2, 3]) github.addRun(run, { login: 'alice' });

  await queue(1, 1);
  await queue(2, 2); // over the limit: cancelled
  await jobUpdate('completed', 1, 1);
  await queue(3, 3); // room again

  assert.deepEqual(github.cancelled, [2]);
});

test('dry run logs what it would cancel, once per run, and keeps counting', async () => {
  const { github, store, log, queue } = makeLimiter({ DRY_RUN: 'true', MAX_JOBS_PER_USER: '1' });
  github.addRun(1, { login: 'alice' });
  github.addRun(2, { login: 'alice' });

  await queue(1, 1);
  await queue(2, 2);
  await queue(3, 2);

  assert.deepEqual(github.cancelled, []);
  assert.equal(github.checkRuns.length, 0);
  assert.equal(store.activeCount('acme/alice'), 3, 'the run really is going ahead, so it is counted');
  const wouldCancel = log.entries.filter((entry) => entry.msg === 'dry run: would cancel run');
  assert.equal(wouldCancel.length, 1);
  assert.equal(wouldCancel[0].runId, 2);
  assert.equal(wouldCancel[0].user, 'alice');
});

test('dry run in hard mode also logs a run only once', async () => {
  const { github, log, queue } = makeLimiter({ DRY_RUN: 'true', MODE: 'hard', MAX_JOBS_PER_USER: '1' });
  github.addRun(1, { login: 'alice' });

  for (const job of [1, 2, 3, 4]) await queue(job, 1);

  assert.equal(log.entries.filter((entry) => entry.msg === 'dry run: would cancel run').length, 1);
});

test('bots, listed people and scheduled runs are not limited', async () => {
  const { github, store, queue } = makeLimiter({ MAX_JOBS_PER_USER: '1', EXEMPT_ACTORS: 'release-captain' });
  github.addRun(1, { login: 'dependabot[bot]', type: 'Bot' });
  github.addRun(2, { login: 'dependabot[bot]', type: 'Bot' });
  github.addRun(3, { login: 'Release-Captain' });
  github.addRun(4, { login: 'Release-Captain' });
  github.addRun(5, { login: 'alice', event: 'schedule' });
  github.addRun(6, { login: 'alice', event: 'schedule' });

  for (const run of [1, 2, 3, 4, 5, 6]) await queue(run, run);

  assert.deepEqual(github.cancelled, []);
  assert.equal(store.stats().trackedJobs, 0);
});

test('an explicit limit applies even to a bot', async () => {
  const { github, queue } = makeLimiter({ USER_LIMITS: 'renovate[bot]=1' });
  github.addRun(1, { login: 'renovate[bot]', type: 'Bot' });
  github.addRun(2, { login: 'renovate[bot]', type: 'Bot' });

  await queue(1, 1);
  await queue(2, 2);

  assert.deepEqual(github.cancelled, [2]);
});

test('per-person limits override the default, and logins match case-insensitively', async () => {
  const { github, store, queue } = makeLimiter({ MAX_JOBS_PER_USER: '1', USER_LIMITS: 'Alice=3' });
  for (const run of [1, 2, 3, 4]) github.addRun(run, { login: 'alice' });
  github.addRun(5, { login: 'bob' });
  github.addRun(6, { login: 'bob' });

  for (const run of [1, 2, 3, 4]) await queue(run, run);
  await queue(5, 5);
  await queue(6, 6);

  assert.deepEqual(github.cancelled, [4, 6]);
  assert.equal(store.activeCount('acme/alice'), 3);
});

test('late, duplicate and repeated deliveries are counted once', async () => {
  const { github, store, queue, jobUpdate } = makeLimiter({ MAX_JOBS_PER_USER: '5' });
  github.addRun(1, { login: 'alice' });

  await jobUpdate('completed', 1, 1);
  await queue(1, 1); // a "queued" that arrives after the job already finished
  assert.equal(store.activeCount('acme/alice'), 0);

  await queue(2, 1);
  await queue(2, 1); // the same delivery twice
  await jobUpdate('in_progress', 2, 1);
  assert.equal(store.activeCount('acme/alice'), 1);
});

test('jobs waiting on an environment approval do not count until they start', async () => {
  const { github, store, queue, jobUpdate } = makeLimiter({ MAX_JOBS_PER_USER: '1' });
  github.addRun(1, { login: 'alice' });
  github.addRun(2, { login: 'alice' });

  await queue(1, 1);
  await jobUpdate('waiting', 1, 1);
  assert.equal(store.activeCount('acme/alice'), 0);

  await queue(2, 2); // there's room while job 1 waits
  assert.deepEqual(github.cancelled, []);

  await jobUpdate('in_progress', 1, 1); // approved; soft mode lets an admitted run carry on
  assert.equal(store.activeCount('acme/alice'), 2);
});

test('limits are counted separately in each organization', async () => {
  const { github, store, queue } = makeLimiter({ MAX_JOBS_PER_USER: '1' });
  github.addRun(1, { login: 'alice' });
  github.addRun(2, { login: 'alice' });

  await queue(1, 1, { org: 'acme' });
  await queue(2, 2, { org: 'globex' });

  assert.deepEqual(github.cancelled, []);
  assert.equal(store.activeCount('acme/alice'), 1);
  assert.equal(store.activeCount('globex/alice'), 1);
});

test('a re-run is charged to whoever clicked re-run', async () => {
  const { github, store, queue } = makeLimiter({ MAX_JOBS_PER_USER: '1' });
  github.addRun(1, { login: 'alice' });
  github.addRun(1, { login: 'bob', attempt: 2 });

  await queue(1, 1);
  await queue(2, 1, { attempt: 2 });

  assert.deepEqual(github.cancelled, []);
  assert.equal(store.activeCount('acme/alice'), 1);
  assert.equal(store.activeCount('acme/bob'), 1);
});

test('jobs that arrive together share one lookup and one decision', async () => {
  const { github, store, queue } = makeLimiter({ MAX_JOBS_PER_USER: '3' });
  github.addRun(1, { login: 'alice' });
  github.addRun(2, { login: 'alice' });

  await Promise.all([1, 2, 3].map((job) => queue(job, 1)));
  assert.equal(github.lookups, 1);
  assert.equal(store.activeCount('acme/alice'), 3);

  await Promise.all([4, 5, 6, 7, 8].map((job) => queue(job, 2)));
  assert.equal(github.lookups, 2);
  assert.deepEqual(github.cancelled, [2]);
  assert.equal(github.checkRuns.length, 1);
  assert.equal(store.activeCount('acme/alice'), 3);
});

test('two runs racing for the last slot cannot both get it', async () => {
  const { limiter, github, store, queue } = makeLimiter({ MAX_JOBS_PER_USER: '2' });
  // Owners already known, so both deliveries resume in the same microtask turn: the tightest race.
  for (const run of [1, 2, 3]) await limiter.handle('workflow_run', runEvent('requested', { run, login: 'alice' }));

  await queue(1, 1);
  await Promise.all([queue(2, 2), queue(3, 3)]); // one slot left, two new runs

  assert.equal(github.cancelled.length, 1);
  assert.equal(store.activeCount('acme/alice'), 2);
});

test('workflow_run deliveries save the lookup and are cleaned up when the run ends', async () => {
  const { limiter, github, store, queue } = makeLimiter();

  await limiter.handle('workflow_run', runEvent('requested', { run: 7, login: 'alice' }));
  await queue(1, 7);
  assert.equal(github.lookups, 0);
  assert.equal(store.activeCount('acme/alice'), 1);

  await limiter.handle('workflow_run', runEvent('completed', { run: 7, login: 'alice' }));
  assert.equal(store.getRun('7:1'), undefined);
});

test('if GitHub refuses the cancel, the run goes ahead and is counted', async () => {
  const { github, store, log, queue } = makeLimiter({ MAX_JOBS_PER_USER: '1' });
  github.addRun(1, { login: 'alice' });
  github.addRun(2, { login: 'alice' });
  github.cancelError = httpError(500, 'Server Error');

  await queue(1, 1);
  await queue(2, 2);
  await queue(3, 2);

  assert.equal(store.activeCount('acme/alice'), 3);
  assert.equal(github.checkRuns.length, 0);
  assert.ok(log.entries.some((entry) => entry.level === 'error' && entry.msg.startsWith('could not cancel run')));
});

test('in hard mode a failed cancel is not retried for every later job of the run', async () => {
  const { github, log, queue } = makeLimiter({ MODE: 'hard', MAX_JOBS_PER_USER: '1' });
  github.addRun(1, { login: 'alice' });
  github.cancelError = httpError(403, 'Resource not accessible by integration');

  for (const job of [1, 2, 3, 4]) await queue(job, 1);

  assert.equal(log.entries.filter((entry) => entry.msg.startsWith('could not cancel run')).length, 1);
});

test('a run that already finished is left alone', async () => {
  const { github, log, queue } = makeLimiter({ MAX_JOBS_PER_USER: '1' });
  github.addRun(1, { login: 'alice' });
  github.addRun(2, { login: 'alice' });
  github.cancelError = httpError(409, 'Cannot cancel a workflow run that is completed.');

  await queue(1, 1);
  await queue(2, 2);

  assert.equal(github.checkRuns.length, 0);
  assert.ok(!log.entries.some((entry) => entry.level === 'error'));
  assert.ok(log.entries.some((entry) => entry.msg === 'run had already finished; nothing to cancel'));
});

test('a run whose owner cannot be looked up is not limited', async () => {
  const { github, store, log, queue } = makeLimiter({ MAX_JOBS_PER_USER: '0' });

  await queue(1, 99); // the fake has no run 99, so the lookup 404s

  assert.deepEqual(github.cancelled, []);
  assert.equal(store.stats().trackedJobs, 0);
  assert.ok(log.entries.some((entry) => entry.level === 'warn'));
});

test('the sweeper drops jobs GitHub says are finished, parked or gone', async () => {
  const { limiter, github, store, queue } = makeLimiter({ MAX_JOBS_PER_USER: '5' });
  github.addRun(1, { login: 'alice' });
  for (const job of [1, 2, 3, 4]) await queue(job, 1);
  github.jobStatuses.set(1, 'completed');
  github.jobStatuses.set(2, 'in_progress');
  github.jobStatuses.set(3, 'waiting');
  // job 4 is unknown to the fake, so it 404s

  const { jobs: checked } = await limiter.sweep(0);

  assert.equal(checked, 4);
  assert.equal(store.activeCount('acme/alice'), 1);
  assert.ok(store.hasJob(2));
  assert.ok(store.isFinished(1));
  assert.ok(store.isFinished(4));
});
