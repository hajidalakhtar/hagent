// src/client/master-client.ts
import type { A2AAgentCard, A2AEvent, A2ATask } from '../types.ts';

export class A2AMasterClient {
  private workerUrl: string;

  constructor(workerUrl: string) {
    this.workerUrl = workerUrl.replace(/\/+$/, '');
  }

  async getAgentCard(): Promise<A2AAgentCard> {
    const res = await fetch(`${this.workerUrl}/.well-known/agent.json`);
    if (!res.ok) throw new Error(`Failed to fetch Agent Card from ${this.workerUrl}: ${res.statusText}`);
    return res.json() as Promise<A2AAgentCard>;
  }

  async submitTask(params: {
    prompt: string;
    taskId?: string;
    repo?: { url: string; base_branch?: string; target_branch?: string };
    leaseSeconds?: number;
  }): Promise<{ task_id: string; status: string; lease_expires_at: number; endpoints: Record<string, string> }> {
    const res = await fetch(`${this.workerUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: params.taskId,
        prompt: params.prompt,
        repo: params.repo,
        lease_seconds: params.leaseSeconds,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to submit task: ${err}`);
    }

    return res.json() as any;
  }

  async getTask(taskId: string): Promise<A2ATask & { messages_count: number; is_running: boolean }> {
    const res = await fetch(`${this.workerUrl}/tasks/${taskId}`);
    if (!res.ok) throw new Error(`Failed to get task ${taskId}: ${res.statusText}`);
    return res.json() as any;
  }

  async listTasks(): Promise<A2ATask[]> {
    const res = await fetch(`${this.workerUrl}/tasks`);
    if (!res.ok) throw new Error(`Failed to list tasks: ${res.statusText}`);
    return res.json() as any;
  }

  async sendHeartbeat(taskId: string): Promise<{ task_id: string; lease_expires_at: number; status: string }> {
    const res = await fetch(`${this.workerUrl}/tasks/${taskId}/heartbeat`, { method: 'POST' });
    if (!res.ok) throw new Error(`Failed heartbeat for task ${taskId}`);
    return res.json() as any;
  }

  async cancelTask(taskId: string): Promise<{ task_id: string; cancelled: boolean }> {
    const res = await fetch(`${this.workerUrl}/tasks/${taskId}/cancel`, { method: 'POST' });
    if (!res.ok) throw new Error(`Failed to cancel task ${taskId}`);
    return res.json() as any;
  }

  /**
   * Streams live task events via SSE and invokes the callback
   */
  async streamEvents(taskId: string, onEvent: (event: A2AEvent) => void): Promise<void> {
    const res = await fetch(`${this.workerUrl}/tasks/${taskId}/events`);
    if (!res.ok) throw new Error(`Failed to connect to events stream for task ${taskId}`);

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No readable stream available in response');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (line && line.startsWith('data: ')) {
          try {
            const jsonStr = line.slice(6);
            const parsed = JSON.parse(jsonStr) as A2AEvent;
            onEvent(parsed);
          } catch {
            // ignore non-json data
          }
        }
      }
    }
  }
}
