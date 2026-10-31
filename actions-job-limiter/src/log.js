const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

/**
 * Writes one JSON object per line, so decisions are easy to grep or ship to a
 * log system. Set LOG_LEVEL=debug to also see every run that was let in.
 */
export function log(level, msg, fields = {}) {
  if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}
