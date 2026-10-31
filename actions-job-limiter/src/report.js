#!/usr/bin/env node
/**
 * Prints the run log as one row per run, straight from the file. No server needed.
 *
 *   npm run report -- --user alice --since 2026-10-01
 *   npm run report -- --repo acme/web --branch feature-x --format csv > runs.csv
 */
import { parseArgs } from 'node:util';
import { parseRunFilters, readRuns, toCsv } from './runlog.js';

const usage = `Usage: npm run report -- [options]

  --file <path>        run log to read (default: $RUN_LOG_FILE or ./runs.jsonl)
  --user <login>       runs started or re-run by this person
  --repo <owner/repo>  runs in this repository
  --branch <name>      runs on this branch
  --decision <value>   admitted, exempt, would_cancel, cancelled, cancel_failed or already_finished
  --since <date>       requested at or after this time (UTC), e.g. 2026-10-01 or 2026-10-01T09:00:00Z
  --until <date>       requested before this time (UTC)
  --limit <n>          newest n runs only
  --format json|csv    default: json
`;

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      file: { type: 'string' },
      user: { type: 'string' },
      repo: { type: 'string' },
      branch: { type: 'string' },
      decision: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      limit: { type: 'string' },
      format: { type: 'string', default: 'json' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  console.error(`${err.message}\n\n${usage}`);
  process.exit(2);
}

if (args.help) {
  console.log(usage);
  process.exit(0);
}
if (args.format !== 'json' && args.format !== 'csv') {
  console.error(`--format must be json or csv\n\n${usage}`);
  process.exit(2);
}

let filters;
try {
  filters = parseRunFilters((name) => args[name]);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const file = args.file || process.env.RUN_LOG_FILE || 'runs.jsonl';
const rows = await readRuns(file, filters);
process.stdout.write(args.format === 'csv' ? toCsv(rows) : `${JSON.stringify(rows, null, 2)}\n`);
