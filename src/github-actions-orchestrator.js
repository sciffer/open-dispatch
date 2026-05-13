const { createHmac, randomUUID } = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

class GithubActionsOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.token = options.token || process.env.GITHUB_SPRITE_TOKEN;
    this.owner = options.owner || process.env.GITHUB_SPRITE_OWNER;
    this.repo = options.repo || process.env.GITHUB_SPRITE_REPO;
    this.workflowFile = options.workflowFile || process.env.GITHUB_SPRITE_WORKFLOW || '.github/workflows/open-dispatch-sprite.yml';
    this.ref = options.ref || process.env.GITHUB_SPRITE_BRANCH || 'main';
    this.pollIntervalMs = options.pollIntervalMs || 5000;
    this.agentType = options.agentType || process.env.SPRITE_AGENT_TYPE || 'claude';
    this.fetchFn = options.fetchFn || fetch;
    this.tokenSecret = options.tokenSecret || process.env.JOB_TOKEN_SECRET || randomUUID();
    this._pollerCleanups = new Map();

    if (!this.token) console.warn('[GithubActionsOrchestrator] Missing GITHUB_SPRITE_TOKEN');
    if (!this.owner) console.warn('[GithubActionsOrchestrator] Missing GITHUB_SPRITE_OWNER');
    if (!this.repo) console.warn('[GithubActionsOrchestrator] Missing GITHUB_SPRITE_REPO');
  }

  _ghUrl(path) {
    return `https://api.github.com${path}`;
  }

  _ghHeaders() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'open-dispatch'
    };
  }

  generateJobToken(jobId) {
    return createHmac('sha256', this.tokenSecret).update(jobId).digest('hex');
  }

  async spawnJob(job) {
    const dispatchTimestamp = Date.now();
    const inputs = {
      command: job.command || '',
      agent_type: this.agentType
    };

    try {
      await this._dispatchWorkflow(inputs);
    } catch (error) {
      job.fail(`Workflow dispatch failed: ${error.message}`);
      this.emit('sprite:error', { job, error });
      throw error;
    }

    let runId;
    try {
      runId = await this._findRunId(dispatchTimestamp);
    } catch (error) {
      job.fail(`Failed to find workflow run: ${error.message}`);
      this.emit('sprite:error', { job, error });
      throw error;
    }

    job.start(`gh-run-${runId}`);
    this.emit('sprite:started', { job, runId });
    this._startPolling(job, runId);

    return { id: `gh-run-${runId}`, state: 'queued' };
  }

  async _dispatchWorkflow(inputs) {
    if (!this.token || !this.owner || !this.repo) {
      throw new Error('GitHub token, owner, and repo are required');
    }

    const encodedFile = encodeURIComponent(this.workflowFile);
    const url = this._ghUrl(`/repos/${this.owner}/${this.repo}/actions/workflows/${encodedFile}/dispatches`);

    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: this._ghHeaders(),
      body: JSON.stringify({ ref: this.ref, inputs })
    });

    if (response.status !== 204) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`GitHub API ${response.status}: ${errorText}`);
    }
  }

  async _findRunId(dispatchTimestamp, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const runs = await this._listRuns();
      const matching = runs
        .filter(r => r.event === 'workflow_dispatch' && new Date(r.created_at).getTime() >= dispatchTimestamp)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      if (matching.length > 0) return matching[0].id;
      await new Promise(r => setTimeout(r, 1000));
    }

    throw new Error('Timed out waiting for workflow run to appear');
  }

  async _listRuns() {
    const url = this._ghUrl(`/repos/${this.owner}/${this.repo}/actions/runs?event=workflow_dispatch&per_page=10`);
    const response = await this.fetchFn(url, { headers: this._ghHeaders() });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`GitHub API ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return data.workflow_runs || [];
  }

  async _getRunStatus(runId) {
    const url = this._ghUrl(`/repos/${this.owner}/${this.repo}/actions/runs/${runId}`);
    const response = await this.fetchFn(url, { headers: this._ghHeaders() });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`GitHub API ${response.status}: ${errorText}`);
    }

    return response.json();
  }

  async _fetchLogs(runId) {
    const url = this._ghUrl(`/repos/${this.owner}/${this.repo}/actions/runs/${runId}/logs`);
    const response = await this.fetchFn(url, { headers: this._ghHeaders() });

    if (!response.ok) {
      console.warn(`[GithubActionsOrchestrator] Failed to fetch logs: ${response.status}`);
      return [];
    }

    const buffer = await response.arrayBuffer();
    return this._extractLogText(Buffer.from(buffer));
  }

  _extractLogText(zipBuffer) {
    const tmpFile = path.join(os.tmpdir(), `gh-logs-${randomUUID().substring(0, 8)}.zip`);
    try {
      fs.writeFileSync(tmpFile, zipBuffer);
      const output = execSync(`unzip -p "${tmpFile}" 2>/dev/null || true`, {
        encoding: 'utf-8',
        timeout: 10000
      });
      return output.split('\n').filter(l => l.trim());
    } catch {
      return [];
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  _startPolling(job, runId) {
    const intervalId = setInterval(async () => {
      try {
        const run = await this._getRunStatus(runId);
        if (run.status !== 'completed') return;

        clearInterval(intervalId);
        this._pollerCleanups.delete(runId);

        const logLines = await this._fetchLogs(runId);
        for (const line of logLines) {
          job.addLog(line);
        }

        const conclusion = run.conclusion;
        if (conclusion === 'success') {
          job.complete(0);
        } else if (conclusion === 'cancelled') {
          job.fail('Workflow was cancelled');
        } else if (conclusion === 'skipped') {
          job.fail('Workflow was skipped');
        } else {
          job.fail(`Workflow failed: ${conclusion || 'unknown'}`, conclusion === 'failure' ? 1 : -1);
        }

        if (job.onComplete) {
          try { await job.onComplete(job); } catch (e) {
            console.error(`[GithubActionsOrchestrator] onComplete error:`, e.message);
          }
        }

        this.emit('sprite:completed', { job, runId });
      } catch (error) {
        console.error(`[GithubActionsOrchestrator] Polling error for run ${runId}:`, error.message);
      }
    }, this.pollIntervalMs);

    this._pollerCleanups.set(runId, intervalId);
  }

  async stopSprite(runId) {
    const numericId = runId.replace(/^gh-run-/, '');
    const url = this._ghUrl(`/repos/${this.owner}/${this.repo}/actions/runs/${numericId}/cancel`);
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: this._ghHeaders()
    });

    if (!response.ok && response.status !== 202) {
      throw new Error(`Failed to cancel run: ${response.status}`);
    }

    this._cleanupPoller(numericId);
  }

  async destroyMachine(runId) {
    this._cleanupPoller(runId.replace(/^gh-run-/, ''));
  }

  _cleanupPoller(runId) {
    const intervalId = this._pollerCleanups.get(runId);
    if (intervalId) {
      clearInterval(intervalId);
      this._pollerCleanups.delete(runId);
    }
  }

  async spawnPersistent() {
    throw new Error('Persistent sessions not supported by GitHub Actions sandbox');
  }

  async wakeSprite() {
    throw new Error('wakeSprite not supported by GitHub Actions sandbox');
  }

  async sendCommand() {
    throw new Error('sendCommand not supported by GitHub Actions sandbox');
  }

  async streamCommand() {
    throw new Error('streamCommand not supported by GitHub Actions sandbox');
  }
}

module.exports = { GithubActionsOrchestrator };
