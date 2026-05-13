const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { Job, JobStatus } = require('../src/job');

let GithubActionsOrchestrator;
try {
  GithubActionsOrchestrator = require('../src/github-actions-orchestrator').GithubActionsOrchestrator;
} catch {
  // Module may not be resolvable in all test environments
}

function createMockFetch() {
  let requests = [];

  const mock = async (url, options = {}) => {
    requests.push({ url, method: (options.method || 'GET'), body: options.body });
    return { ok: true, status: 204, text: async () => '', json: async () => ({}) };
  };
  mock.requests = () => requests;
  mock.clear = () => { requests = []; };
  return mock;
}

const describeOrSkip = GithubActionsOrchestrator ? describe : describe.skip;

describeOrSkip('GithubActionsOrchestrator', () => {
  let orch;

  beforeEach(() => {
    orch = new GithubActionsOrchestrator({
      token: 'ghp_test-token',
      owner: 'test-owner',
      repo: 'test-repo',
      fetchFn: createMockFetch(),
      pollIntervalMs: 50,
      tokenSecret: 'test-secret'
    });
  });

  describe('constructor', () => {
    it('should store config from options', () => {
      assert.strictEqual(orch.token, 'ghp_test-token');
      assert.strictEqual(orch.owner, 'test-owner');
      assert.strictEqual(orch.repo, 'test-repo');
      assert.strictEqual(orch.workflowFile, '.github/workflows/open-dispatch-sprite.yml');
      assert.strictEqual(orch.ref, 'main');
      assert.strictEqual(orch.pollIntervalMs, 50);
      assert.strictEqual(orch.agentType, 'claude');
    });

    it('should use env vars as defaults', () => {
      const origToken = process.env.GITHUB_SPRITE_TOKEN;
      const origOwner = process.env.GITHUB_SPRITE_OWNER;
      const origRepo = process.env.GITHUB_SPRITE_REPO;
      process.env.GITHUB_SPRITE_TOKEN = 'env-token';
      process.env.GITHUB_SPRITE_OWNER = 'env-owner';
      process.env.GITHUB_SPRITE_REPO = 'env-repo';

      const o = new GithubActionsOrchestrator({ fetchFn: createMockFetch() });
      assert.strictEqual(o.token, 'env-token');
      assert.strictEqual(o.owner, 'env-owner');
      assert.strictEqual(o.repo, 'env-repo');

      if (origToken) process.env.GITHUB_SPRITE_TOKEN = origToken;
      else delete process.env.GITHUB_SPRITE_TOKEN;
      if (origOwner) process.env.GITHUB_SPRITE_OWNER = origOwner;
      else delete process.env.GITHUB_SPRITE_OWNER;
      if (origRepo) process.env.GITHUB_SPRITE_REPO = origRepo;
      else delete process.env.GITHUB_SPRITE_REPO;
    });
  });

  describe('generateJobToken', () => {
    it('should produce deterministic tokens', () => {
      const token1 = orch.generateJobToken('job-123');
      const token2 = orch.generateJobToken('job-123');
      const token3 = orch.generateJobToken('job-456');

      assert.strictEqual(token1, token2);
      assert.notStrictEqual(token1, token3);
      assert.strictEqual(typeof token1, 'string');
      assert.ok(token1.length > 0);
    });
  });

  describe('unsupported methods', () => {
    it('spawnPersistent should throw', async () => {
      await assert.rejects(
        () => orch.spawnPersistent(),
        /not supported/
      );
    });

    it('wakeSprite should throw', async () => {
      await assert.rejects(
        () => orch.wakeSprite(),
        /not supported/
      );
    });

    it('sendCommand should throw', async () => {
      await assert.rejects(
        () => orch.sendCommand(),
        /not supported/
      );
    });

    it('streamCommand should throw', async () => {
      await assert.rejects(
        () => orch.streamCommand(),
        /not supported/
      );
    });
  });

  describe('spawnJob', () => {
    it('should dispatch workflow and find run', async () => {
      const dispatched = [];
      let currentDispatchId = null;
      let runFound = false;

      const mockFetch = async (url, options = {}) => {
        if (options.method === 'POST') {
          const body = JSON.parse(options.body);
          dispatched.push({ url, body });
          currentDispatchId = body.inputs && body.inputs.dispatch_id;
          return { ok: true, status: 204, text: async () => '', json: async () => ({}) };
        }
        if (url.includes('/actions/runs?event=workflow_dispatch')) {
          if (!runFound) {
            runFound = true;
            return {
              ok: true, status: 200,
              text: async () => '',
              json: async () => ({
                workflow_runs: [{
                  id: 42,
                  event: 'workflow_dispatch',
                  display_title: `claude [${currentDispatchId}]`,
                  created_at: new Date().toISOString(),
                  status: 'queued'
                }]
              })
            };
          }
        }
        if (url.includes('/actions/runs/42') && options.method !== 'POST') {
          return {
            ok: true, status: 200,
            text: async () => '',
            json: async () => ({ id: 42, status: 'completed', conclusion: 'success' })
          };
        }
        return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
      };

      const o = new GithubActionsOrchestrator({
        token: 'test', owner: 'o', repo: 'r', fetchFn: mockFetch,
        pollIntervalMs: 10, tokenSecret: 'sec'
      });

      const job = new Job({ command: 'claude -p "test"', channelId: 'C123', jobToken: 't' });
      const result = await o.spawnJob(job);

      assert.ok(dispatched.length > 0, 'should have dispatched workflow');
      assert.ok(dispatched[0].body.inputs.dispatch_id, 'should include dispatch_id in inputs');
      assert.ok(result.id, 'should return a run id');
      assert.strictEqual(job.status, JobStatus.RUNNING);
      assert.ok(job.machineId);
    });

    it('should handle dispatch failure', async () => {
      const failFetch = async (url, options) => {
        if (options.method === 'POST') {
          return { ok: false, status: 401, text: async () => 'Bad credentials' };
        }
        return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
      };

      const o = new GithubActionsOrchestrator({
        token: 'bad-token', owner: 'o', repo: 'r', fetchFn: failFetch,
        tokenSecret: 'sec'
      });

      const job = new Job({ command: 'test', channelId: 'C123' });
      await assert.rejects(
        () => o.spawnJob(job),
        /GitHub API/
      );
      assert.strictEqual(job.status, JobStatus.FAILED);
    });

    it('should handle missing credentials', async () => {
      const o = new GithubActionsOrchestrator({
        token: '', owner: '', repo: '', fetchFn: createMockFetch(),
        tokenSecret: 'sec'
      });

      const job = new Job({ command: 'test', channelId: 'C123' });
      await assert.rejects(
        () => o.spawnJob(job),
        /required/
      );
    });
  });

  describe('stopSprite', () => {
    it('should POST to cancel endpoint', async () => {
      let capturedUrl = null;
      let capturedMethod = null;

      const mockFetch = async (url, options = {}) => {
        capturedUrl = url;
        capturedMethod = options.method || 'GET';
        return { ok: true, status: 202, text: async () => '', json: async () => ({}) };
      };

      const o = new GithubActionsOrchestrator({
        token: 't', owner: 'o', repo: 'r', fetchFn: mockFetch,
        tokenSecret: 'sec'
      });

      await o.stopSprite('gh-run-123');
      assert.ok(capturedUrl.includes('/actions/runs/123/cancel'));
      assert.strictEqual(capturedMethod, 'POST');
    });

    it('should strip gh-run- prefix', async () => {
      let capturedUrl = null;
      const mockFetch = async (url) => {
        capturedUrl = url;
        return { ok: true, status: 202, text: async () => '', json: async () => ({}) };
      };

      const o = new GithubActionsOrchestrator({
        token: 't', owner: 'o', repo: 'r', fetchFn: mockFetch,
        tokenSecret: 'sec'
      });

      await o.stopSprite('gh-run-456');
      assert.ok(capturedUrl.includes('/runs/456'), 'should strip gh-run- prefix');
    });

    it('should not throw for 202 (accepted)', async () => {
      const mockFetch = async () => ({ ok: true, status: 202, text: async () => '' });
      const o = new GithubActionsOrchestrator({
        token: 't', owner: 'o', repo: 'r', fetchFn: mockFetch,
        tokenSecret: 'sec'
      });

      await o.stopSprite('gh-run-789');
    });
  });

  describe('destroyMachine', () => {
    it('should not throw', async () => {
      await orch.destroyMachine('gh-run-999');
    });
  });

  describe('_findRunId', () => {
    it('should find matching run by dispatch_id', async () => {
      const dispatchId = 'test-dispatch-id-12345';

      const mockFetch = async (url) => ({
        ok: true, status: 200,
        text: async () => '',
        json: async () => ({
          workflow_runs: [{
            id: 100,
            event: 'workflow_dispatch',
            display_title: `claude [${dispatchId}]`,
            created_at: new Date().toISOString(),
            status: 'queued'
          }]
        })
      });

      const o = new GithubActionsOrchestrator({
        token: 't', owner: 'o', repo: 'r', fetchFn: mockFetch,
        tokenSecret: 'sec'
      });

      const runId = await o._findRunId(dispatchId, 5000);
      assert.strictEqual(runId, 100);
    });

    it('should timeout if no run appears', async () => {
      const mockFetch = async () => ({
        ok: true, status: 200,
        text: async () => '',
        json: async () => ({ workflow_runs: [] })
      });

      const o = new GithubActionsOrchestrator({
        token: 't', owner: 'o', repo: 'r', fetchFn: mockFetch,
        tokenSecret: 'sec'
      });

      await assert.rejects(
        () => o._findRunId('test-id', 100),
        /Timed out/
      );
    });

    it('should skip runs without matching dispatch_id', async () => {
      const mockFetch = async (url) => ({
        ok: true, status: 200,
        text: async () => '',
        json: async () => ({
          workflow_runs: [{
            id: 99,
            event: 'workflow_dispatch',
            display_title: 'claude [other-dispatch-id]',
            created_at: new Date().toISOString(),
            status: 'queued'
          }]
        })
      });

      const o = new GithubActionsOrchestrator({
        token: 't', owner: 'o', repo: 'r', fetchFn: mockFetch,
        tokenSecret: 'sec'
      });

      await assert.rejects(
        () => o._findRunId('our-dispatch-id', 100),
        /Timed out/
      );
    });
  });

  describe('_dispatchWorkflow', () => {
    it('should POST to correct URL with inputs', async () => {
      let capturedUrl = null;
      let capturedBody = null;

      const mockFetch = async (url, options = {}) => {
        capturedUrl = url;
        capturedBody = JSON.parse(options.body || '{}');
        return { ok: true, status: 204, text: async () => '' };
      };

      const o = new GithubActionsOrchestrator({
        token: 't', owner: 'my-org', repo: 'my-repo', fetchFn: mockFetch,
        tokenSecret: 'sec'
      });

      await o._dispatchWorkflow({ command: 'claude -p "hello"', agent_type: 'claude' });
      assert.ok(capturedUrl.includes('/repos/my-org/my-repo/actions/workflows/'));
      assert.strictEqual(capturedBody.ref, 'main');
      assert.strictEqual(capturedBody.inputs.command, 'claude -p "hello"');
      assert.strictEqual(capturedBody.inputs.agent_type, 'claude');
    });

    it('should throw on non-204 response', async () => {
      const mockFetch = async () => ({
        ok: false, status: 404, text: async () => 'Not Found'
      });

      const o = new GithubActionsOrchestrator({
        token: 't', owner: 'o', repo: 'r', fetchFn: mockFetch,
        tokenSecret: 'sec'
      });

      await assert.rejects(
        () => o._dispatchWorkflow({ command: 'test', agent_type: 'claude' }),
        /404/
      );
    });
  });

  describe('_ghUrl', () => {
    it('should construct correct API URLs', () => {
      const url = orch._ghUrl('/repos/o/r/actions/runs/1');
      assert.strictEqual(url, 'https://api.github.com/repos/o/r/actions/runs/1');
    });
  });

  describe('_ghHeaders', () => {
    it('should include authorization', () => {
      const headers = orch._ghHeaders();
      assert.strictEqual(headers['Authorization'], 'Bearer ghp_test-token');
      assert.strictEqual(headers['Accept'], 'application/vnd.github+json');
    });
  });
});
