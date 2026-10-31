import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CENTRAL, makeLimiter } from './helpers.js';

const callsCentral = { calls: [`${CENTRAL}@main`], event: 'pull_request', path: '.github/workflows/pr.yml@main' };

test('with TARGET_WORKFLOWS set, only runs that call the central workflow are counted and limited', async () => {
  const { github, store, queue } = makeLimiter({ TARGET_WORKFLOWS: CENTRAL, MAX_JOBS_PER_USER: '2' });
  github.addRun(1, { login: 'alice', ...callsCentral });
  github.addRun(2, { login: 'alice', ...callsCentral, repo: 'acme/api' });
  github.addRun(3, { login: 'alice' }); // some other workflow
  github.addRun(4, { login: 'alice', ...callsCentral, repo: 'acme/mobile' });

  await queue(1, 1);
  await queue(2, 2, { repo: 'api' });
  for (const job of [3, 4, 5, 6]) await queue(job, 3); // ignored, however many jobs it has
  await queue(7, 4, { repo: 'mobile' }); // third central run, across a third repo: over the limit

  assert.equal(store.activeCount('acme/alice'), 2, 'the other workflow did not count');
  assert.deepEqual(github.cancelled, [4]);
  assert.match(github.checkRuns[0].output.summary, /Only jobs in runs that use `acme\/central\/\.github\/workflows\/build\.yml`/);
});

test('a run of the central workflow in its own repo is limited too', async () => {
  const { github, queue } = makeLimiter({ TARGET_WORKFLOWS: CENTRAL, MAX_JOBS_PER_USER: '1' });
  github.addRun(1, { login: 'alice', repo: 'acme/central', path: '.github/workflows/build.yml@main' });
  github.addRun(2, { login: 'alice', ...callsCentral });

  await queue(1, 1, { repo: 'central' });
  await queue(2, 2);

  assert.deepEqual(github.cancelled, [2]);
});

test('runs that do not use a target are left completely alone', async () => {
  const { github, store, log, queue } = makeLimiter({ TARGET_WORKFLOWS: CENTRAL, MAX_JOBS_PER_USER: '0' });
  github.addRun(1, { login: 'alice', calls: ['acme/central/.github/workflows/deploy.yml@main'] });

  await queue(1, 1);

  assert.deepEqual(github.cancelled, []);
  assert.equal(store.stats().trackedJobs, 0);
  assert.equal(log.entries.length, 0);
});

test('workflow_run deliveries are enough to tell whether a run is targeted', async () => {
  const { github, store, queue, runUpdate } = makeLimiter({ TARGET_WORKFLOWS: CENTRAL });

  await runUpdate('requested', 1, { login: 'alice', ...callsCentral });
  await runUpdate('requested', 2, { login: 'alice' });
  await queue(1, 1);
  await queue(2, 2);

  assert.equal(github.lookups, 0);
  assert.equal(store.activeCount('acme/alice'), 1);
});
