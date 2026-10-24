// server.ts
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

config.port = customPort;
config.agentId = customAgentId;
config.concurrency = customConcurrency;

console.log(`🤖 Starting Pi Durable Execution Worker [${config.agentId}]...`);
console.log(`⚡ Max Concurrency: ${config.concurrency} parallel worktrees`);

const store = new DurableStore();
const worktreeMgr = new WorktreeManager();
const agent = new DurableAgent(store, worktreeMgr, config.concurrency);
const a2aServer = new A2AServer(store, agent);

a2aServer.start();
