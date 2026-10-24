// orchestrator-pack/extensions/pi-extension.ts
// Native Pi Coding Agent Extension for A2A Communication
// Compatible with @earendil-works/pi-coding-agent

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

export default function a2aFleetExtension(pi: any) {
  const client = new A2AClient();

  // 1. Tool: a2a_discover_fleet
  pi.registerTool?.({
    name: 'a2a_discover_fleet',
    label: 'A2A Discover Fleet',
    description:
      'Discovers and inspects all worker MicroVMs on the Tailscale fleet. Returns online status, active vs max concurrency slots, and agent capabilities.',
    parameters: {
      type: 'object',
      properties: {},
    },
    async execute() {
      const workers = loadFleetWorkers();
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
            return {
              worker_url: url,
              online: false,
              error: err.message,
            };
          }
        })
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      };
    },
  });

  // 2. Tool: a2a_send_task
  pi.registerTool?.({
    name: 'a2a_send_task',
    label: 'A2A Send Task',
    description:
      'Sends a coding task, GitHub issue fix, or test verification to a remote worker MicroVM via A2A protocol. Runs in an isolated Git worktree.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed instructions on what to implement, fix, or test.',
        },
        worker_url: {
          type: 'string',
          description: 'Target worker URL (e.g. "http://worker-vm-1:3000"). If omitted, uses first available.',
        },
        issue_number: {
          type: 'number',
          description: 'Optional GitHub issue number to solve.',
        },
        repo_url: {
          type: 'string',
          description: 'Git repository URL.',
        },
        base_branch: {
          type: 'string',
          description: 'Base branch name (default: "main").',
        },
        target_branch: {
          type: 'string',
          description: 'Dedicated working branch name.',
        },
        system_prompt: {
          type: 'string',
          description: 'Optional custom system prompt to guide this specific execution.',
        },
      },
      required: ['prompt'],
    },
    async execute(_callId: string, params: any) {
      const workers = loadFleetWorkers();
      let targetWorker = params.worker_url;

      if (!targetWorker) {
        // Auto select least loaded worker
        const cards = await Promise.all(
          workers.map(async (w) => {
            try {
              const card = await client.getAgentCard(w);
              return { url: w, card, online: true };
            } catch {
              return { url: w, card: null, online: false };
            }
          })
        );
        const online = cards.filter((c) => c.online && c.card);
        if (online.length === 0) {
          return {
            content: [{ type: 'text', text: 'Error: No online workers available in the fleet.' }],
            isError: true,
          };
        }
        online.sort((a, b) => (a.card?.slots?.active || 0) - (b.card?.slots?.active || 0));
        targetWorker = online[0]!.url;
      }

      let prompt = params.prompt;
      if (params.issue_number) {
        prompt = `Resolve GitHub issue #${params.issue_number}. Inspect issue requirements using gh_issue_view, make exact code modifications, run test suite to verify, commit changes, and open a Pull Request using gh_pr_create (linking 'Closes #${params.issue_number}').\n${prompt}`;
      }

      try {
        const result = await client.submitTask(targetWorker, {
          prompt,
          system_prompt: params.system_prompt,
          repo: params.repo_url
            ? {
                url: params.repo_url,
                base_branch: params.base_branch || 'main',
                target_branch: params.target_branch || (params.issue_number ? `agent/issue-${params.issue_number}` : undefined),
              }
            : undefined,
        });

        return {
          content: [
            {
              type: 'text',
              text: `A2A Task dispatched successfully!\nWorker: ${targetWorker}\nTask ID: ${result.task_id}\nStatus: ${result.status}\nLease Expires: ${new Date(result.lease_expires_at).toLocaleTimeString()}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Failed to dispatch A2A task: ${err.message}` }],
          isError: true,
        };
      }
    },
  });

  // 3. Tool: a2a_get_task_status
  pi.registerTool?.({
    name: 'a2a_get_task_status',
    label: 'A2A Get Task Status',
    description:
      'Checks status, progress, summary, and artifacts (commit SHA, PR URL, git branch) of a dispatched A2A task.',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The task ID returned when dispatching.',
        },
        worker_url: {
          type: 'string',
          description: 'Worker URL where the task is running (e.g. "http://worker-vm-1:3000").',
        },
      },
      required: ['task_id'],
    },
    async execute(_callId: string, params: any) {
      const workers = loadFleetWorkers();
      const workerUrl = params.worker_url || workers[0] || 'http://127.0.0.1:3000';

      try {
        const task = await client.getTask(workerUrl, params.task_id);
        const artifactsStr = (task.artifacts || [])
          .map((a) => `- [${a.type}] ${a.name}: ${a.value}`)
          .join('\n');

        const summary = [
          `Task ID: ${task.task_id}`,
          `Status: ${task.status}`,
          `Target Branch: ${task.target_branch}`,
          task.summary ? `Summary: ${task.summary}` : '',
          task.error ? `Error: ${task.error}` : '',
          artifactsStr ? `\nArtifacts:\n${artifactsStr}` : '',
        ]
          .filter(Boolean)
          .join('\n');

        return {
          content: [{ type: 'text', text: summary }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Failed to get task status: ${err.message}` }],
          isError: true,
        };
      }
    },
  });

  // 4. Tool: a2a_send_message
  pi.registerTool?.({
    name: 'a2a_send_message',
    label: 'A2A Send Message',
    description:
      'Sends a mid-task message, follow-up instruction, or clarification directly into the worker’s active task session.',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The active task ID.',
        },
        message: {
          type: 'string',
          description: 'Message or instruction to send to the worker agent.',
        },
        worker_url: {
          type: 'string',
          description: 'Worker URL where the task is running.',
        },
      },
      required: ['task_id', 'message'],
    },
    async execute(_callId: string, params: any) {
      const workers = loadFleetWorkers();
      const workerUrl = params.worker_url || workers[0] || 'http://127.0.0.1:3000';

      try {
        const res = await client.sendMessage(workerUrl, params.task_id, params.message);
        return {
          content: [
            {
              type: 'text',
              text: `Message delivered to task ${params.task_id} (Message ID: ${res.message_id}).`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Failed to deliver message: ${err.message}` }],
          isError: true,
        };
      }
    },
  });

  // 5. Tool: a2a_chat
  pi.registerTool?.({
    name: 'a2a_chat',
    label: 'A2A Chat / Ping',
    description:
      'Sends a direct conversational message to a worker node for sanity testing without touching Git or filesystem.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Conversational message (e.g. "halo", "who are you?").',
        },
        worker_url: {
          type: 'string',
          description: 'Worker URL (default: first worker in fleet).',
        },
      },
      required: ['message'],
    },
    async execute(_callId: string, params: any) {
      const workers = loadFleetWorkers();
      const workerUrl = params.worker_url || workers[0] || 'http://127.0.0.1:3000';

      try {
        const res = await client.chat(workerUrl, params.message);
        return {
          content: [
            {
              type: 'text',
              text: `[${res.agent} | ${res.model}]:\n${res.reply}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `A2A chat failed: ${err.message}` }],
          isError: true,
        };
      }
    },
  });
}
