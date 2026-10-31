// server.ts
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
const customDataDir = getArg('--data-dir', process.env.DATA_DIR || '');
const customWorktreesDir = getArg('--worktrees-dir', process.env.WORKTREES_DIR || '');

config.port = customPort;
config.agentId = customAgentId;
config.concurrency = customConcurrency;
config.channelsConfigPath = customChannelsConfig;

if (customDataDir) {
  config.dataDir = resolve(customDataDir);
  config.dbPath = resolve(config.dataDir, 'agent_durable.db');
} else if (customPort) {
  config.dataDir = resolve(process.cwd(), `data-${customPort}`);
  config.dbPath = resolve(config.dataDir, 'agent_durable.db');
}

if (customWorktreesDir) {
  config.worktreesDir = resolve(customWorktreesDir);
} else if (customPort) {
  config.worktreesDir = resolve(process.cwd(), `worktrees-${customPort}`);
}

if (!existsSync(config.dataDir)) {
  mkdirSync(config.dataDir, { recursive: true });
}
if (!existsSync(config.worktreesDir)) {
  mkdirSync(config.worktreesDir, { recursive: true });
}

// Load System Prompt or SOUL.md
if (customSystemPromptFile && existsSync(resolve(customSystemPromptFile))) {
  config.systemPrompt = readFileSync(resolve(customSystemPromptFile), 'utf8');
  console.log(`📜 Loaded custom system prompt from: ${customSystemPromptFile}`);
} else if (customSystemPrompt) {
  config.systemPrompt = customSystemPrompt;
  console.log(`📜 Custom system prompt injected via CLI/Env`);
} else {
  const soulCandidates = [
    resolve(process.cwd(), 'SOUL.md'),
    resolve('/data/home/hagent/SOUL.md'),
    resolve('/data/home/SOUL.md'),
    resolve('/home/ubuntu/.hermes/SOUL.md'),
  ];
  for (const sc of soulCandidates) {
    if (existsSync(sc)) {
      try {
        config.systemPrompt = readFileSync(sc, 'utf8').trim();
        console.log(`📜 Loaded soul persona from: ${sc}`);
        break;
      } catch {}
    }
  }
}

console.log(`🤖 Starting HAgent Worker [${config.agentId}] on port ${config.port}...`);
console.log(`📁 Data dir: ${config.dataDir}`);
console.log(`🌲 Worktrees dir: ${config.worktreesDir}`);
console.log(`⚡ Max Concurrency: ${config.concurrency} parallel worktrees`);
if (config.githubToken) {
  console.log(`🐙 GitHub CLI Authentication: Enabled`);
} else {
  console.log(`⚠️ GitHub CLI Authentication: GITHUB_TOKEN not set in environment`);
}

const store = new DurableStore(config.dbPath);
const worktreeMgr = new WorktreeManager(config.worktreesDir);
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
