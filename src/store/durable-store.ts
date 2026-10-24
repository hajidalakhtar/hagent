// src/store/durable-store.ts
import { Database } from 'bun:sqlite';
import { config } from '../config.ts';
import type {
  A2ATask,
  A2ATaskArtifact,
  A2ATaskStatus,
  AgentMessage,
  ToolExecutionRecord,
  ToolExecutionStatus,
} from '../types.ts';

export class DurableStore {
  private db: Database;

  constructor(dbPath: string = config.dbPath) {
    this.db = new Database(dbPath);
    this.init();
  }

  private init() {
    this.db.run('PRAGMA journal_mode = WAL;');
    this.db.run('PRAGMA foreign_keys = ON;');

    this.db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        system_prompt TEXT,
        repo_url TEXT,
        base_branch TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        worktree_dir TEXT,
        lease_expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT,
        summary TEXT,
        artifacts TEXT NOT NULL DEFAULT '[]'
      );
    `);

    // Migration fallback for existing DBs
    try {
      this.db.run('ALTER TABLE tasks ADD COLUMN system_prompt TEXT;');
    } catch {}

    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        name TEXT,
        created_at INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS tool_executions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn_index INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        arguments TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      );
    `);

    this.db.run('CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, turn_index);');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_tools_task ON tool_executions(task_id, turn_index);');
  }

  // --- Task Methods ---

  createTask(task: A2ATask): void {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, status, prompt, system_prompt, repo_url, base_branch, target_branch,
        worktree_dir, lease_expires_at, created_at, updated_at,
        completed_at, error, summary, artifacts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      task.id,
      task.status,
      task.prompt,
      task.system_prompt || null,
      task.repo_url || null,
      task.base_branch,
      task.target_branch,
      task.worktree_dir || null,
      task.lease_expires_at,
      task.created_at,
      task.updated_at,
      task.completed_at || null,
      task.error || null,
      task.summary || null,
      JSON.stringify(task.artifacts || [])
    );
  }

  getTask(id: string): A2ATask | null {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      status: row.status as A2ATaskStatus,
      prompt: row.prompt,
      system_prompt: row.system_prompt || undefined,
      repo_url: row.repo_url || undefined,
      base_branch: row.base_branch,
      target_branch: row.target_branch,
      worktree_dir: row.worktree_dir || undefined,
      lease_expires_at: row.lease_expires_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at || undefined,
      error: row.error || undefined,
      summary: row.summary || undefined,
      artifacts: JSON.parse(row.artifacts || '[]'),
    };
  }

  listTasks(limit = 50): A2ATask[] {
    const stmt = this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?');
    const rows = stmt.all(limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      status: row.status as A2ATaskStatus,
      prompt: row.prompt,
      system_prompt: row.system_prompt || undefined,
      repo_url: row.repo_url || undefined,
      base_branch: row.base_branch,
      target_branch: row.target_branch,
      worktree_dir: row.worktree_dir || undefined,
      lease_expires_at: row.lease_expires_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at || undefined,
      error: row.error || undefined,
      summary: row.summary || undefined,
      artifacts: JSON.parse(row.artifacts || '[]'),
    }));
  }

  updateTaskStatus(id: string, status: A2ATaskStatus, error?: string, summary?: string): void {
    const now = Date.now();
    const isDone = status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET status = ?, 
          updated_at = ?, 
          completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END,
          error = COALESCE(?, error),
          summary = COALESCE(?, summary)
      WHERE id = ?
    `);
    stmt.run(status, now, isDone ? 1 : 0, now, error || null, summary || null, id);
  }

  renewLease(id: string, leaseDurationMs: number): number {
    const expiresAt = Date.now() + leaseDurationMs;
    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(expiresAt, Date.now(), id);
    return expiresAt;
  }

  addArtifact(taskId: string, artifact: A2ATaskArtifact): void {
    const task = this.getTask(taskId);
    if (!task) return;
    const artifacts = task.artifacts || [];
    artifacts.push(artifact);

    const stmt = this.db.prepare(`
      UPDATE tasks SET artifacts = ?, updated_at = ? WHERE id = ?
    `);
    stmt.run(JSON.stringify(artifacts), Date.now(), taskId);
  }

  // --- Transcript & Message Methods ---

  addMessage(message: AgentMessage): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (
        id, task_id, turn_index, role, content, tool_calls, tool_call_id, name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      message.id,
      message.task_id,
      message.turn_index,
      message.role,
      message.content,
      message.tool_calls ? JSON.stringify(message.tool_calls) : null,
      message.tool_call_id || null,
      message.name || null,
      message.created_at
    );
  }

  getMessages(taskId: string): AgentMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages WHERE task_id = ? ORDER BY turn_index ASC, created_at ASC
    `);
    const rows = stmt.all(taskId) as any[];

    return rows.map((r) => ({
      id: r.id,
      task_id: r.task_id,
      turn_index: r.turn_index,
      role: r.role,
      content: r.content,
      tool_calls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
      tool_call_id: r.tool_call_id || undefined,
      name: r.name || undefined,
      created_at: r.created_at,
    }));
  }

  // --- Pi Durable Effect Sandwich Methods ---

  recordToolIntent(execution: Omit<ToolExecutionRecord, 'status' | 'started_at'>): ToolExecutionRecord {
    const record: ToolExecutionRecord = {
      ...execution,
      status: 'PENDING',
      started_at: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO tool_executions (
        id, task_id, turn_index, tool_name, arguments, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.task_id,
      record.turn_index,
      record.tool_name,
      record.arguments,
      record.status,
      record.started_at
    );

    return record;
  }

  updateToolExecutionStatus(id: string, status: ToolExecutionStatus): void {
    const stmt = this.db.prepare(`
      UPDATE tool_executions SET status = ? WHERE id = ?
    `);
    stmt.run(status, id);
  }

  commitToolResult(id: string, result: string, isError = false): void {
    const stmt = this.db.prepare(`
      UPDATE tool_executions 
      SET status = ?, 
          result = ?, 
          error = ?, 
          completed_at = ?
      WHERE id = ?
    `);

    stmt.run(
      isError ? 'FAILED' : 'COMPLETED',
      isError ? null : result,
      isError ? result : null,
      Date.now(),
      id
    );
  }

  getToolExecution(id: string): ToolExecutionRecord | null {
    const stmt = this.db.prepare('SELECT * FROM tool_executions WHERE id = ?');
    const r = stmt.get(id) as any;
    if (!r) return null;

    return {
      id: r.id,
      task_id: r.task_id,
      turn_index: r.turn_index,
      tool_name: r.tool_name,
      arguments: r.arguments,
      status: r.status as ToolExecutionStatus,
      result: r.result || undefined,
      error: r.error || undefined,
      started_at: r.started_at,
      completed_at: r.completed_at || undefined,
    };
  }

  getIncompleteTasks(): A2ATask[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks WHERE status IN ('PENDING', 'RUNNING') ORDER BY created_at ASC
    `);
    const rows = stmt.all() as any[];
    return rows.map((row) => ({
      id: row.id,
      status: row.status as A2ATaskStatus,
      prompt: row.prompt,
      system_prompt: row.system_prompt || undefined,
      repo_url: row.repo_url || undefined,
      base_branch: row.base_branch,
      target_branch: row.target_branch,
      worktree_dir: row.worktree_dir || undefined,
      lease_expires_at: row.lease_expires_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at || undefined,
      error: row.error || undefined,
      summary: row.summary || undefined,
      artifacts: JSON.parse(row.artifacts || '[]'),
    }));
  }

  getPendingTasks(limit = 10): A2ATask[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT ?
    `);
    const rows = stmt.all(limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      status: row.status as A2ATaskStatus,
      prompt: row.prompt,
      system_prompt: row.system_prompt || undefined,
      repo_url: row.repo_url || undefined,
      base_branch: row.base_branch,
      target_branch: row.target_branch,
      worktree_dir: row.worktree_dir || undefined,
      lease_expires_at: row.lease_expires_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at || undefined,
      error: row.error || undefined,
      summary: row.summary || undefined,
      artifacts: JSON.parse(row.artifacts || '[]'),
    }));
  }

  close() {
    this.db.close();
  }
}
