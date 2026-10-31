import { sign } from 'node:crypto';

const MAX_RETRIES = 2;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * A minimal GitHub App client: signs the app's JWT, swaps it for installation
 * tokens (cached until shortly before they expire), and calls the few endpoints
 * the limiter needs. No dependencies; it uses the fetch built into Node 20+.
 *
 * Permissions the app needs: Actions (read & write) to look up and cancel runs,
 * and Checks (read & write) to post the explanation.
 */
export class GitHubApp {
  constructor({
    appId,
    privateKey,
    apiUrl = 'https://api.github.com',
    apiVersion = '2026-03-10',
    fetch: fetchImpl = globalThis.fetch,
    now = Date.now,
    retryDelayMs = 500,
  }) {
    this.appId = String(appId);
    this.privateKey = privateKey;
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.apiVersion = apiVersion;
    this.fetch = fetchImpl;
    this.now = now;
    this.retryDelayMs = retryDelayMs;
    /** installationId -> { token, expiresAt } */
    this.tokens = new Map();
    /** installationId -> pending token request, so concurrent calls share one */
    this.pendingTokens = new Map();
  }

  getRunAttempt(installationId, repo, runId, attempt) {
    return this.request(installationId, 'GET', `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}`);
  }

  cancelRun(installationId, repo, runId) {
    return this.request(installationId, 'POST', `/repos/${repo}/actions/runs/${runId}/cancel`);
  }

  getJob(installationId, repo, jobId) {
    return this.request(installationId, 'GET', `/repos/${repo}/actions/jobs/${jobId}`);
  }

  createCheckRun(installationId, repo, checkRun) {
    return this.request(installationId, 'POST', `/repos/${repo}/check-runs`, checkRun);
  }

  /** A short-lived JWT that proves we are the app (RS256, valid for under 10 minutes). */
  appJwt() {
    const nowSeconds = Math.floor(this.now() / 1000);
    const header = base64url({ alg: 'RS256', typ: 'JWT' });
    // Backdate a minute to allow for clock drift between us and GitHub.
    const payload = base64url({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: this.appId });
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), this.privateKey).toString('base64url');
    return `${header}.${payload}.${signature}`;
  }

  async installationToken(installationId) {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()) return cached.token;
    let pending = this.pendingTokens.get(installationId);
    if (!pending) {
      pending = this.send('POST', `/app/installations/${installationId}/access_tokens`, {
        auth: `Bearer ${this.appJwt()}`,
      })
        .then((body) => {
          this.tokens.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
          return body.token;
        })
        .finally(() => this.pendingTokens.delete(installationId));
      this.pendingTokens.set(installationId, pending);
    }
    return pending;
  }

  async request(installationId, method, path, body) {
    if (!installationId) {
      throw new Error('The delivery had no installation id. Is the app installed on the organization?');
    }
    const token = await this.installationToken(installationId);
    try {
      return await this.send(method, path, { auth: `Bearer ${token}`, body });
    } catch (err) {
      if (err.status !== 401) throw err;
      // The token was revoked or expired early: get a fresh one and try once more.
      this.tokens.delete(installationId);
      const fresh = await this.installationToken(installationId);
      return this.send(method, path, { auth: `Bearer ${fresh}`, body });
    }
  }

  /** One HTTP call, retried on network errors and 5xx responses. Errors carry `.status`. */
  async send(method, path, { auth, body } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        res = await this.fetch(`${this.apiUrl}${path}`, {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: auth,
            'x-github-api-version': this.apiVersion,
            'user-agent': 'actions-job-limiter',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          await sleep(this.retryDelayMs * (attempt + 1));
          continue;
        }
        throw err;
      }

      const data = parseBody(await res.text());
      if (res.ok) return data;
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(this.retryDelayMs * (attempt + 1));
        continue;
      }
      const err = new Error(`GitHub ${method} ${path} returned ${res.status}${data?.message ? `: ${data.message}` : ''}`);
      err.status = res.status;
      throw err;
    }
  }
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
