// src/channels/github.ts
// Channel 1: GitHub bot.
//
// Flow: user tags the bot in an issue/PR comment (or adds a trigger label)
//   -> webhook hits POST /channels/github
//   -> agent task is created: the repo is cloned into a worktree, analyzed
//   -> the final answer is posted back as a reply on the same thread.
//
// Which system prompt runs is decided by channels.json (default prompt, or a
// per-label prompt such as label "review" -> code review prompt).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config as globalConfig } from '../config.ts';
import type { A2AEvent, A2ATask } from '../types.ts';
import type { DurableAgent } from '../agent/durable-agent.ts';
import type { DurableStore } from '../store/durable-store.ts';
import type { ResolvedGithubConfig } from './config.ts';
import { resolveChannelPrompt } from './prompt-rules.ts';
import type { Channel, ChannelRoute } from './types.ts';

const REPLY_MARKER = '<!-- hagent:task:';
const GITHUB_MAX_COMMENT = 65536;

// --- pure helpers (exported for tests) ---

export function verifySignature(secret: string, rawBody: string, header: string | null | undefined): boolean {
  if (!header) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function matchesMention(body: string | undefined, mentions: string[]): boolean {
  if (!body || mentions.length === 0) return false;
  const alternatives = mentions
    .filter(Boolean)
    .map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  if (alternatives.length === 0) return false;
  return new RegExp(`@(?:${alternatives.join('|')})\\b`, 'i').test(body);
}

export function parseWebhookPayload(raw: string, contentType: string | null): any {
  if ((contentType || '').includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw);
    const payload = params.get('payload');
    if (!payload) throw new Error('Missing "payload" field in form body');
    return JSON.parse(payload);
  }
  return JSON.parse(raw);
}

function truncate(text: string, limit: number): string {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text;
}

function labelsOf(node: any): string[] {
  if (!node?.labels) return [];
  return node.labels.map((l: any) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
}

function fullName(repo: any): string {
  return repo?.full_name || `${repo?.owner?.login || 'unknown'}/${repo?.name || 'unknown'}`;
}

// --- target model ---

interface GithubTarget {
  owner: string;
  repo: string;
  number: number;
  kind: 'issue' | 'pull_request';
  cloneUrl: string;
  htmlUrl: string;
  baseBranch: string;
  headBranch?: string;
  title: string;
  body: string;
  author: string;
  labels: string[];
  triggerType: 'mention' | 'comment' | 'label';
  triggeringText: string;
  triggeringAuthor: string;
  labelName?: string;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  channelRef: string;
}

export interface GitHubChannelOptions {
  config: ResolvedGithubConfig;
  store: DurableStore;
  agent: DurableAgent;
}

export class GitHubChannel implements Channel {
  name = 'github';
  description = 'GitHub bot: clones the tagged repo, analyzes it, answers the issue/PR thread.';
  routes: ChannelRoute[];

  private cfg: ResolvedGithubConfig;
  private store: DurableStore;
  private agent: DurableAgent;
  private fetchImpl: typeof fetch;
  private deliveries = new Set<string>();
  private gitAuthHosts = new Set<string>();
  private tokenCache: string | null | undefined;
  private replying = new Set<string>();
  private listener: ((event: A2AEvent) => void) | null = null;

  constructor(opts: GitHubChannelOptions, fetchImpl: typeof fetch = fetch) {
    this.cfg = opts.config;
    this.store = opts.store;
    this.agent = opts.agent;
    this.fetchImpl = fetchImpl;

    this.routes = [
      {
        method: ['GET', 'POST'],
        match: (pathname) => pathname === this.cfg.webhookPath,
        handle: (req, url) => this.handle(req, url),
      },
    ];
  }

  info() {
    return {
      webhook_path: this.cfg.webhookPath,
      mentions: this.cfg.mentions,
      label_prompts: Object.keys(this.cfg.labelPrompts),
      triggers: this.cfg.triggers,
      reply: this.cfg.reply,
      push: this.cfg.push,
    };
  }

  start(): void {
    // Answer whenever any github-channel task reaches a terminal state —
    // including tasks resumed by durable recovery after a restart.
    this.listener = (event: A2AEvent) => {
      if (event.event === 'done') void this.deliverReply(event.task_id, 'done', String(event.data.summary || ''));
      else if (event.event === 'error') void this.deliverReply(event.task_id, 'error', String(event.data.error || ''));
    };
    this.agent.on('task_event', this.listener);
    void this.reconcile().catch((err) => console.error('[GitHub Channel] reconcile failed:', err.message));
  }

  stop(): void {
    if (this.listener) this.agent.off('task_event', this.listener);
    this.listener = null;
  }

  // --- HTTP ---

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handle(req: Request, url: URL): Promise<Response> {
    if (req.method === 'GET') {
      return this.json({ channel: this.name, ...this.info() });
    }
    if (req.method !== 'POST') {
      return this.json({ error: 'Method not allowed' }, 405);
    }

    const raw = await req.text();
    if (this.cfg.secret && !verifySignature(this.cfg.secret, raw, req.headers.get('x-hub-signature-256'))) {
      return this.json({ error: 'Invalid webhook signature' }, 401);
    }

    const event = req.headers.get('x-github-event') || '';
    const delivery = req.headers.get('x-github-delivery') || '';

    let payload: any;
    try {
      payload = parseWebhookPayload(raw, req.headers.get('content-type'));
    } catch (err: any) {
      return this.json({ error: `Invalid payload: ${err.message}` }, 400);
    }

    if (delivery && this.rememberDelivery(delivery)) {
      return this.json({ ok: true, duplicate: true, delivery });
    }

    try {
      const result = await this.processEvent(event, payload, delivery);
      return this.json({ ok: true, event, ...result });
    } catch (err: any) {
      // Non-2xx so GitHub redelivers transient failures (dedupe is delivery-id based).
      console.error(`[GitHub Channel] failed to process "${event}": ${err.stack || err.message}`);
      return this.json({ error: err.message }, 500);
    }
  }

  private rememberDelivery(id: string): boolean {
    if (this.deliveries.has(id)) return true;
    this.deliveries.add(id);
    if (this.deliveries.size > 1000) {
      const oldest = this.deliveries.values().next().value;
      if (oldest) this.deliveries.delete(oldest);
    }
    return false;
  }

  // --- Event evaluation ---

  private isSelf(...logins: Array<string | null | undefined>): boolean {
    const bot = this.cfg.botLogin.toLowerCase();
    if (!bot) return false;
    return logins.some((login) => (login || '').toLowerCase() === bot);
  }

  private isOwnMessage(body?: string): boolean {
    return (body || '').includes(REPLY_MARKER);
  }

  private async processEvent(
    event: string,
    payload: any,
    delivery: string
  ): Promise<{ handled: boolean; reason?: string; task_id?: string }> {
    const target = this.evaluate(event, payload, delivery);
    if (!target) return { handled: false, reason: 'ignored' };

    const { task_id, created, reason } = await this.createTask(target);
    return { handled: true, reason: created ? 'task_created' : reason, task_id };
  }

  private evaluate(event: string, payload: any, delivery: string): GithubTarget | null {
    const cfg = this.cfg;
    const repository = payload?.repository;
    if (!repository) return null;

    const ref = (fallback: string) => `github:${delivery || fallback}`;

    if (event === 'issue_comment' || event === 'pull_request_review_comment') {
      if (payload.action !== 'created') return null;
      const comment = payload.comment;
      if (!comment) return null;
      if (this.isSelf(payload.sender?.login, comment.user?.login) || this.isOwnMessage(comment.body)) return null;

      const isPullRequest =
        event === 'pull_request_review_comment' || Boolean(payload.issue?.pull_request || payload.pull_request);
      const mentioned = matchesMention(comment.body, cfg.mentions);
      if (!cfg.triggers.allComments && (!cfg.triggers.mention || !mentioned)) return null;

      return this.makeTarget(payload, repository, {
        kind: isPullRequest ? 'pull_request' : 'issue',
        number: payload.issue?.number || payload.pull_request?.number,
        labels: labelsOf(payload.issue) || labelsOf(payload.pull_request),
        triggerType: mentioned ? 'mention' : 'comment',
        triggeringText: comment.body || '',
        triggeringAuthor: comment.user?.login || payload.sender?.login || 'unknown',
        ref: ref(`${event}:${comment.id}`),
        event,
      });
    }

    if (event === 'issues' || event === 'pull_request') {
      const isPullRequest = event === 'pull_request';
      const node = payload.issue || payload.pull_request;
      if (!node) return null;
      if (this.isSelf(payload.sender?.login, node.user?.login) || this.isOwnMessage(node.body)) return null;

      if (payload.action === 'labeled') {
        const label = String(payload.label?.name || '').toLowerCase();
        if (!cfg.triggers.labelAdded.includes(label)) return null;
        return this.makeTarget(payload, repository, {
          kind: isPullRequest ? 'pull_request' : 'issue',
          number: node.number,
          labels: labelsOf(node),
          triggerType: 'label',
          triggeringText: `Label "${payload.label?.name}" was added to this ${isPullRequest ? 'pull request' : 'issue'} by @${payload.sender?.login || 'someone'}. Review it and respond accordingly.`,
          triggeringAuthor: payload.sender?.login || 'github',
          labelName: payload.label?.name,
          ref: ref(`${event}:labeled:${node.id}:${payload.label?.name}`),
          event,
        });
      }

      if (payload.action === 'opened' && cfg.triggers.mention && matchesMention(node.body, cfg.mentions)) {
        return this.makeTarget(payload, repository, {
          kind: isPullRequest ? 'pull_request' : 'issue',
          number: node.number,
          labels: labelsOf(node),
          triggerType: 'mention',
          triggeringText: node.body || '',
          triggeringAuthor: node.user?.login || payload.sender?.login || 'unknown',
          ref: ref(`${event}:opened:${node.id}`),
          event,
        });
      }
      return null;
    }

    return null;
  }

  private makeTarget(
    payload: any,
    repository: any,
    opts: {
      kind: 'issue' | 'pull_request';
      number?: number;
      labels: string[];
      triggerType: GithubTarget['triggerType'];
      triggeringText: string;
      triggeringAuthor: string;
      labelName?: string;
      ref: string;
      event: string;
    }
  ): GithubTarget | null {
    if (!opts.number) return null;

    const node = payload.issue || payload.pull_request;
    const pull = payload.pull_request;
    const [owner, repo] = fullName(repository).split('/');

    return {
      owner,
      repo,
      number: opts.number,
      kind: opts.kind,
      cloneUrl: repository.clone_url || `${repository.html_url}.git`,
      htmlUrl: node?.html_url || repository.html_url,
      baseBranch: pull?.base?.ref || this.cfg.baseBranch || repository.default_branch || 'main',
      headBranch: pull?.head?.ref,
      title: node?.title || '(no title)',
      body: node?.body || '',
      author: node?.user?.login || payload.sender?.login || 'unknown',
      labels: opts.labels,
      triggerType: opts.triggerType,
      triggeringText: opts.triggeringText,
      triggeringAuthor: opts.triggeringAuthor,
      labelName: opts.labelName,
      changedFiles: pull?.changed_files,
      additions: pull?.additions,
      deletions: pull?.deletions,
      channelRef: opts.ref,
    };
  }

  // --- Prompt & task creation ---

  private buildPrompt(t: GithubTarget): string {
    const cfg = this.cfg;
    const lines: string[] = [];

    lines.push(
      `A GitHub user triggered you on ${t.kind === 'pull_request' ? 'a pull request' : 'an issue'}. ` +
        'The repository is already cloned into your worktree — analyze it and answer.'
    );
    lines.push('');
    lines.push('## Target');
    lines.push(`- Repository: ${t.owner}/${t.repo} (${t.cloneUrl})`);
    lines.push(`- ${t.kind === 'pull_request' ? 'Pull Request' : 'Issue'} #${t.number}: ${t.title}`);
    lines.push(`- Author: @${t.author}`);
    if (t.labels.length) lines.push(`- Labels: ${t.labels.join(', ')}`);
    lines.push(`- URL: ${t.htmlUrl}`);
    lines.push(`- Base branch: ${t.baseBranch}`);
    if (t.headBranch) {
      lines.push(`- Head branch: ${t.headBranch}`);
      if (t.changedFiles !== undefined) {
        lines.push(`- Diff size: ${t.changedFiles} files (+${t.additions ?? '?'}/-${t.deletions ?? '?'})`);
      }
      lines.push('- Inspect it with `gh_pr_view` / `bash_run` (`gh pr diff`, `gh pr view`)');
    }

    if (cfg.includeBody && t.body) {
      lines.push('', `## ${t.kind === 'pull_request' ? 'Pull request' : 'Issue'} description`);
      lines.push(truncate(t.body, cfg.bodyCharLimit));
    }

    lines.push('', `## Trigger (${t.triggerType})`);
    lines.push(`By @${t.triggeringAuthor}:`);
    lines.push(truncate(t.triggeringText, cfg.bodyCharLimit));

    lines.push('', '## How to respond');
    lines.push('1. Read the real code with `read_file` / `list_files` / `bash_run` (`git log`, `git diff`). Never guess file contents.');
    if (t.kind === 'pull_request') lines.push('2. Use `gh_pr_view` for the diff and PR metadata before judging.');
    lines.push('3. Answer the question directly in Markdown — complete and self-contained, no internal reasoning, no task/worktree jargon.');
    lines.push('4. Your final message (or `finish_task` summary) is posted back to this GitHub thread automatically. Do NOT post it yourself with `gh_issue_comment` / `gh_pr_review`.');
    lines.push('5. Stay read-only: do not commit, push, or open PRs unless the user explicitly asked for a code change.');

    return lines.join('\n');
  }

  private async createTask(
    t: GithubTarget
  ): Promise<{ task_id: string; created: boolean; reason?: string }> {
    // Durable dedupe: a redelivered webhook never spawns a second task.
    const existing = this.store.findByChannelRef('github', t.channelRef);
    if (existing) return { task_id: existing.id, created: false, reason: 'duplicate_delivery' };

    await this.ensureGitAuth(t.cloneUrl);

    const prompt = resolveChannelPrompt({
      labels: t.labels,
      defaultPrompt: this.cfg.defaultSystemPrompt,
      labelPrompts: this.cfg.labelPrompts,
      baseDir: process.cwd(),
    });

    const taskId = `gh_${t.owner}_${t.repo}_${t.number}_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();

    const task: A2ATask = {
      id: taskId,
      status: 'PENDING',
      prompt: this.buildPrompt(t),
      system_prompt: prompt.systemPrompt,
      system_prompt_mode: 'replace',
      repo_url: t.cloneUrl,
      base_branch: t.baseBranch,
      target_branch: `agent/${taskId}`,
      channel: 'github',
      channel_ref: t.channelRef,
      no_push: !this.cfg.push,
      lease_expires_at: now + globalConfig.leaseDefaultSeconds * 1000,
      created_at: now,
      updated_at: now,
      artifacts: [
        {
          type: 'channel_reply',
          name: 'github_target',
          value: `${t.owner}/${t.repo}#${t.number}`,
          metadata: {
            owner: t.owner,
            repo: t.repo,
            number: t.number,
            kind: t.kind,
            thread_url: t.htmlUrl,
            trigger: t.triggerType,
            label: prompt.matchedLabel || '',
            reply_header: prompt.replyHeader || this.cfg.replyHeader,
          },
        },
      ],
    };

    try {
      this.store.createTask(task);
    } catch (err: any) {
      // Unique channel_ref index: lost a race against a concurrent delivery.
      const raced = this.store.findByChannelRef('github', t.channelRef);
      if (raced) return { task_id: raced.id, created: false, reason: 'duplicate_delivery' };
      throw err;
    }

    console.log(
      `[GitHub Channel] ${t.triggerType} on ${t.owner}/${t.repo}#${t.number}` +
        `${prompt.matchedLabel ? ` (label prompt: ${prompt.matchedLabel})` : ''} -> task ${taskId}`
    );
    this.agent.schedule(taskId);
    return { task_id: taskId, created: true };
  }

  // --- Token & git auth ---

  private async resolveToken(): Promise<string> {
    if (this.tokenCache !== undefined) return this.tokenCache;
    if (this.cfg.token) {
      this.tokenCache = this.cfg.token;
      return this.tokenCache;
    }
    const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (envToken) {
      this.tokenCache = envToken;
      return this.tokenCache;
    }
    try {
      const proc = Bun.spawn(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'pipe' });
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      if (out) {
        this.tokenCache = out;
        return out;
      }
    } catch {
      // gh not installed / not logged in
    }
    this.tokenCache = '';
    return '';
  }

  /**
   * Private repos need credentials for `git clone`. Instead of embedding the
   * token in the URL (it would end up in logs and git config), pass it as an
   * http.extraHeader through GIT_CONFIG_* env vars inherited by git children.
   */
  private async ensureGitAuth(cloneUrl: string): Promise<void> {
    if (!this.cfg.gitAuth) return;
    if (!cloneUrl.startsWith('https://')) return;

    let host: string;
    try {
      host = new URL(cloneUrl).host;
    } catch {
      return;
    }
    if (this.gitAuthHosts.has(host)) return;

    const token = await this.resolveToken();
    if (!token) return;

    const count = Number.parseInt(process.env.GIT_CONFIG_COUNT || '0', 10) || 0;
    process.env[`GIT_CONFIG_KEY_${count}`] = `http.https://${host}/.extraheader`;
    process.env[`GIT_CONFIG_VALUE_${count}`] = `AUTHORIZATION: basic ${Buffer.from(
      `x-access-token:${token}`
    ).toString('base64')}`;
    process.env.GIT_CONFIG_COUNT = String(count + 1);
    this.gitAuthHosts.add(host);
  }

  // --- Reply delivery ---

  private formatReply(header: string, text: string, taskId: string): string {
    let body = text.trim() || '(no answer produced)';
    if (header) body = `${header.trim()}\n\n${body}`;
    body += `\n\n${REPLY_MARKER}${taskId} -->`;
    if (body.length > GITHUB_MAX_COMMENT) {
      body = `${body.slice(0, GITHUB_MAX_COMMENT - 200)}\n\n… (reply truncated)${REPLY_MARKER}${taskId} -->`;
    }
    return body;
  }

  private async deliverReply(taskId: string, outcome: 'done' | 'error', text: string): Promise<void> {
    // In-flight guard: terminal events can arrive back-to-back before reply_state is written.
    if (this.replying.has(taskId)) return;
    this.replying.add(taskId);
    try {
      await this.deliverReplyOnce(taskId, outcome, text);
    } finally {
      this.replying.delete(taskId);
    }
  }

  private async deliverReplyOnce(taskId: string, outcome: 'done' | 'error', text: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task || task.channel !== 'github') return;
    if (task.reply_state) return;

    if (this.cfg.reply === 'none') {
      this.store.setReplyState(taskId, 'skipped');
      return;
    }
    if (outcome === 'error' && !this.cfg.replyOnError) {
      this.store.setReplyState(taskId, 'skipped');
      return;
    }

    const target = (task.artifacts || []).find((a) => a.type === 'channel_reply')?.metadata as
      | Record<string, any>
      | undefined;
    if (!target) {
      console.warn(`[GitHub Channel] task ${taskId} has no reply target; skipping`);
      this.store.setReplyState(taskId, 'skipped');
      return;
    }

    const header = (target.reply_header as string) || '';
    const body =
      outcome === 'error'
        ? this.formatReply(header, `⚠️ The agent failed while processing this request:\n\n> ${text || 'unknown error'}`, taskId)
        : this.formatReply(header, text, taskId);

    const token = await this.resolveToken();
    if (!token) {
      console.error(`[GitHub Channel] no GitHub token available — cannot reply to task ${taskId}`);
      this.store.setReplyState(taskId, 'failed');
      return;
    }

    const url = `${this.cfg.apiBase}/repos/${target.owner}/${target.repo}/issues/${target.number}/comments`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'hagent-channel-bot',
        },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        throw new Error(`GitHub API ${res.status}: ${detail}`);
      }
      this.store.setReplyState(taskId, 'posted');
      console.log(
        `[GitHub Channel] replied to ${target.owner}/${target.repo}#${target.number} (task ${taskId}, ${outcome})`
      );
    } catch (err: any) {
      this.store.setReplyState(taskId, 'failed');
      console.error(`[GitHub Channel] reply failed for task ${taskId}: ${err.message}`);
    }
  }

  /** Posts replies for channel tasks that finished while the process was down. */
  private async reconcile(): Promise<void> {
    const tasks = this.store.listChannelTasks('github');
    for (const task of tasks) {
      if ((task.status === 'COMPLETED' || task.status === 'FAILED') && !task.reply_state) {
        await this.deliverReply(
          task.id,
          task.status === 'COMPLETED' ? 'done' : 'error',
          task.summary || task.error || ''
        );
      }
    }
  }
}
