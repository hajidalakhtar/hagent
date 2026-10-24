// test/a2a-server.test.ts
import { describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { A2AServer } from '../src/a2a/server.ts';
import { DurableAgent } from '../src/agent/durable-agent.ts';
import { WorktreeManager } from '../src/sandbox/worktree.ts';
import { DurableStore } from '../src/store/durable-store.ts';

const testDb = resolve('./data/test_a2a_server.db');
const testWorktrees = resolve('./data/test_a2a_worktrees');

describe('A2A Server Protocol Endpoints', () => {
  try {
    rmSync(testDb, { force: true });
    rmSync(testWorktrees, { recursive: true, force: true });
  } catch {}

  const store = new DurableStore(testDb);
  const worktreeMgr = new WorktreeManager(testWorktrees);
  const agent = new DurableAgent(store, worktreeMgr, 3);
  const a2a = new A2AServer(store, agent);
  const server = a2a.start();

  it('should return valid A2A Agent Card with concurrency slots', async () => {
    const res = await server.fetch(new Request('http://localhost/.well-known/agent.json'));
    expect(res.status).toBe(200);
    const card = (await res.json()) as any;
    expect(card.name).toBeDefined();
    expect(card.capabilities.tools).toBeArray();
    expect(card.capabilities.tools).toContain('gh_issue_view');
    expect(card.capabilities.tools).toContain('gh_pr_create');
    expect(card.skills[0].id).toBe('execute_github_task');
    expect(card.slots).toBeDefined();
    expect(card.slots.max).toBe(3);
    expect(card.slots.active).toBe(0);
  });

  it('should support multiple concurrent tasks with dedicated worktrees', async () => {
    // Submit task 1 with custom injected system prompt
    const res1 = await server.fetch(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: 'task_concurrent_1',
          prompt: 'Task 1: Update auth module',
          system_prompt: 'Strict TDD: Write test first before code.',
          repo: { base_branch: 'main', target_branch: 'agent/auth' },
        }),
      })
    );
    expect(res1.status).toBe(201);
    const data1 = (await res1.json()) as any;
    expect(data1.task_id).toBe('task_concurrent_1');

    // Submit task 2
    const res2 = await server.fetch(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: 'task_concurrent_2',
          prompt: 'Task 2: Update billing module',
          repo: { base_branch: 'main', target_branch: 'agent/billing' },
        }),
      })
    );
    expect(res2.status).toBe(201);
    const data2 = (await res2.json()) as any;
    expect(data2.task_id).toBe('task_concurrent_2');

    // Verify both tasks exist with different target branches
    const detail1 = await (await server.fetch(new Request(`http://localhost/tasks/${data1.task_id}`))).json() as any;
    const detail2 = await (await server.fetch(new Request(`http://localhost/tasks/${data2.task_id}`))).json() as any;

    expect(detail1.target_branch).toBe('agent/auth');
    expect(detail1.system_prompt).toBe('Strict TDD: Write test first before code.');
    expect(detail2.target_branch).toBe('agent/billing');
    expect(detail1.id).not.toBe(detail2.id);

    // Cancel both cleanly
    await server.fetch(new Request(`http://localhost/tasks/${data1.task_id}/cancel`, { method: 'POST' }));
    await server.fetch(new Request(`http://localhost/tasks/${data2.task_id}/cancel`, { method: 'POST' }));
  });

  it('should validate and handle /chat endpoint for quick conversational testing', async () => {
    // 1. Missing message validation
    const badRes = await server.fetch(
      new Request('http://localhost/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(badRes.status).toBe(400);

    // 2. Mock LLM for test
    (a2a as any).llm = {
      chat: async () => ({ content: 'Halo! Saya worker siap membantu.' }),
    };

    const goodRes = await server.fetch(
      new Request('http://localhost/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'halo' }),
      })
    );
    expect(goodRes.status).toBe(200);
    const data = (await goodRes.json()) as any;
    expect(data.reply).toBe('Halo! Saya worker siap membantu.');
    expect(data.model).toBeDefined();
  });

  it('should close server gracefully', () => {
    server.stop();
  });
});
