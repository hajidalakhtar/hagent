// src/a2a/server.ts
import { config } from '../config.ts';
import { DurableAgent } from '../agent/durable-agent.ts';
import { DurableStore } from '../store/durable-store.ts';
import type { A2AEvent, A2ATask, A2ATaskCreateRequest } from '../types.ts';
import { getAgentCard } from './agent-card.ts';

export class A2AServer {
  private store: DurableStore;
  private agent: DurableAgent;

  constructor(store: DurableStore, agent: DurableAgent) {
    this.store = store;
    this.agent = agent;
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
          return self.jsonResponse(getAgentCard(hostUrl));
        }

        // 2. Create Task
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
              repo_url: body.repo?.url,
              base_branch: body.repo?.base_branch || 'main',
              target_branch: body.repo?.target_branch || `agent/${taskId}`,
              lease_expires_at: now + leaseSeconds * 1000,
              created_at: now,
              updated_at: now,
              artifacts: [],
            };

            store.createTask(newTask);

            // Execute asynchronously in Pi Durable loop
            setTimeout(() => {
              agent.runTask(taskId).catch((err) => {
                console.error(`[Task Execution Error] Task ${taskId}:`, err.message);
              });
            }, 10);

            return self.jsonResponse(
              {
                task_id: taskId,
                status: 'PENDING',
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

        // 7. Get Task Detail: /tasks/:id
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
