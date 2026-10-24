// src/config.ts
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  agentId: process.env.AGENT_ID || 'worker-1',
  agentName: process.env.AGENT_NAME || 'Pi-Durable-Execution-Worker',
  agentVersion: '1.0.0',

  // Concurrency per VM
  concurrency: parseInt(process.env.CONCURRENCY || '4', 10),

  // GitHub CLI & Authentication
  githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',

  // System Prompt Customization
  systemPrompt: process.env.SYSTEM_PROMPT || '',
  systemPromptFile: process.env.SYSTEM_PROMPT_FILE || '',

  // Storage
  dataDir: resolve(process.env.DATA_DIR || './data'),
  dbPath: resolve(process.env.DATA_DIR || './data', 'agent_durable.db'),
  worktreesDir: resolve(process.env.WORKTREES_DIR || './worktrees'),

  // LLM Configuration
  llm: {
    apiKey: process.env.LLM_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.LLM_BASE_URL || (process.env.GEMINI_API_KEY
      ? 'https://generativelanguage.googleapis.com/v1beta/openai'
      : 'https://api.openai.com/v1'),
    model: process.env.LLM_MODEL || 'gemini-2.5-flash',
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS || '8192', 10),
    temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.1'),
  },

  // Distributed Durability & Lease
  leaseDefaultSeconds: parseInt(process.env.LEASE_DEFAULT_SECONDS || '120', 10),
  heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '15000', 10),
  maxTurnsPerTask: parseInt(process.env.MAX_TURNS_PER_TASK || '40', 10),
};

// Ensure directories exist
if (!existsSync(config.dataDir)) {
  mkdirSync(config.dataDir, { recursive: true });
}
if (!existsSync(config.worktreesDir)) {
  mkdirSync(config.worktreesDir, { recursive: true });
}
