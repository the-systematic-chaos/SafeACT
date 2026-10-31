import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileTargets, matchTarget, qualify, splitWorkflowPath } from '../src/workflows.js';

test('splits workflow paths in each shape GitHub uses', () => {
  assert.deepEqual(splitWorkflowPath('.github/workflows/build.yml@main'), { file: '.github/workflows/build.yml', ref: 'main' });
  assert.deepEqual(splitWorkflowPath('octo-org/central/.github/workflows/build.yaml@v2'), {
    file: 'octo-org/central/.github/workflows/build.yaml',
    ref: 'v2',
  });
  assert.deepEqual(splitWorkflowPath('acme/central/.github/workflows/build.yml@feature/a@b'), {
    file: 'acme/central/.github/workflows/build.yml',
    ref: 'feature/a@b',
  });
  assert.deepEqual(splitWorkflowPath('.github/workflows/ci.yml'), { file: '.github/workflows/ci.yml', ref: null });
  assert.deepEqual(splitWorkflowPath('dynamic/dependabot/dependabot-updates'), {
    file: 'dynamic/dependabot/dependabot-updates',
    ref: null,
  });
  assert.equal(splitWorkflowPath(''), null);
  assert.equal(splitWorkflowPath(undefined), null);
  assert.equal(qualify('.github/workflows/ci.yml', 'acme/web'), 'acme/web/.github/workflows/ci.yml');
  assert.equal(qualify('acme/x/.github/workflows/ci.yml', 'acme/web'), 'acme/x/.github/workflows/ci.yml');
});

test('TARGET_WORKFLOWS entries must name the repo and file, without a ref', () => {
  assert.throws(() => compileTargets(['build.yml']), /owner\/repo/);
  assert.throws(() => compileTargets(['.github/workflows/build.yml']), /owner\/repo/);
  assert.throws(() => compileTargets(['acme/central/.github/workflows/build.yml@main']), /without @ref/);
  assert.equal(compileTargets(['acme/central/.github/workflows/build.yml']).length, 1);
});

const targets = compileTargets(['acme/central/.github/workflows/build.yml']);

test('a run that calls the central workflow matches, whatever version it pins', () => {
  for (const call of [
    'acme/central/.github/workflows/build.yml@main',
    'acme/central/.github/workflows/build.yml@v2',
    'acme/central/.github/workflows/build.yml@1595d4b6de6a9e9751fb270a41019ce507d4099e',
    'ACME/Central/.github/workflows/build.yml@main',
  ]) {
    const run = { path: '.github/workflows/pr.yml@main', referenced_workflows: [{ path: call, sha: 'def456' }] };
    const result = matchTarget(run, 'acme/web', targets);
    assert.equal(result.matches, true, call);
    assert.equal(result.calledWorkflow, call);
    assert.equal(result.calledWorkflowSha, 'def456');
    assert.equal(result.ownPath, 'acme/web/.github/workflows/pr.yml');
  }
});

test('the central workflow running in its own repo matches too', () => {
  const relative = matchTarget({ path: '.github/workflows/build.yml@main', head_sha: 'abc' }, 'acme/central', targets);
  assert.equal(relative.matches, true);
  assert.equal(relative.calledWorkflow, 'acme/central/.github/workflows/build.yml@main');
  const full = matchTarget({ path: 'acme/central/.github/workflows/build.yml@main' }, 'acme/central', targets);
  assert.equal(full.matches, true);
});

test('other workflows, and same-named files in other repos, do not match', () => {
  const cases = [
    { path: '.github/workflows/ci.yml@main' },
    { path: '.github/workflows/build.yml@main' }, // build.yml, but in acme/web
    { path: '.github/workflows/pr.yml', referenced_workflows: [{ path: 'acme/central/.github/workflows/deploy.yml@main' }] },
    { path: '.github/workflows/pr.yml', referenced_workflows: [{ path: 'evil/central/.github/workflows/build.yml@main' }] },
    { path: 'dynamic/dependabot/dependabot-updates', referenced_workflows: null },
  ];
  for (const run of cases) assert.equal(matchTarget(run, 'acme/web', targets).matches, false, JSON.stringify(run));
});

test('* matches within one path segment', () => {
  const anyInCentral = compileTargets(['acme/central/.github/workflows/*.yml']);
  const call = (path) => ({ path: '.github/workflows/pr.yml', referenced_workflows: [{ path: `${path}@main` }] });
  assert.equal(matchTarget(call('acme/central/.github/workflows/build.yml'), 'acme/web', anyInCentral).matches, true);
  assert.equal(matchTarget(call('acme/central/.github/workflows/deploy.yml'), 'acme/web', anyInCentral).matches, true);
  assert.equal(matchTarget(call('acme/other/.github/workflows/build.yml'), 'acme/web', anyInCentral).matches, false);

  const buildAnywhere = compileTargets(['acme/*/.github/workflows/build.yml']);
  assert.equal(matchTarget({ path: '.github/workflows/build.yml@main' }, 'acme/web', buildAnywhere).matches, true);
  assert.equal(matchTarget({ path: '.github/workflows/build.yml@main' }, 'globex/web', buildAnywhere).matches, false);
});

test('with no targets every run matches', () => {
  assert.equal(matchTarget({ path: '.github/workflows/ci.yml' }, 'acme/web', []).matches, true);
  assert.equal(matchTarget({}, 'acme/web', []).matches, true);
});
