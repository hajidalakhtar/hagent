// test/durable.test.ts
import { describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorktreeManager } from '../src/sandbox/worktree.ts';
import { DurableStore } from '../src/store/durable-store.ts';
import { ToolRegistry } from '../src/tools/registry.ts';

const testDbPath = resolve('./data/test_durable.db');
const testWorktrees = resolve('./data/test_worktrees');

describe('Pi Durable Store & Effect Sandwich', () => {
  try {
    rmSync(testDbPath, { force: true });
    rmSync(testWorktrees, { recursive: true, force: true });
  } catch {}

  const store = new DurableStore(testDbPath);
  const worktreeMgr = new WorktreeManager(testWorktrees);
  const registry = new ToolRegistry(store);

  it('should create and retrieve a task', () => {
    const taskId = 'task_test_01';
    store.createTask({
      id: taskId,
      status: 'PENDING',
      prompt: 'Implement hello world',
      base_branch: 'main',
      target_branch: 'agent/task_test_01',
      lease_expires_at: Date.now() + 60000,
      created_at: Date.now(),
      updated_at: Date.now(),
      artifacts: [],
    });

    const task = store.getTask(taskId);
    expect(task).not.toBeNull();
    expect(task?.id).toBe(taskId);
    expect(task?.status).toBe('PENDING');
  });

  it('should record and replay tool execution with effect sandwich', async () => {
    const taskId = 'task_test_01';
    const worktree = await worktreeMgr.prepare(taskId);

    const toolCall = {
      id: 'call_123',
      type: 'function' as const,
      function: {
        name: 'write_file',
        arguments: JSON.stringify({ path: 'hello.txt', content: 'Hello Pi Durable!' }),
      },
    };

    let executed = false;
    const context = {
      task_id: taskId,
      worktree_dir: worktree.worktreeDir,
      env: {},
      logger: () => {
        executed = true;
      },
    };

    // First execution
    const res1 = await registry.executeWithEffectSandwich(toolCall, 1, context);
    expect(res1.isError).toBe(false);
    expect(res1.output).toContain('Successfully wrote');
    expect(executed).toBe(true);

    // Verify stored in DB
    const record = store.getToolExecution('call_123');
    expect(record).not.toBeNull();
    expect(record?.status).toBe('COMPLETED');

    // Replay execution (e.g. after crash recovery)
    executed = false;
    const res2 = await registry.executeWithEffectSandwich(toolCall, 1, context);
    // Should NOT re-run side effect, but return persisted output
    expect(res2.output).toBe(res1.output);

    // Verify file exists and read it
    const readCall = {
      id: 'call_read',
      type: 'function' as const,
      function: {
        name: 'read_file',
        arguments: JSON.stringify({ path: 'hello.txt' }),
      },
    };
    const readRes = await registry.executeWithEffectSandwich(readCall, 1, context);
    expect(readRes.output).toContain('Hello Pi Durable!');
  });

  it('should test bash execution and git commit in worktree', async () => {
    const taskId = 'task_test_01';
    const task = store.getTask(taskId)!;
    const worktreeDir = resolve(testWorktrees, taskId);

    const context = {
      task_id: taskId,
      worktree_dir: worktreeDir,
      env: {},
      logger: () => {},
    };

    const bashCall = {
      id: 'call_bash',
      type: 'function' as const,
      function: {
        name: 'bash_run',
        arguments: JSON.stringify({ command: 'echo "Testing bash tool"' }),
      },
    };
    const bashRes = await registry.executeWithEffectSandwich(bashCall, 2, context);
    expect(bashRes.output).toContain('Testing bash tool');

    const commitCall = {
      id: 'call_commit',
      type: 'function' as const,
      function: {
        name: 'git_commit',
        arguments: JSON.stringify({ message: 'feat: add hello text' }),
      },
    };
    const commitRes = await registry.executeWithEffectSandwich(commitCall, 2, context);
    expect(commitRes.output).toContain('Committed successfully');
  });
});
