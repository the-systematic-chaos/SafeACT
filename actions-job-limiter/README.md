# Actions job limiter

A small GitHub App that caps how many GitHub Actions jobs each person can have queued or running at once across your organization, and keeps a log of who ran what, from which repo and branch, and when.

It can watch every workflow, or only the ones you name. That makes it a fit for a central repository whose reusable workflow other repos call from their pull requests: the app limits and logs those calls and ignores everything else.

No dependencies. Needs Node 20.6 or later.

## What it does

- **Limits jobs per person, across the org.** Each person can have at most N jobs queued or running at once, counted across every repository. Jobs are charged to whoever triggered the run: the person who pushed, opened the pull request, dispatched the workflow or clicked re-run.
- **Only for the workflows you choose.** With `TARGET_WORKFLOWS` set, only runs that are, or call, one of those workflows are counted, limited and logged.
- **Logs every watched run.** Who triggered it and who started the original run, the calling repo, branch, pull request and target branch, which version of your workflow it called, when it was requested, started and finished, how many jobs it created, what the limiter decided, and how it ended.
- **Explains itself.** When it cancels a run, it posts a **Job limit** check on the commit saying why.

GitHub can only cancel whole runs, not single jobs, so a run is what gets cancelled.

## Limiting only your central workflow

A reusable workflow runs as part of the calling repository's run. The run, its jobs, its billing and its webhooks all belong to the repo that made the call, not to the central repo. So the app is installed on the calling repos, and told which workflow to watch:

```bash
TARGET_WORKFLOWS=acme/central/.github/workflows/build.yml
```

A run is watched when either:

- its own workflow file is that one (the central repo running it directly), or
- its `referenced_workflows` include that file, at any branch, tag or commit SHA (another repo calling it with `uses: acme/central/.github/workflows/build.yml@main`).

Everything else is ignored: not counted, not limited, not logged. You can list several workflows separated by commas, and use `*` within one path segment, for example `acme/central/.github/workflows/deploy-*.yml` or `acme/*/.github/workflows/build.yml`. Leave `TARGET_WORKFLOWS` unset to watch every workflow.

The count is per person across all watched runs. With a limit of 5, alice can have 5 jobs from runs of your workflow queued or running at once, whether they come from one repo or ten. Jobs in a calling workflow that aren't part of your workflow still count if they're in the same run, because GitHub's job events don't say which workflow file a job came from.

## How the limit is enforced

| | `MODE=soft` (default) | `MODE=hard` |
|---|---|---|
| When it checks | Each run once, when its first job is queued | Every job, when it's queued |
| What it cancels | New runs that start while you're at your limit | Any run with a job that would take you over |
| Can someone go past N? | Yes, by the size of their last admitted run | No |
| Cancels work in progress? | Never | Yes, for example when a later stage of a run queues |
| A run that needs more than N jobs at once | Goes ahead if you're under N when it starts | Never fits; cap its matrix with `strategy.max-parallel` |

Jobs waiting on an environment approval don't count until they start.

## Set up

1. **Create the app.** In your organization: **Settings → Developer settings → GitHub Apps → New GitHub App**.
   - **Webhook URL:** wherever you'll run this, ending in `/webhook`. **Webhook secret:** a long random string.
   - **Repository permissions:** Actions: *Read and write* (to look up and cancel runs). Checks: *Read and write* (for the explanation; optional).
   - **Subscribe to events:** *Workflow job* and *Workflow run*.
   - **Where can this GitHub App be installed:** *Only on this account*.
2. **Generate a private key** on the app's settings page, and note the App ID.
3. **Install the app** on the organization with access to **All repositories**, or at least to every repository that calls your workflow. Installing it on the central repo alone isn't enough, because the calls run in the callers' repos.
4. **Run it** somewhere GitHub can reach:

   ```bash
   cp .env.example .env   # fill in the app ID, key path, webhook secret, TARGET_WORKFLOWS and ADMIN_TOKEN
   npm start              # or, with the variables already in the environment: node src/index.js
   ```

   To try it from a laptop, forward deliveries through a tunnel such as [smee.io](https://smee.io) and use that as the webhook URL.

## Roll out in dry run

The app starts with `DRY_RUN=true`. It counts and logs everything, and records each run it *would* cancel as `would_cancel`, but cancels nothing:

```json
{"time":"2026-10-29T18:04:11.201Z","level":"info","msg":"dry run: would cancel run","org":"acme","repo":"acme/web","user":"alice","workflow":"PR checks","runId":18123456789,"attempt":1,"active":5,"limit":5,"mode":"soft"}
```

Leave it running for a few days. Check with `GET /runs?decision=would_cancel` that the right runs are being watched and who would have been stopped, adjust `MAX_JOBS_PER_USER` and `USER_LIMITS`, then set `DRY_RUN=false`.

## The run log

Every watched run is appended to `RUN_LOG_FILE` (default `runs.jsonl`), and can be read back as one row per run attempt:

| Field | Meaning |
|---|---|
| `user` | Who triggered this attempt: the pusher, the PR author, or whoever clicked re-run. The limit is charged to them |
| `actor` | Who started the original run. Differs from `user` on re-runs |
| `repo`, `org` | The calling repository |
| `branch` | The branch the run is for. For a pull request, its source branch |
| `baseBranches`, `prs` | The pull request's number and target branch, when GitHub lists one. Empty for PRs from forks |
| `headRepo` | The fork a pull request came from, if it came from one |
| `event` | What triggered it: `pull_request`, `push`, `workflow_dispatch`... |
| `workflow`, `workflowPath` | The calling workflow's name and file |
| `calledWorkflow`, `calledWorkflowSha` | Which of your workflows it used, at which ref and commit |
| `requestedAt` | When this attempt was requested (UTC) |
| `startedAt` | When its first job started on a runner |
| `completedAt`, `durationSeconds` | When it finished, and how long from request to finish |
| `jobs` | How many jobs it created |
| `decision` | `admitted`, `exempt`, `would_cancel`, `cancelled`, `cancel_failed` or `already_finished` |
| `active`, `limit` | How many jobs the person already had when the decision was made, and their limit |
| `conclusion` | `success`, `failure`, `cancelled`... or `deleted` if the run was deleted before the app saw it finish |
| `title`, `url`, `sha` | The PR title or commit message, a link to the run, and the commit |

### Reading it

Set `ADMIN_TOKEN` (at least 16 characters) to turn on the two read endpoints:

```bash
# The newest 1000 runs, as JSON
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://limiter.example.com/runs

# One person's runs this month, as a spreadsheet
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://limiter.example.com/runs?user=alice&since=2026-10-01&format=csv" -o alice.csv

# Runs on one branch of one repo, and runs the limiter cancelled
curl -H "Authorization: Bearer $ADMIN_TOKEN" "https://limiter.example.com/runs?repo=acme/web&branch=feature-x"
curl -H "Authorization: Bearer $ADMIN_TOKEN" "https://limiter.example.com/runs?decision=cancelled"

# Who is using job slots right now
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://limiter.example.com/active
```

`/runs` filters: `user` (matches `user` or `actor`), `repo`, `branch`, `decision`, `since`, `until` (dates or times, UTC), `limit` (default 1000, up to 100000), and `format=json|csv`. Rows are newest first.

Or read the file directly on the server, no endpoint needed:

```bash
npm run report -- --user alice --since 2026-10-01
npm run report -- --repo acme/web --format csv > runs.csv
```

### The file

Each line is one JSON event: `run` (written once per attempt), `job`, `job_started`, `decision` and `done`. Rows are built from these when you read them, so the file is safe to read while the app is writing, and a crash loses at most the line being written. Rotate it with logrotate's `copytruncate`. After a restart, the app reads the last week of the file to find runs that hadn't finished, and asks GitHub how they ended.

The log holds usernames, branch names and pull request titles. Keep the file and `ADMIN_TOKEN` private, and serve the app over HTTPS.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_APP_ID` | required | |
| `GITHUB_APP_PRIVATE_KEY_PATH` or `GITHUB_APP_PRIVATE_KEY` | required | Path to the `.pem` file, or its text with newlines written as `\n` |
| `GITHUB_WEBHOOK_SECRET` | required | Must match the secret on the app |
| `TARGET_WORKFLOWS` | all workflows | Only limit and log runs that are, or call, these workflows. `owner/repo/.github/workflows/file.yml`, comma-separated, `*` allowed |
| `MAX_JOBS_PER_USER` | `5` | Queued plus running jobs per person, per organization |
| `USER_LIMITS` | none | Exceptions, for example `release-captain=20,renovate[bot]=3` |
| `MODE` | `soft` | `soft` or `hard`, see above |
| `DRY_RUN` | `true` | Log instead of cancelling |
| `EXPLAIN_WITH_CHECK_RUN` | `true` | Post a Job limit check on the commit when a run is cancelled |
| `EXEMPT_BOTS` | `true` | Don't limit bot accounts unless they're listed in `USER_LIMITS`. They're still logged |
| `EXEMPT_ACTORS` | none | Logins that are never limited. Still logged |
| `EXEMPT_EVENTS` | `schedule` | Triggers that are never limited. Set it to empty to limit everything |
| `RUN_LOG_FILE` | `runs.jsonl` | Where the run log goes. Set it to empty to turn the log off |
| `ADMIN_TOKEN` | none | Turns on `GET /runs` and `GET /active` |
| `PORT` | `3000` | |
| `LOG_LEVEL` | `info` | `debug` also logs every run that's let in |
| `SWEEP_INTERVAL_SECONDS`, `STALE_AFTER_SECONDS` | `300`, `900` | How often to re-check jobs and runs the app hasn't heard about lately |
| `GITHUB_API_URL` | `https://api.github.com` | For GitHub Enterprise Server: `https://HOSTNAME/api/v3` |
| `GITHUB_API_VERSION` | `2026-03-10` | Older Enterprise Server versions may need `2022-11-28` |

## Things to know

- **Callers can't opt out by pinning.** Runs are matched on the workflow file, whatever branch, tag or SHA they call it at, and `calledWorkflow` records which one they used. They can avoid the app only by not calling your workflow at all.
- **Nested calls.** GitHub describes `referenced_workflows` as the workflows reused by the caller. If some repos reach your workflow through another reusable workflow, check in dry run that their runs show up in `/runs`.
- **Pull request details are best effort.** The PR number and target branch come from the list of open pull requests GitHub attaches to a run, which is empty for pull requests from forks. `branch` comes from the run itself, and `headRepo` names the fork.
- **State lives in memory, so run one instance.** A restart forgets the counts, which fails open: people get extra room until their current jobs finish. The run log survives restarts. To run several instances, back `MemoryStore` with Redis and keep the check-and-record step atomic, and give each instance its own log file or move the log to a database.
- **Missed webhooks get caught up.** GitHub doesn't retry failed deliveries on its own. Every 5 minutes the app asks GitHub about any job or run it hasn't heard about for 15 minutes, so a lost "completed" can't eat into someone's limit or leave a run unfinished in the log. You can also redeliver failures from the app's **Advanced** settings.
- **Exempting bots leaves a gap.** Runs started with `GITHUB_TOKEN`, such as a workflow that dispatches other workflows, are charged to `github-actions[bot]`. If that matters, give the bot its own cap in `USER_LIMITS`.
- **When in doubt, it lets the run through.** If the app can't tell who started a run, or GitHub refuses the cancel, the run goes ahead and the reason is logged.
- **Guard the private key.** With Actions write access, the app can cancel any run in any repository it's installed on.

## Tests

```bash
npm test
```

The suite covers the limit (soft and hard modes, dry run, exemptions, per-person limits, simultaneous deliveries racing for the last slot, late or duplicate deliveries, re-runs, failed cancels, the sweeper), workflow targeting (calls at any ref, the central repo's own runs, patterns, everything else ignored), the run log (every field above, re-runs, forks, filters, CSV escaping, recovering runs whose completion was missed across a restart), the report command, the GitHub client (JWT signing, token caching and refresh, retries), and an end-to-end run: signed webhooks into the server, a mock GitHub API that checks the app's JWT and token, only the central workflow's run cancelled, and the result read back through `/runs` and `/active`.

## Files

| File | What's in it |
|---|---|
| `src/limiter.js` | The decisions: who to charge, which runs to watch, when to cancel, the sweeper |
| `src/workflows.js` | Matching runs to `TARGET_WORKFLOWS` |
| `src/runlog.js` | Writing the run log and reading it back as rows, JSON or CSV |
| `src/store.js` | In-memory counts per person |
| `src/github.js` | App authentication and the four API calls it uses |
| `src/server.js` | Webhook endpoint, signature check, `/runs`, `/active`, `/healthz` |
| `src/report.js` | `npm run report`: the run log from the command line |
| `src/config.js` | Environment variables |
| `src/index.js` | Wiring, the sweep timer, shutdown |
