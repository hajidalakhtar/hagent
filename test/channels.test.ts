// test/channels.test.ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../src/config.ts';
import { A2AServer } from '../src/a2a/server.ts';
import { DurableAgent } from '../src/agent/durable-agent.ts';
import { GitHubChannel, matchesMention, verifySignature } from '../src/channels/github.ts';
import { loadChannelsConfig, resolveEnvRef, resolveGithubChannelConfig } from '../src/channels/config.ts';
import { resolveChannelPrompt } from '../src/channels/prompt-rules.ts';
import { WorktreeManager } from '../src/sandbox/worktree.ts';
import { DurableStore } from '../src/store/durable-store.ts';

const testDb = resolve('./data/test_channels.db');
const testWorktrees = resolve('./data/test_channel_worktrees');
const testCfgDir = resolve('./data/test_channels_cfg');
const SECRET = 'webhook-secret';

try {
  rmSync(testDb, { force: true });
  rmSync(testDb + '-wal', { force: true });
  rmSync(testDb + '-shm', { force: true });
  rmSync(testWorktrees, { recursive: true, force: true });
  rmSync(testCfgDir, { recursive: true, force: true });
} catch {}
mkdirSync(testCfgDir, { recursive: true });
writeFileSync(resolve(testCfgDir, 'review.md'), 'You are a senior code reviewer. Review the diff.');
writeFileSync(
  resolve(testCfgDir, 'channels.json'),
  JSON.stringify({
    github: {
      webhook_path: '/channels/github',
      secret: 'env:TEST_WEBHOOK_SECRET',
      token: 'env:GITHUB_TOKEN',
      mentions: ['hagent'],
      bot_login: 'hagent-bot',
      git_auth: false,
      triggers: { mention: true, label_added: ['review'] },
      default_system_prompt: 'You are the default channel assistant.',
      label_prompts: {
        review: './review.md',
        bug: { system_prompt: 'You are a bug triage assistant.', reply_header: '### 🐞 triage' },
      },
    },
  })
);

process.env.TEST_WEBHOOK_SECRET = SECRET;
process.env.GITHUB_TOKEN = 'test-token';

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await Bun.sleep(15);
  }
}

function issueCommentPayload(overrides: Record<string, any> = {}) {
  return {
    action: 'created',
    repository: {
      full_name: 'acme/widget',
      clone_url: 'https://github.com/acme/widget.git',
      html_url: 'https://github.com/acme/widget',
      default_branch: 'main',
    },
    issue: {
      id: 42,
      number: 7,
      title: 'Crash on startup',
      body: 'It crashes when I run bun start.',
      user: { login: 'alice' },
      labels: [{ name: 'bug' }],
      html_url: 'https://github.com/acme/widget/issues/7',
    },
    comment: {
      id: 111,
      body: '@hagent can you look into this crash?',
      user: { login: 'alice' },
    },
    sender: { login: 'alice' },
    ...overrides,
  };
}

function signedRequest(payload: unknown, opts: { event?: string; delivery?: string; secret?: string } = {}) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': opts.event || 'issue_comment',
    'x-github-delivery': opts.delivery || crypto.randomUUID(),
  };
  const secret = opts.secret ?? SECRET;
  if (secret !== 'none') {
    headers['x-hub-signature-256'] = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  }
  return new Request('http://localhost/channels/github', { method: 'POST', headers, body: raw });
}

describe('Channels config & prompt rules', () => {
  it('loads channels.json, expands env refs and resolves label prompt files', () => {
    const cfg = loadChannelsConfig(resolve(testCfgDir, 'channels.json'));
    expect(cfg.github).toBeDefined();

    const resolved = resolveGithubChannelConfig(cfg.github!, testCfgDir);
    expect(resolved.secret).toBe(SECRET);
    expect(resolved.token).toBe('test-token');
    expect(resolved.mentions).toContain('hagent');
    expect(resolved.labelPrompts.review!.system_prompt).toContain('senior code reviewer');
    expect(resolved.labelPrompts.bug!.reply_header).toBe('### 🐞 triage');
    expect(resolved.triggers.labelAdded).toContain('review');
  });

  it('returns no channels when the config file is missing', () => {
    const cfg = loadChannelsConfig(resolve(testCfgDir, 'does_not_exist.json'));
    expect(cfg.github).toBeUndefined();
    expect(resolveEnvRef('env:NOPE_UNSET')).toBe('');
    expect(resolveEnvRef('literal-value')).toBe('literal-value');
  });

  it('picks the system prompt by label, first configured label wins', () => {
    const labelPrompts = { review: 'REVIEW PROMPT', bug: 'BUG PROMPT' };

    const noMatch = resolveChannelPrompt({ labels: ['docs'], labelPrompts, baseDir: testCfgDir });
    expect(noMatch.systemPrompt).not.toBe('REVIEW PROMPT');
    expect(noMatch.matchedLabel).toBeUndefined();

    const review = resolveChannelPrompt({ labels: ['help wanted', 'Review'], labelPrompts, baseDir: testCfgDir });
    expect(review.systemPrompt).toBe('REVIEW PROMPT');
    expect(review.matchedLabel).toBe('review');

    const fileBased = resolveChannelPrompt({
      labels: ['review'],
      labelPrompts: { review: './review.md' },
      baseDir: testCfgDir,
    });
    expect(fileBased.systemPrompt).toContain('senior code reviewer');
  });
});

describe('GitHub channel: mention & signature helpers', () => {
  it('detects mentions, including handles with suffixes', () => {
    expect(matchesMention('hey @hagent please help', ['hagent'])).toBe(true);
    expect(matchesMention('cc @hagent-bot', ['hagent'])).toBe(true);
    expect(matchesMention('no mention here', ['hagent'])).toBe(false);
    expect(matchesMention('@other user', ['hagent'])).toBe(false);
    expect(matchesMention(undefined, ['hagent'])).toBe(false);
  });

  it('verifies HMAC-SHA256 webhook signatures', () => {
    const body = '{"action":"created"}';
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifySignature(SECRET, body, sig)).toBe(true);
    expect(verifySignature(SECRET, body, 'sha256=deadbeef')).toBe(false);
    expect(verifySignature(SECRET, body, null)).toBe(false);
    expect(verifySignature('other', body, sig)).toBe(false);
  });
});

describe('GitHub channel: webhook -> task -> reply', () => {
  const store = new DurableStore(testDb);
  const worktreeMgr = new WorktreeManager(testWorktrees);
  // Concurrency 0 keeps channel tasks PENDING — no clone, no LLM calls in tests.
  const agent = new DurableAgent(store, worktreeMgr, 0);

  const cfg = resolveGithubChannelConfig(loadChannelsConfig(resolve(testCfgDir, 'channels.json')).github!, testCfgDir);

  const posted: Array<{ url: string; body: any }> = [];
  const fetchMock: typeof fetch = async (url, init) => {
    posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ id: 999 }), { status: 201 });
  };

  const channel = new GitHubChannel({ config: cfg, store, agent }, fetchMock);
  channel.start();

  it('rejects webhooks with a bad signature', async () => {
    const res = await channel
      .routes[0]!.handle(
        signedRequest(issueCommentPayload(), { secret: 'none' }),
        new URL('http://localhost/channels/github')
      );
    expect(res.status).toBe(401);
    expect(store.listTasks(100).length).toBe(0);
  });

  it('ignores comments without a mention of the bot', async () => {
    const payload = issueCommentPayload({ comment: { id: 112, body: 'just chatting', user: { login: 'alice' } } });
    const res = (await channel.routes[0]!.handle(signedRequest(payload), new URL('http://localhost/channels/github'))) as Response;
    const data = (await res.json()) as any;
    expect(data.handled).toBe(false);
    expect(store.listTasks(100).length).toBe(0);
  });

  let mentionTaskId = '';

  it('creates a cloned-repo task with the label system prompt when tagged', async () => {
    const delivery = crypto.randomUUID();
    const res = (await channel.routes[0]!.handle(
      signedRequest(issueCommentPayload(), { delivery }),
      new URL('http://localhost/channels/github')
    )) as Response;
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.task_id).toBeDefined();

    const task = store.getTask(data.task_id)!;
    mentionTaskId = task.id;
    expect(task.channel).toBe('github');
    expect(task.channel_ref).toBe(`github:${delivery}`);
    expect(task.repo_url).toBe('https://github.com/acme/widget.git');
    expect(task.base_branch).toBe('main');
    expect(task.no_push).toBe(true);
    expect(task.system_prompt_mode).toBe('replace');
    // label "bug" -> bug triage prompt with its reply header
    expect(task.system_prompt).toBe('You are a bug triage assistant.');
    expect(task.prompt).toContain('@hagent can you look into this crash?');
    expect(task.prompt).toContain('Crash on startup');
    expect(task.artifacts[0]!.metadata).toMatchObject({ owner: 'acme', repo: 'widget', number: 7 });

    // concurrency 0 => task stays queued, nothing executed
    expect(task.status).toBe('PENDING');
  });

  it('dedupes redeliveries of the same webhook', async () => {
    const delivery = crypto.randomUUID();
    const first = (await channel.routes[0]!.handle(
      signedRequest(issueCommentPayload(), { delivery }),
      new URL('http://localhost/channels/github')
    )) as Response;
    const firstData = (await first.json()) as any;

    const second = (await channel.routes[0]!.handle(
      signedRequest(issueCommentPayload(), { delivery }),
      new URL('http://localhost/channels/github')
    )) as Response;
    const secondData = (await second.json()) as any;

    expect(secondData.duplicate).toBe(true);
    expect(secondData.task_id).toBeUndefined();
    expect(store.getTask(firstData.task_id)).not.toBeNull();
    expect(store.listChannelTasks('github').length).toBe(1 + 1); // mention task + this one
  });

  it('ignores our own bot comments (loop guard)', async () => {
    const payload = issueCommentPayload({
      comment: { id: 900, body: '@hagent ping <!-- hagent:task:gh_x -->', user: { login: 'hagent-bot' } },
      sender: { login: 'hagent-bot' },
    });
    const res = (await channel.routes[0]!.handle(signedRequest(payload), new URL('http://localhost/channels/github'))) as Response;
    const data = (await res.json()) as any;
    expect(data.handled).toBe(false);
    expect(store.listChannelTasks('github').length).toBe(2);
  });

  let labelTaskId = '';

  it('responds when a trigger label is added and uses the matching label prompt', async () => {
    const payload = {
      action: 'labeled',
      label: { name: 'review' },
      repository: issueCommentPayload().repository,
      pull_request: {
        id: 555,
        number: 12,
        title: 'Add retry logic',
        body: 'Implements retries.',
        user: { login: 'bob' },
        labels: [{ name: 'review' }],
        html_url: 'https://github.com/acme/widget/pull/12',
        base: { ref: 'develop' },
        head: { ref: 'feature/retry' },
        changed_files: 3,
        additions: 120,
        deletions: 10,
      },
      sender: { login: 'bob' },
    };
    const res = (await channel.routes[0]!.handle(
      signedRequest(payload, { event: 'pull_request' }),
      new URL('http://localhost/channels/github')
    )) as Response;
    const data = (await res.json()) as any;
    expect(data.handled).toBe(true);

    const task = store.getTask(data.task_id)!;
    labelTaskId = task.id;
    expect(task.system_prompt).toContain('senior code reviewer');
    expect(task.base_branch).toBe('develop');
    expect(task.prompt).toContain('Head branch: feature/retry');
  });

  it('posts the final answer back as a GitHub comment exactly once', async () => {
    const task = store.getTask(mentionTaskId)!;
    expect(task.reply_state).toBeUndefined();

    store.updateTaskStatus(mentionTaskId, 'COMPLETED', undefined, 'The crash comes from src/main.ts:12 — null env var.');
    agent.emitA2AEvent({
      event: 'done',
      task_id: mentionTaskId,
      timestamp: Date.now(),
      data: { status: 'COMPLETED', summary: 'The crash comes from src/main.ts:12 — null env var.' },
    });
    // duplicate terminal event must not double-post
    agent.emitA2AEvent({
      event: 'done',
      task_id: mentionTaskId,
      timestamp: Date.now(),
      data: { status: 'COMPLETED', summary: 'dup' },
    });

    await waitFor(() => store.getTask(mentionTaskId)!.reply_state === 'posted');
    await Bun.sleep(50);

    expect(posted.length).toBe(1);
    expect(posted[0]!.url).toBe('https://api.github.com/repos/acme/widget/issues/7/comments');
    expect(posted[0]!.body.body).toContain('null env var');
    expect(posted[0]!.body.body).toContain(`<!-- hagent:task:${mentionTaskId} -->`);
    expect(store.getTask(mentionTaskId)!.reply_state).toBe('posted');
  });

  it('reconciles replies for tasks that finished while the process was down', async () => {
    // Simulate a crash: task completed, no reply recorded, no live listener.
    store.updateTaskStatus(labelTaskId, 'COMPLETED', undefined, 'Review posted in final message.');
    expect(store.getTask(labelTaskId)!.reply_state).toBeUndefined();

    const restarted = new GitHubChannel({ config: cfg, store, agent }, fetchMock);
    restarted.start();

    await waitFor(() => store.getTask(labelTaskId)!.reply_state === 'posted');
    const last = posted.at(-1)!;
    expect(last.url).toBe('https://api.github.com/repos/acme/widget/issues/12/comments');
    expect(last.body.body).toContain('Review posted in final message.');
    restarted.stop();
  });

  it('reports channel metadata on GET', async () => {
    const res = (await channel.routes[0]!.handle(
      new Request('http://localhost/channels/github'),
      new URL('http://localhost/channels/github')
    )) as Response;
    const info = (await res.json()) as any;
    expect(info.channel).toBe('github');
    expect(info.mentions).toContain('hagent');
    expect(info.label_prompts).toEqual(['review', 'bug']);
  });
});

describe('A2A server routes channel webhooks', () => {
  const store = new DurableStore(resolve('./data/test_channels_router.db'));
  const agent = new DurableAgent(store, new WorktreeManager(resolve('./data/test_channels_router_wt')), 0);
  const cfg = resolveGithubChannelConfig(
    { secret: SECRET, token: 'test-token', mentions: ['hagent'], git_auth: false },
    testCfgDir
  );
  const channel = new GitHubChannel({ config: cfg, store, agent });
  channel.start();

  const previousPort = config.port;
  config.port = 0;
  const server = new A2AServer(store, agent, [channel]).start();
  config.port = previousPort;

  it('answers the webhook path and lists channels', async () => {
    const list = await server.fetch(new Request('http://localhost/channels'));
    expect(list.status).toBe(200);
    const channels = (await list.json()) as any[];
    expect(channels[0]!.name).toBe('github');

    const res = await server.fetch(signedRequest(issueCommentPayload(), { secret: SECRET }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.task_id).toBeDefined();
    expect(store.getTask(data.task_id)!.channel).toBe('github');

    const info = await server.fetch(new Request('http://localhost/channels/github'));
    expect((await info.json()).channel).toBe('github');
  });

  it('still serves regular A2A endpoints', async () => {
    const res = await server.fetch(new Request('http://localhost/.well-known/agent.json'));
    expect(res.status).toBe(200);
  });

  server.stop(true);
  channel.stop();
});
