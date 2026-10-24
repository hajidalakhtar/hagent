// src/types.ts

// --- A2A Protocol Types ---

export type A2ATaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'WAITING_INPUT'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

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
  skills: Array<{
    id: string;
    name: string;
    description: string;
    input_schema?: Record<string, unknown>;
  }>;
}

export interface A2ATaskCreateRequest {
  task_id?: string;
  prompt: string;
  repo?: {
    url: string;
    base_branch?: string;
    target_branch?: string;
  };
  context?: Record<string, unknown>;
  env?: Record<string, string>;
  lease_seconds?: number;
}

export interface A2ATaskArtifact {
  type: 'git_branch' | 'git_commit' | 'file' | 'test_report' | 'summary';
  name: string;
  value: string;
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  id: string;
  status: A2ATaskStatus;
  prompt: string;
  repo_url?: string;
  base_branch: string;
  target_branch: string;
  worktree_dir?: string;
  lease_expires_at: number; // Unix timestamp in ms
  created_at: number;
  updated_at: number;
  completed_at?: number;
  error?: string;
  summary?: string;
  artifacts: A2ATaskArtifact[];
}

export interface A2AEvent {
  event: 'status_changed' | 'thought' | 'tool_call' | 'tool_result' | 'heartbeat' | 'artifact' | 'error' | 'done';
  task_id: string;
  timestamp: number;
  data: Record<string, unknown>;
}

// --- Pi Durable Execution & State Types ---

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AgentMessage {
  id: string;
  task_id: string;
  turn_index: number;
  role: MessageRole;
  content: string;
  tool_calls?: ToolCallRecord[];
  tool_call_id?: string;
  name?: string;
  created_at: number;
}

export interface ToolCallRecord {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export type ToolExecutionStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface ToolExecutionRecord {
  id: string;
  task_id: string;
  turn_index: number;
  tool_name: string;
  arguments: string; // JSON string
  status: ToolExecutionStatus;
  result?: string;
  error?: string;
  started_at: number;
  completed_at?: number;
}

// --- Tool Interface ---

export interface ToolContext {
  task_id: string;
  worktree_dir: string;
  env: Record<string, string>;
  logger: (msg: string) => void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (args: any, context: ToolContext) => Promise<{
    output: string;
    isError?: boolean;
    artifact?: A2ATaskArtifact;
  }>;
}
