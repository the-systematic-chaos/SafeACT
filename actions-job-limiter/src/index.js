import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { GitHubApp } from './github.js';
import { Limiter } from './limiter.js';
import { log } from './log.js';
import { RunLog } from './runlog.js';
import { createServer } from './server.js';
import { MemoryStore } from './store.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const { policy } = config;
const runLogFile = config.runLogFile ? resolve(config.runLogFile) : null;
const store = new MemoryStore();
const github = new GitHubApp(config);
const runLog = runLogFile ? new RunLog({ file: runLogFile, log }) : null;
if (runLog) {
  // Pick up runs that were still going when the app last stopped, so their ending gets recorded.
  const open = await runLog.load();
  if (open) log('info', 'resuming unfinished runs from the run log', { open });
}
const limiter = new Limiter({ policy, store, github, runLog, log });
const server = createServer({
  webhookSecret: config.webhookSecret,
  limiter,
  store,
  policy,
  log,
  runLogFile,
  adminToken: config.adminToken,
});

server.listen(config.port, () => {
  log('info', policy.dryRun ? 'listening in dry-run mode: nothing will be cancelled' : 'listening and enforcing limits', {
    port: server.address().port,
    mode: policy.mode,
    defaultLimit: policy.defaultLimit,
    userLimits: Object.fromEntries(policy.userLimits),
    targets: policy.targets.length ? policy.targets.map((target) => target.pattern) : 'all workflows',
    runLog: runLogFile ?? 'off',
    adminEndpoints: config.adminToken ? 'on' : 'off (set ADMIN_TOKEN)',
  });
});

// Catch up on webhook deliveries that never arrived (see Limiter#sweep).
const sweeper = setInterval(() => {
  limiter.sweep(config.staleAfterMs).catch((err) => log('error', 'sweep failed', { error: err.message }));
}, config.sweepIntervalMs);
sweeper.unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    log('info', 'shutting down', { signal });
    clearInterval(sweeper);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
