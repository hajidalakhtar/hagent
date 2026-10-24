// src/a2a/server.ts
import { config } from '../config.ts';
import { DurableAgent } from '../agent/durable-agent.ts';
import { LLMClient } from '../llm/client.ts';
import { DurableStore } from '../store/durable-store.ts';
import type { A2AEvent, A2ATask, A2ATaskCreateRequest } from '../types.ts';
import { getAgentCard } from './agent-card.ts';

export class A2AServer {
  private store: DurableStore;
  private agent: DurableAgent;
  private llm: LLMClient;

  constructor(store: DurableStore, agent: DurableAgent) {
    this.store = store;
    this.agent = agent;
    this.llm = new LLMClient();
  }

  private jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  private handleSSE(taskId: string, req: Request): Response {
    const task = this.store.getTask(taskId);
    if (!task) {
      return this.jsonResponse({ error: 'Task not found' }, 404);
    }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const sendEvent = (event: A2AEvent) => {
      try {
        const payload = `event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
        writer.write(encoder.encode(payload));
      } catch {
        // stream might be closed
      }
    };

    // Send initial status event
    sendEvent({
      event: 'status_changed',
      task_id: taskId,
      timestamp: Date.now(),
      data: { status: task.status },
    });

    const eventListener = (event: A2AEvent) => {
      sendEvent(event);
      if (event.event === 'done' || event.event === 'error') {
        try {
          writer.close();
        } catch {}
      }
    };

    this.agent.on(`task_event:${taskId}`, eventListener);

    // Clean up when request aborted
    req.signal.addEventListener('abort', () => {
      this.agent.off(`task_event:${taskId}`, eventListener);
      try {
        writer.close();
      } catch {}
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  start() {
    const store = this.store;
    const agent = this.agent;
    const self = this;

    const server = Bun.serve({
      port: config.port,
      hostname: config.host,
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;

        // Handle CORS preflight
        if (method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            },
          });
        }

        const hostUrl = `${url.protocol}//${url.host}`;

        // 1. Agent Card Discovery
        if (method === 'GET' && (path === '/.well-known/agent.json' || path === '/agent.json')) {
          return self.jsonResponse(
            getAgentCard(hostUrl, {
              max: agent.getMaxConcurrency(),
              active: agent.getActiveTaskCount(),
            })
          );
        }

        // 2. Direct Chat & Sanity Ping (No Git / Worktree required)
        if (method === 'POST' && path === '/chat') {
          try {
            const body = (await req.json()) as { message?: string; prompt?: string };
            const text = (body.message || body.prompt || '').trim();
            if (!text) {
              return self.jsonResponse({ error: 'Field "message" or "prompt" is required' }, 400);
            }

            const sys = config.systemPrompt
              ? `${config.systemPrompt}\nYou are ${config.agentName} running on Pi Durable. Provide direct, friendly, and helpful responses.`
              : `You are ${config.agentName} running on Pi Durable. Provide direct, friendly, and helpful responses.`;

            const messages = [
              {
                id: `sys_${crypto.randomUUID()}`,
                task_id: 'chat_ping',
                turn_index: 0,
                role: 'system' as const,
                content: sys,
                created_at: Date.now(),
              },
              {
                id: `usr_${crypto.randomUUID()}`,
                task_id: 'chat_ping',
                turn_index: 1,
                role: 'user' as const,
                content: text,
                created_at: Date.now(),
              },
            ];

            const reply = await self.llm.chat(messages, []);
            return self.jsonResponse({
              reply: reply.content,
              model: config.llm.model,
              agent: config.agentName,
              timestamp: Date.now(),
            });
          } catch (err: any) {
            return self.jsonResponse({ error: err.message }, 500);
          }
        }

        // 3. Create Task
        if (method === 'POST' && path === '/tasks') {
          try {
            const body = (await req.json()) as A2ATaskCreateRequest;
            if (!body.prompt) {
              return self.jsonResponse({ error: 'Field "prompt" is required' }, 400);
            }

            const taskId = body.task_id || `task_${crypto.randomUUID()}`;
            const leaseSeconds = body.lease_seconds || config.leaseDefaultSeconds;
            const now = Date.now();

            const newTask: A2ATask = {
              id: taskId,
              status: 'PENDING',
              prompt: body.prompt,
              system_prompt: body.system_prompt,
              repo_url: body.repo?.url,
              base_branch: body.repo?.base_branch || 'main',
              target_branch: body.repo?.target_branch || `agent/${taskId}`,
              lease_expires_at: now + leaseSeconds * 1000,
              created_at: now,
              updated_at: now,
              artifacts: [],
            };

            store.createTask(newTask);

            // Schedule task in worker concurrency queue
            agent.schedule(taskId);

            const isImmediatelyRunning = agent.isTaskRunning(taskId);

            return self.jsonResponse(
              {
                task_id: taskId,
                status: isImmediatelyRunning ? 'RUNNING' : 'PENDING',
                slot_info: {
                  active: agent.getActiveTaskCount(),
                  max: agent.getMaxConcurrency(),
                },
                lease_expires_at: newTask.lease_expires_at,
                endpoints: {
                  status: `/tasks/${taskId}`,
                  events: `/tasks/${taskId}/events`,
                  heartbeat: `/tasks/${taskId}/heartbeat`,
                  cancel: `/tasks/${taskId}/cancel`,
                },
              },
              201
            );
          } catch (err: any) {
            return self.jsonResponse({ error: err.message }, 400);
          }
        }

        // 3. List Tasks
        if (method === 'GET' && path === '/tasks') {
          const limit = parseInt(url.searchParams.get('limit') || '50', 10);
          return self.jsonResponse(store.listTasks(limit));
        }

        // 4. SSE Stream for Task Events: /tasks/:id/events
        const eventsMatch = path.match(/^\/tasks\/([^/]+)\/events$/);
        if (method === 'GET' && eventsMatch) {
          const taskId = eventsMatch[1]!;
          return self.handleSSE(taskId, req);
        }

        // 5. Heartbeat renewal: /tasks/:id/heartbeat
        const heartbeatMatch = path.match(/^\/tasks\/([^/]+)\/heartbeat$/);
        if (method === 'POST' && heartbeatMatch) {
          const taskId = heartbeatMatch[1]!;
          const task = store.getTask(taskId);
          if (!task) return self.jsonResponse({ error: 'Task not found' }, 404);

          const leaseExpiresAt = store.renewLease(taskId, config.leaseDefaultSeconds * 1000);
          return self.jsonResponse({ task_id: taskId, lease_expires_at: leaseExpiresAt, status: task.status });
        }

        // 6. Cancel Task: /tasks/:id/cancel
        const cancelMatch = path.match(/^\/tasks\/([^/]+)\/cancel$/);
        if (method === 'POST' && cancelMatch) {
          const taskId = cancelMatch[1]!;
          const success = agent.cancelTask(taskId);
          return self.jsonResponse({ task_id: taskId, cancelled: success });
        }

        // 7. Task Messages: GET /tasks/:id/messages & POST /tasks/:id/messages
        const messagesMatch = path.match(/^\/tasks\/([^/]+)\/messages$/);
        if (messagesMatch) {
          const taskId = messagesMatch[1]!;
          const task = store.getTask(taskId);
          if (!task) return self.jsonResponse({ error: 'Task not found' }, 404);

          if (method === 'GET') {
            return self.jsonResponse(store.getMessages(taskId));
          }

          if (method === 'POST') {
            try {
              const body = (await req.json()) as { message?: string; content?: string };
              const text = (body.message || body.content || '').trim();
              if (!text) return self.jsonResponse({ error: 'Field "message" or "content" is required' }, 400);

              const existingMsgs = store.getMessages(taskId);
              const nextTurn = existingMsgs.length > 0 ? Math.max(...existingMsgs.map((m) => m.turn_index)) + 1 : 1;

              const userMsg = {
                id: `msg_${crypto.randomUUID()}`,
                task_id: taskId,
                turn_index: nextTurn,
                role: 'user' as const,
                content: text,
                created_at: Date.now(),
              };

              store.addMessage(userMsg);
              agent.emitA2AEvent({
                event: 'thought',
                task_id: taskId,
                timestamp: Date.now(),
                data: { message: `[Master A2A Message]: ${text}` },
              });

              return self.jsonResponse({
                task_id: taskId,
                status: task.status,
                message_id: userMsg.id,
                acknowledged: true,
              });
            } catch (err: any) {
              return self.jsonResponse({ error: err.message }, 400);
            }
          }
        }

        // 8. Get Task Detail: /tasks/:id
        const taskDetailMatch = path.match(/^\/tasks\/([^/]+)$/);
        if (method === 'GET' && taskDetailMatch) {
          const taskId = taskDetailMatch[1]!;
          const task = store.getTask(taskId);
          if (!task) return self.jsonResponse({ error: 'Task not found' }, 404);

          const messages = store.getMessages(taskId);
          return self.jsonResponse({
            ...task,
            messages_count: messages.length,
            is_running: agent.isTaskRunning(taskId),
          });
        }

        return self.jsonResponse({ error: 'Not found', path }, 404);
      },
    });

    console.log(`🚀 A2A Worker Server running on http://${config.host}:${config.port}`);
    console.log(`📋 Agent Card available at http://${config.host}:${config.port}/.well-known/agent.json`);

    // Trigger recovery of any unfinished tasks
    agent.recoverIncompleteTasks();

    return server;
  }
}
