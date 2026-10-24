// server.ts
import { DurableAgent } from './src/agent/durable-agent.ts';
import { A2AServer } from './src/a2a/server.ts';
import { WorktreeManager } from './src/sandbox/worktree.ts';
import { DurableStore } from './src/store/durable-store.ts';

console.log('🤖 Starting Pi Durable Coding Agent Worker...');

const store = new DurableStore();
const worktreeMgr = new WorktreeManager();
const agent = new DurableAgent(store, worktreeMgr);
const a2aServer = new A2AServer(store, agent);

a2aServer.start();
