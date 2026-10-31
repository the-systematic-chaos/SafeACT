import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RunLog } from '../src/runlog.js';
import { recordingLog, tempDir } from './helpers.js';

const run = promisify(execFile);
const REPORT = fileURLToPath(new URL('../src/report.js', import.meta.url));

test('the report command prints the log as JSON or CSV, with filters', async (t) => {
  const file = join(tempDir(t), 'runs.jsonl');
  const runLog = new RunLog({ file, log: recordingLog() });
  for (const [runId, user, branch] of [
    [1, 'alice', 'main'],
    [2, 'bob', 'fix'],
  ]) {
    const key = `${runId}:1`;
    runLog.runSeen(
      key,
      { runId, attempt: 1, user, actor: user, repo: 'acme/web', branch, requestedAt: `2026-10-2${runId}T10:00:00Z` },
      { installationId: 42, repo: 'acme/web' },
    );
    runLog.decision(key, { decision: 'admitted', active: 0, limit: 5 });
  }

  const json = await run(process.execPath, [REPORT, '--file', file, '--user', 'bob']);
  const rows = JSON.parse(json.stdout);
  assert.deepEqual(
    rows.map((row) => [row.runId, row.user, row.branch]),
    [[2, 'bob', 'fix']],
  );

  const csv = await run(process.execPath, [REPORT, '--file', file, '--format', 'csv']);
  const lines = csv.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[1].startsWith('2026-10-22T10:00:00Z,bob'), 'newest first');

  await assert.rejects(run(process.execPath, [REPORT, '--file', file, '--since', 'whenever']), (err) => {
    assert.equal(err.code, 2);
    assert.match(err.stderr, /since must be a date/);
    return true;
  });
});
