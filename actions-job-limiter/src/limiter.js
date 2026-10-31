import { log as defaultLog } from './log.js';
import { matchTarget } from './workflows.js';

/** A run attempt is the unit GitHub can cancel. Re-runs get a new attempt number. */
export const runKey = (runId, attempt) => `${runId}:${attempt ?? 1}`;

const ownerKeyFor = (org, login) => `${org}/${login}`.toLowerCase();

/**
 * Caps how many GitHub Actions jobs each person can have queued or running in an
 * organization, by cancelling runs that would take them over their limit, and
 * records every run it watches in the run log.
 *
 * With TARGET_WORKFLOWS set, it only watches runs that are one of those workflows
 * or call one of them (a reusable workflow in a central repo, say). Every other
 * run is ignored: not counted, not limited, not logged.
 *
 * Jobs are charged to the run's triggering actor (whoever pushed, opened the PR,
 * dispatched or re-ran it). GitHub has no API to cancel a single job, so when
 * someone is over the limit the whole run is cancelled:
 *
 *   soft (default)  A run is checked once, when its first job is queued. If the
 *                   person is already at their limit the run is cancelled;
 *                   otherwise it's let in and all its jobs go ahead, even if that
 *                   takes them past the limit. Work in progress is never cancelled.
 *   hard            Every job is checked when it's queued. A job that would take
 *                   the person past the limit gets its run cancelled, even if the
 *                   run had already started.
 */
export class Limiter {
  constructor({ policy, store, github, runLog = null, log = defaultLog }) {
    this.policy = policy;
    this.store = store;
    this.github = github;
    this.runLog = runLog;
    this.log = log;
    /** runKey -> pending owner lookup, so jobs that arrive together share one API call */
    this.lookups = new Map();
  }

  /** Entry point for a verified webhook delivery. Other events are ignored. */
  async handle(event, payload) {
    if (event === 'workflow_job') return this.onWorkflowJob(payload);
    if (event === 'workflow_run') return this.onWorkflowRun(payload);
  }

  /** workflow_run deliveries say who started a run and which workflows it uses, which saves an API call. */
  onWorkflowRun(payload) {
    const run = payload?.workflow_run;
    if (!run) return;
    const key = runKey(run.id, run.run_attempt);
    const repo = payload.repository?.full_name ?? run.repository?.full_name;
    const info = summarizeRun(run, repo, this.policy.targets);

    if (info?.matches && this.runLog) {
      this.runLog.runSeen(key, info.record, { installationId: payload.installation?.id, repo });
      if (payload.action === 'completed') {
        this.runLog.runDone(key, { conclusion: run.conclusion, completedAt: run.updated_at });
      }
    }
    if (payload.action === 'completed') this.store.deleteRun(key);
    else if (info) this.store.updateRun(key, { info });
  }

  async onWorkflowJob(payload) {
    const job = payload?.workflow_job;
    if (!job || !payload.repository) return;
    switch (payload.action) {
      case 'queued':
      case 'in_progress':
        return this.onJobActive(payload);
      case 'waiting':
        // Parked on an environment approval: not holding a runner, so not counted.
        this.store.removeJob(job.id);
        return;
      case 'completed':
        this.store.finishJob(job.id);
        return;
    }
  }

  async onJobActive(payload) {
    const { action, workflow_job: job, repository, installation } = payload;
    if (this.store.isFinished(job.id)) return;

    const org = repository.owner?.login ?? repository.full_name.split('/')[0];
    const repo = repository.full_name;
    const installationId = installation?.id;
    const attempt = job.run_attempt ?? 1;
    const key = runKey(job.run_id, attempt);

    const info = await this.lookupRun(key, { installationId, repo, runId: job.run_id, attempt });
    if (!info?.matches) return; // owner unknown, or not a workflow this app watches

    if (this.runLog) {
      this.runLog.runSeen(key, info.record, { installationId, repo });
      if (action === 'queued') this.runLog.jobQueued(key, job);
      else this.runLog.jobStarted(key, job);
    }

    // No awaits from here on: checking the count and recording the job happen together.
    const { store, policy } = this;
    if (store.isFinished(job.id) || store.hasJob(job.id)) return;
    const run = store.getRun(key) ?? {};
    if (run.decision === 'rejected' || run.decision === 'exempt') return;

    if (this.isExempt(info)) {
      store.updateRun(key, { decision: 'exempt' });
      this.runLog?.decision(key, { decision: 'exempt' });
      return;
    }

    const ownerKey = ownerKeyFor(org, info.login);
    const limit = this.limitFor(info.login);
    const active = store.activeCount(ownerKey);
    const entry = { ownerKey, runKey: key, repo, installationId, login: info.login };
    const firstJobOfRun = run.decision === undefined;
    // A flagged run was already found over the limit but let through (dry run, or the cancel failed).
    const mustCheck = firstJobOfRun || (policy.mode === 'hard' && !run.flagged);

    if (mustCheck && active >= limit) {
      return this.overLimit({ key, job, org, repo, installationId, info, entry, active, limit });
    }

    store.updateRun(key, { decision: 'admitted' });
    store.addJob(job.id, entry);
    if (firstJobOfRun) {
      this.runLog?.decision(key, { decision: 'admitted', active, limit });
      this.log('debug', 'run let in', { org, repo, user: info.login, runId: job.run_id, attempt, active, limit });
    }
  }

  overLimit(ctx) {
    const { key, job, org, repo, info, entry, active, limit } = ctx;
    const detail = {
      org,
      repo,
      user: info.login,
      workflow: job.workflow_name,
      runId: job.run_id,
      attempt: job.run_attempt ?? 1,
      active,
      limit,
      mode: this.policy.mode,
    };

    if (this.policy.dryRun) {
      // Only note what would have happened. The run really is going ahead, so keep counting it.
      this.store.updateRun(key, { decision: 'admitted', flagged: true });
      this.store.addJob(job.id, entry);
      this.runLog?.decision(key, { decision: 'would_cancel', active, limit, mode: this.policy.mode });
      this.log('info', 'dry run: would cancel run', detail);
      return;
    }

    this.store.updateRun(key, { decision: 'rejected' });
    this.log('info', 'cancelling run: person is over their job limit', detail);
    return this.cancel(ctx, detail);
  }

  async cancel(ctx, detail) {
    const { key, job, repo, installationId, entry, active, limit } = ctx;
    const decided = (decision) => this.runLog?.decision(key, { decision, active, limit, mode: this.policy.mode });
    try {
      await this.github.cancelRun(installationId, repo, job.run_id);
    } catch (err) {
      if (err.status === 409) {
        decided('already_finished');
        this.log('info', 'run had already finished; nothing to cancel', detail);
        return;
      }
      // Fail open: let the run through and count it, and don't retry the cancel for its later jobs.
      this.store.updateRun(key, { decision: 'admitted', flagged: true });
      this.store.addJob(job.id, entry);
      decided('cancel_failed');
      this.log('error', 'could not cancel run; letting it through', { ...detail, error: err.message });
      return;
    }

    // The run is being torn down, so its jobs stop counting now rather than when they report back.
    this.store.removeRunJobs(key);
    decided('cancelled');
    if (!this.policy.explain) return;
    try {
      await this.github.createCheckRun(installationId, repo, explanation(ctx, this.policy));
    } catch (err) {
      this.log('warn', 'run cancelled, but the explanation check could not be posted', {
        ...detail,
        error: err.message,
      });
    }
  }

  lookupRun(key, { installationId, repo, runId, attempt }) {
    const known = this.store.getRun(key)?.info;
    if (known) return known;
    let pending = this.lookups.get(key);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => this.github.getRunAttempt(installationId, repo, runId, attempt))
        .then((run) => {
          const info = summarizeRun(run, repo, this.policy.targets);
          if (info) this.store.updateRun(key, { info });
          return info;
        })
        .catch((err) => {
          this.log('warn', 'could not tell who started this run; not limiting it', {
            repo,
            runId,
            attempt,
            error: err.message,
          });
          return null;
        })
        .finally(() => this.lookups.delete(key));
      this.lookups.set(key, pending);
    }
    return pending;
  }

  isExempt({ login, isBot, event }) {
    const { exemptActors, exemptEvents, userLimits, exemptBots } = this.policy;
    const name = login.toLowerCase();
    if (exemptActors.has(name)) return true;
    if (event && exemptEvents.has(event.toLowerCase())) return true;
    if (userLimits.has(name)) return false; // an explicit limit applies even to a bot
    return exemptBots && isBot;
  }

  limitFor(login) {
    return this.policy.userLimits.get(login.toLowerCase()) ?? this.policy.defaultLimit;
  }

  /** Who is using job slots right now, most first. */
  activeUsers() {
    return this.store
      .activeByOwner()
      .map(({ ownerKey, active }) => {
        const slash = ownerKey.indexOf('/');
        const user = ownerKey.slice(slash + 1);
        return { org: ownerKey.slice(0, slash), user, active, limit: this.limitFor(user) };
      })
      .sort((a, b) => b.active - a.active || a.user.localeCompare(b.user));
  }

  /**
   * Re-checks jobs and runs nothing has been heard about for a while, in case a
   * webhook delivery was lost. Without this, a missed "completed" would eat into
   * someone's limit until the app restarts, and leave a run unfinished in the log.
   */
  async sweep(staleAfterMs) {
    const stale = this.store.staleJobs(staleAfterMs);
    for (const { jobId, repo, installationId } of stale) {
      try {
        const job = await this.github.getJob(installationId, repo, jobId);
        if (job.status === 'completed') this.store.finishJob(jobId);
        else if (job.status === 'queued' || job.status === 'in_progress') this.store.markChecked(jobId);
        else this.store.removeJob(jobId); // waiting on an approval, or pending in a concurrency group
      } catch (err) {
        if (err.status === 404) this.store.finishJob(jobId);
        else this.log('warn', 'could not refresh job status', { repo, jobId, error: err.message });
      }
    }
    this.store.prune();
    const runs = this.runLog ? await this.runLog.sweep(this.github, staleAfterMs) : 0;
    return { jobs: stale.length, runs };
  }
}

/**
 * What the app needs to know about a run, from a workflow_run delivery or the
 * REST API: who to charge, whether it's a watched workflow, and the fields the
 * run log records.
 */
export function summarizeRun(run, repo, targets = []) {
  const actor = run?.triggering_actor ?? run?.actor;
  if (!actor?.login) return null;
  const repoName = repo ?? run.repository?.full_name ?? null;
  const target = matchTarget(run, repoName, targets);
  const attempt = run.run_attempt ?? 1;
  const prs = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  const headRepo = run.head_repository?.full_name ?? null;
  return {
    login: actor.login,
    isBot: actor.type === 'Bot' || actor.login.endsWith('[bot]'),
    event: run.event ?? null,
    matches: target.matches,
    record: {
      runId: run.id,
      attempt,
      org: repoName?.split('/')[0] ?? null,
      repo: repoName,
      workflow: run.name ?? null,
      workflowPath: target.ownPath,
      calledWorkflow: target.calledWorkflow,
      calledWorkflowSha: target.calledWorkflowSha,
      user: actor.login,
      actor: run.actor?.login ?? actor.login,
      event: run.event ?? null,
      branch: run.head_branch ?? null,
      // Set only for pull requests from forks.
      headRepo: headRepo && repoName && headRepo.toLowerCase() !== repoName.toLowerCase() ? headRepo : null,
      prs: prs.map((pr) => pr?.number).filter(Number.isInteger),
      baseBranches: [...new Set(prs.map((pr) => pr?.base?.ref).filter(Boolean))],
      sha: run.head_sha ?? null,
      title: run.display_title ?? null,
      url: run.html_url ?? null,
      // created_at stays put on re-runs; run_started_at resets, so it marks when a re-run was requested.
      requestedAt: (attempt > 1 ? run.run_started_at : run.created_at) ?? run.created_at ?? null,
    },
  };
}

/** The "Job limit" check posted on the commit, so people can see why their run stopped. */
function explanation({ job, org, info, active, limit }, policy) {
  const workflow = job.workflow_name ? `**${job.workflow_name}**` : 'workflow';
  const jobs = active === 1 ? 'job' : 'jobs';
  const lines = [
    `The ${workflow} run was cancelled because ${info.login} already had ${active} ${jobs} queued or running ` +
      `across ${org}, and the limit is ${limit} per person.`,
    '',
    'Re-run it once some of those jobs finish.',
  ];
  if (policy.targets.length) {
    const watched = policy.targets.map((target) => `\`${target.pattern}\``).join(', ');
    lines.push('', `Only jobs in runs that use ${watched} count toward the limit.`);
  }
  if (policy.mode === 'hard') {
    lines.push(
      '',
      `If this workflow on its own needs more than ${limit} jobs at the same time, it can't fit under the limit. ` +
        'Cap its matrix with `strategy.max-parallel`, or ask an admin to raise your limit.',
    );
  }
  return {
    // One check per workflow, so two runs cancelled on the same commit don't hide each other.
    name: job.workflow_name ? `Job limit: ${job.workflow_name}` : 'Job limit',
    head_sha: job.head_sha,
    status: 'completed',
    conclusion: 'neutral',
    output: {
      title: `${info.login} is at the job limit (${active}/${limit})`,
      summary: lines.join('\n'),
    },
  };
}
