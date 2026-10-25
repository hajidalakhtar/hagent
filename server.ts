// server.ts
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createChannels } from './src/channels/index.ts';
import { DurableAgent } from './src/agent/durable-agent.ts';
import { A2AServer } from './src/a2a/server.ts';
import { config } from './src/config.ts';
import { WorktreeManager } from './src/sandbox/worktree.ts';
import { DurableStore } from './src/store/durable-store.ts';

// Parse CLI overrides
const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1]! : fallback;
}

const customPort = parseInt(getArg('--port', String(config.port)), 10);
const customAgentId = getArg('--agent-id', config.agentId);
const customConcurrency = parseInt(getArg('--concurrency', String(config.concurrency)), 10);
const customSystemPrompt = getArg('--system-prompt', config.systemPrompt);
const customSystemPromptFile = getArg('--system-prompt-file', config.systemPromptFile);
const customChannelsConfig = getArg('--channels-config', config.channelsConfigPath);

config.port = customPort;
config.agentId = customAgentId;
config.concurrency = customConcurrency;
config.channelsConfigPath = customChannelsConfig;

if (customSystemPromptFile && existsSync(resolve(customSystemPromptFile))) {
  config.systemPrompt = readFileSync(resolve(customSystemPromptFile), 'utf8');
  console.log(`📜 Loaded custom system prompt from: ${customSystemPromptFile}`);
} else if (customSystemPrompt) {
  config.systemPrompt = customSystemPrompt;
  console.log(`📜 Custom system prompt injected via CLI/Env`);
}

console.log(`🤖 Starting Pi Durable Execution Worker [${config.agentId}]...`);
console.log(`⚡ Max Concurrency: ${config.concurrency} parallel worktrees`);
if (config.githubToken) {
  console.log(`🐙 GitHub CLI Authentication: Enabled`);
} else {
  console.log(`⚠️ GitHub CLI Authentication: GITHUB_TOKEN not set in environment`);
}

const store = new DurableStore();
const worktreeMgr = new WorktreeManager();
const agent = new DurableAgent(store, worktreeMgr, config.concurrency);

// Inbound channels (channels.json): GitHub bot tag -> clone -> analyze -> reply
let channels: ReturnType<typeof createChannels> = [];
try {
  channels = createChannels({ configPath: config.channelsConfigPath, store, agent });
} catch (err: any) {
  console.error(`⚠️ Failed to load channels config (${config.channelsConfigPath}): ${err.message}`);
  process.exit(1);
}
for (const channel of channels) {
  console.log(`📡 Channel loaded: ${channel.name} — ${channel.description}`);
}

const a2aServer = new A2AServer(store, agent, channels);

a2aServer.start();
