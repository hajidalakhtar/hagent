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
  const agent = new DurableAgent(store, worktreeMgr);
  const a2a = new A2AServer(store, agent);
  const server = a2a.start();

  it('should return valid A2A Agent Card', async () => {
    // Direct in-memory invocation avoids sandbox network restrictions
    const res = await server.fetch(new Request('http://localhost/.well-known/agent.json'));
    expect(res.status).toBe(200);
    const card = (await res.json()) as any;
    expect(card.name).toBeDefined();
    expect(card.capabilities.tools).toBeArray();
    expect(card.skills[0].id).toBe('coding_task');
  });

  it('should create a new task via POST /tasks', async () => {
    const res = await server.fetch(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Test coding task execution',
          repo: {
            base_branch: 'main',
            target_branch: 'agent/test-task',
          },
        }),
      })
    );

    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    expect(data.task_id).toBeDefined();
    expect(data.status).toBe('PENDING');
    expect(data.lease_expires_at).toBeGreaterThan(Date.now());

    // Verify task details via GET /tasks/:id
    const detailRes = await server.fetch(new Request(`http://localhost/tasks/${data.task_id}`));
    expect(detailRes.status).toBe(200);
    const task = (await detailRes.json()) as any;
    expect(task.id).toBe(data.task_id);
    expect(task.prompt).toBe('Test coding task execution');

    // Test heartbeat POST /tasks/:id/heartbeat
    const hbRes = await server.fetch(new Request(`http://localhost/tasks/${data.task_id}/heartbeat`, { method: 'POST' }));
    expect(hbRes.status).toBe(200);
    const hbData = (await hbRes.json()) as any;
    expect(hbData.lease_expires_at).toBeGreaterThan(data.lease_expires_at - 1000);

    // Test cancel POST /tasks/:id/cancel
    const cancelRes = await server.fetch(new Request(`http://localhost/tasks/${data.task_id}/cancel`, { method: 'POST' }));
    expect(cancelRes.status).toBe(200);
    const cancelData = (await cancelRes.json()) as any;
    expect(cancelData.cancelled).toBe(true);
  });

  it('should close server gracefully', () => {
    server.stop();
  });
});
