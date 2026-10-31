const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Everything the limiter remembers, kept in memory.
 *
 * Every method is synchronous on purpose. The limiter checks a person's count and
 * records the new job in one synchronous stretch, so two webhook deliveries can
 * never both see "4 of 5" and both get in. A shared store (Redis, a database) has
 * to keep that guarantee, for example with a Lua script or a transaction.
 */
export class MemoryStore {
  constructor({ now = Date.now, finishedTtlMs = HOUR, runTtlMs = DAY } = {}) {
    this.now = now;
    this.finishedTtlMs = finishedTtlMs;
    this.runTtlMs = runTtlMs;
    /** jobId -> { ownerKey, runKey, repo, installationId, login, checkedAt } */
    this.jobs = new Map();
    /** ownerKey ("org/login") -> Set of jobIds that are queued or running */
    this.byOwner = new Map();
    /** runKey ("runId:attempt") -> { info, decision, flagged, touchedAt } */
    this.runs = new Map();
    /** jobId -> time until which a finished job is remembered, to ignore late deliveries */
    this.finished = new Map();
  }

  getRun(runKey) {
    return this.runs.get(runKey);
  }

  updateRun(runKey, patch) {
    const run = { ...this.runs.get(runKey), ...patch, touchedAt: this.now() };
    this.runs.set(runKey, run);
    return run;
  }

  deleteRun(runKey) {
    this.runs.delete(runKey);
  }

  hasJob(jobId) {
    return this.jobs.has(jobId);
  }

  isFinished(jobId) {
    const until = this.finished.get(jobId);
    return until !== undefined && until > this.now();
  }

  /** Starts counting a queued or running job. Returns false if it's already counted or has finished. */
  addJob(jobId, { ownerKey, runKey, repo, installationId, login }) {
    if (this.jobs.has(jobId) || this.isFinished(jobId)) return false;
    this.jobs.set(jobId, { ownerKey, runKey, repo, installationId, login, checkedAt: this.now() });
    let owned = this.byOwner.get(ownerKey);
    if (!owned) {
      owned = new Set();
      this.byOwner.set(ownerKey, owned);
    }
    owned.add(jobId);
    return true;
  }

  /** Stops counting a job, for example while it waits on an environment approval. */
  removeJob(jobId) {
    const entry = this.jobs.get(jobId);
    if (!entry) return;
    this.jobs.delete(jobId);
    const owned = this.byOwner.get(entry.ownerKey);
    if (!owned) return;
    owned.delete(jobId);
    if (owned.size === 0) this.byOwner.delete(entry.ownerKey);
  }

  /** Stops counting a job for good, and ignores any late "queued" or "in progress" for it. */
  finishJob(jobId) {
    this.removeJob(jobId);
    this.finished.set(jobId, this.now() + this.finishedTtlMs);
  }

  removeRunJobs(runKey) {
    for (const [jobId, entry] of this.jobs) {
      if (entry.runKey === runKey) this.removeJob(jobId);
    }
  }

  activeCount(ownerKey) {
    return this.byOwner.get(ownerKey)?.size ?? 0;
  }

  /** [{ ownerKey, active }] for everyone with at least one queued or running job. */
  activeByOwner() {
    return [...this.byOwner].map(([ownerKey, jobs]) => ({ ownerKey, active: jobs.size }));
  }

  /** Jobs whose status hasn't been confirmed for at least `olderThanMs`. */
  staleJobs(olderThanMs) {
    const cutoff = this.now() - olderThanMs;
    const stale = [];
    for (const [jobId, entry] of this.jobs) {
      if (entry.checkedAt <= cutoff) stale.push({ jobId, ...entry });
    }
    return stale;
  }

  markChecked(jobId) {
    const entry = this.jobs.get(jobId);
    if (entry) entry.checkedAt = this.now();
  }

  /** Forgets expired finished-job markers and old run records that nothing refers to. */
  prune() {
    const now = this.now();
    for (const [jobId, until] of this.finished) {
      if (until <= now) this.finished.delete(jobId);
    }
    const liveRuns = new Set();
    for (const entry of this.jobs.values()) liveRuns.add(entry.runKey);
    for (const [runKey, run] of this.runs) {
      if (run.touchedAt <= now - this.runTtlMs && !liveRuns.has(runKey)) this.runs.delete(runKey);
    }
  }

  stats() {
    return { trackedJobs: this.jobs.size, trackedPeople: this.byOwner.size, trackedRuns: this.runs.size };
  }
}
