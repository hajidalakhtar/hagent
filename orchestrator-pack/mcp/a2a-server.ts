#!/usr/bin/env bun
// orchestrator-pack/mcp/a2a-server.ts
// Model Context Protocol (MCP) Server for A2A Communication
// Compatible with Claude Code, Antigravity, Cursor, and any MCP client

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { A2AClient } from '../src/a2a-client.ts';

function loadFleetWorkers(): string[] {
  if (process.env.FLEET_WORKERS) {
    return process.env.FLEET_WORKERS.split(',').map((w) => w.trim()).filter(Boolean);
  }

  const paths = [
    resolve(process.cwd(), 'fleet.config.json'),
    resolve(import.meta.dir, '..', 'fleet.config.json'),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const parsed = JSON.parse(readFileSync(p, 'utf8'));
        if (Array.isArray(parsed.workers) && parsed.workers.length > 0) {
          return parsed.workers;
        }
      } catch {}
    }
  }

  return ['http://127.0.0.1:3000'];
}

const client = new A2AClient();

const tools = [
  {
    name: 'a2a_discover_fleet',
    description: 'Check health, availability, and concurrency slots of all worker MicroVMs on the Tailscale fleet.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'a2a_send_task',
    description: 'Dispatches a coding task, GitHub issue, or test verification to a remote worker MicroVM via A2A protocol.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Instructions on what to implement, fix, or test.' },
        worker_url: { type: 'string', description: 'Target worker URL. If omitted, picks least loaded.' },
        issue_number: { type: 'number', description: 'Optional GitHub issue number to resolve.' },
        repo_url: { type: 'string', description: 'Target Git repository URL.' },
        base_branch: { type: 'string', description: 'Base branch name (default main).' },
        target_branch: { type: 'string', description: 'Dedicated working branch name.' },
        system_prompt: { type: 'string', description: 'Optional custom system prompt to guide execution.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'a2a_get_task_status',
    description: 'Gets the current status, execution logs, and output artifacts (commit SHA, PR URL) of an A2A task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID.' },
        worker_url: { type: 'string', description: 'The worker URL.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'a2a_send_message',
    description: 'Sends a mid-flight message or instruction into an active worker task session.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The active task ID.' },
        message: { type: 'string', description: 'The message to send.' },
        worker_url: { type: 'string', description: 'The worker URL.' },
      },
      required: ['task_id', 'message'],
    },
  },
  {
    name: 'a2a_chat',
    description: 'Sends a direct conversational message to a worker for sanity testing without touching Git.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to send (e.g. "halo", "who are you?").' },
        worker_url: { type: 'string', description: 'Target worker URL.' },
      },
      required: ['message'],
    },
  },
];

async function handleToolCall(name: string, args: any): Promise<any> {
  const workers = loadFleetWorkers();

  switch (name) {
    case 'a2a_discover_fleet': {
      const results = await Promise.all(
        workers.map(async (url) => {
          try {
            const card = await client.getAgentCard(url);
            return {
              worker_url: url,
              online: true,
              agent_name: card.name,
              slots: card.slots || { max: 1, active: 0 },
              tools: card.capabilities.tools,
            };
          } catch (err: any) {
            return { worker_url: url, online: false, error: err.message };
          }
        })
      );
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }

    case 'a2a_send_task': {
      let targetWorker = args.worker_url;
      if (!targetWorker) {
        const statuses = await Promise.all(
          workers.map(async (w) => {
            try {
              const card = await client.getAgentCard(w);
              return { url: w, card, online: true };
            } catch {
              return { url: w, card: null, online: false };
            }
          })
        );
        const online = statuses.filter((s) => s.online && s.card);
        if (online.length === 0) {
          throw new Error('No online workers available in the fleet.');
        }
        online.sort((a, b) => (a.card?.slots?.active || 0) - (b.card?.slots?.active || 0));
        targetWorker = online[0]!.url;
      }

      let prompt = args.prompt;
      if (args.issue_number) {
        prompt = `Resolve GitHub issue #${args.issue_number}. Inspect issue requirements using gh_issue_view, make exact code modifications, run test suite to verify, commit changes, and open a Pull Request using gh_pr_create (linking 'Closes #${args.issue_number}').\n${prompt}`;
      }

      const res = await client.submitTask(targetWorker, {
        prompt,
        system_prompt: args.system_prompt,
        repo: args.repo_url
          ? {
              url: args.repo_url,
              base_branch: args.base_branch || 'main',
              target_branch: args.target_branch || (args.issue_number ? `agent/issue-${args.issue_number}` : undefined),
            }
          : undefined,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Task dispatched to ${targetWorker}:\nTask ID: ${res.task_id}\nStatus: ${res.status}\nLease Expires: ${new Date(res.lease_expires_at).toLocaleTimeString()}`,
          },
        ],
      };
    }

    case 'a2a_get_task_status': {
      const workerUrl = args.worker_url || workers[0] || 'http://127.0.0.1:3000';
      const task = await client.getTask(workerUrl, args.task_id);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    }

    case 'a2a_send_message': {
      const workerUrl = args.worker_url || workers[0] || 'http://127.0.0.1:3000';
      const res = await client.sendMessage(workerUrl, args.task_id, args.message);
      return { content: [{ type: 'text', text: `Message delivered: ${JSON.stringify(res)}` }] };
    }

    case 'a2a_chat': {
      const workerUrl = args.worker_url || workers[0] || 'http://127.0.0.1:3000';
      const res = await client.chat(workerUrl, args.message);
      return { content: [{ type: 'text', text: `[${res.agent}]: ${res.reply}` }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Stdio JSON-RPC MCP Server Loop
async function runMcpServer() {
  const stdin = Bun.stdin.stream();
  const reader = stdin.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.method === 'tools/list') {
          const resp = {
            jsonrpc: '2.0',
            id: msg.id,
            result: { tools },
          };
          process.stdout.write(JSON.stringify(resp) + '\n');
        } else if (msg.method === 'tools/call') {
          const { name, arguments: callArgs } = msg.params;
          try {
            const result = await handleToolCall(name, callArgs || {});
            const resp = {
              jsonrpc: '2.0',
              id: msg.id,
              result,
            };
            process.stdout.write(JSON.stringify(resp) + '\n');
          } catch (toolErr: any) {
            const resp = {
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32603, message: toolErr.message },
            };
            process.stdout.write(JSON.stringify(resp) + '\n');
          }
        } else if (msg.method === 'initialize') {
          const resp = {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'a2a-mcp-server', version: '1.0.0' },
            },
          };
          process.stdout.write(JSON.stringify(resp) + '\n');
        }
      } catch {}
    }
  }
}

runMcpServer().catch((err) => {
  console.error('MCP Server Fatal:', err);
  process.exit(1);
});
