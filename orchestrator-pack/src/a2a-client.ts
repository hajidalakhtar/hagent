// orchestrator-pack/src/a2a-client.ts
// Native A2A Protocol Client for Orchestrator Agents

export interface A2AAgentCard {
  name: string;
  description: string;
  version: string;
  endpoints: {
    agent_card: string;
    tasks: string;
    heartbeat?: string;
  };
  capabilities: {
    streaming: boolean;
    tools: string[];
    languages: string[];
  };
  slots?: {
    max: number;
    active: number;
  };
  skills: Array<{
    id: string;
    name: string;
    description: string;
  }>;
}

export interface A2ATaskResponse {
  task_id: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  prompt: string;
  target_branch: string;
  lease_expires_at: number;
  completed_at?: number;
  error?: string;
  summary?: string;
  artifacts: Array<{
    type: 'git_branch' | 'git_commit' | 'github_pr' | 'file' | 'summary';
    name: string;
    value: string;
    metadata?: Record<string, unknown>;
  }>;
  messages_count?: number;
  is_running?: boolean;
}

export class A2AClient {
  private defaultTimeoutMs: number;

  constructor(defaultTimeoutMs = 8000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  private async request(url: string, options: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.defaultTimeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      return res;
    } catch (err: any) {
      clearTimeout(timeout);
      throw new Error(`A2A Communication error to ${url}: ${err.name === 'AbortError' ? 'Timeout' : err.message}`);
    }
  }

  /**
   * Discover worker agent card and capabilities (A2A Discovery)
   */
  async getAgentCard(workerUrl: string): Promise<A2AAgentCard> {
    const cleanUrl = workerUrl.replace(/\/+$/, '');
    const res = await this.request(`${cleanUrl}/.well-known/agent.json`);
    if (!res.ok) throw new Error(`Failed to fetch Agent Card from ${cleanUrl} (${res.status})`);
    return res.json() as Promise<A2AAgentCard>;
  }

  /**
   * Submit an A2A task to a worker node
   */
  async submitTask(
    workerUrl: string,
    params: {
      prompt: string;
      system_prompt?: string;
      repo?: { url: string; base_branch?: string; target_branch?: string };
      lease_seconds?: number;
    }
  ): Promise<{ task_id: string; status: string; lease_expires_at: number; endpoints: Record<string, string> }> {
    const cleanUrl = workerUrl.replace(/\/+$/, '');
    const res = await this.request(`${cleanUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to submit A2A task to ${cleanUrl} (${res.status}): ${err}`);
    }

    return res.json() as any;
  }

  /**
   * Get the current status and artifacts of an A2A task
   */
  async getTask(workerUrl: string, taskId: string): Promise<A2ATaskResponse> {
    const cleanUrl = workerUrl.replace(/\/+$/, '');
    const res = await this.request(`${cleanUrl}/tasks/${taskId}`);
    if (!res.ok) throw new Error(`Failed to get task ${taskId} from ${cleanUrl} (${res.status})`);
    return res.json() as Promise<A2ATaskResponse>;
  }

  /**
   * Send an A2A message to an active worker task
   */
  async sendMessage(
    workerUrl: string,
    taskId: string,
    message: string
  ): Promise<{ task_id: string; status: string; message_id: string; acknowledged: boolean }> {
    const cleanUrl = workerUrl.replace(/\/+$/, '');
    const res = await this.request(`${cleanUrl}/tasks/${taskId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to send A2A message to ${taskId} (${res.status}): ${err}`);
    }

    return res.json() as any;
  }

  /**
   * Send a quick conversational message / sanity ping to a worker
   */
  async chat(workerUrl: string, message: string): Promise<{ reply: string; model: string; agent: string }> {
    const cleanUrl = workerUrl.replace(/\/+$/, '');
    const res = await this.request(`${cleanUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`A2A chat failed on ${cleanUrl} (${res.status}): ${err}`);
    }

    return res.json() as any;
  }

  /**
   * Cancel an A2A task
   */
  async cancelTask(workerUrl: string, taskId: string): Promise<{ task_id: string; cancelled: boolean }> {
    const cleanUrl = workerUrl.replace(/\/+$/, '');
    const res = await this.request(`${cleanUrl}/tasks/${taskId}/cancel`, { method: 'POST' });
    if (!res.ok) throw new Error(`Failed to cancel task ${taskId}`);
    return res.json() as any;
  }
}
