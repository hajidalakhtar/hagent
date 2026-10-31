// src/a2a/server.ts
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { config } from '../config.ts';
import { DurableAgent } from '../agent/durable-agent.ts';
import { LLMClient } from '../llm/client.ts';
import { DurableStore } from '../store/durable-store.ts';
import type { Channel } from '../channels/types.ts';
import type { A2AEvent, A2ATask, A2ATaskCreateRequest } from '../types.ts';
import { getAgentCard } from './agent-card.ts';

const LIVE_STATE_FILE = '/data/home/a2a-monitor/data/live_state.json';

function extractPromptText(params: any): string {
  if (!params) return '';
  if (typeof params === 'string') return params;
  const msg = params.message;
  if (typeof msg === 'object' && msg !== null) {
    if (Array.isArray(msg.parts)) {
      const texts: string[] = [];
      for (const p of msg.parts) {
        if (typeof p === 'object' && p !== null && typeof p.text === 'string') {
          texts.push(p.text);
        } else if (typeof p === 'string') {
          texts.push(p);
        }
      }
      if (texts.length > 0) return texts.join('\n');
    }
    if (typeof msg.text === 'string') return msg.text;
  } else if (typeof msg === 'string') {
    return msg;
  }
  if (typeof params.text === 'string') return params.text;
  if (typeof params.prompt === 'string') return params.prompt;
  return '';
}

function extractContextId(params: any): string {
  if (typeof params === 'object' && params !== null) {
    const msg = params.message;
    if (typeof msg === 'object' && msg !== null && msg.contextId) {
      return String(msg.contextId);
    }
    if (params.contextId) {
      return String(params.contextId);
    }
  }
  return `ctx-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function extractSender(params: any, req: Request): string {
  const h = req.headers.get('x-agent-id') || req.headers.get('x-agent-name');
  if (h) return h;
  if (params?.sender) return String(params.sender);
  if (params?.from) return String(params.from);
  if (params?.message?.sender) return String(params.message.sender);
  return 'orchestrator';
}

function recordLiveStateStart(info: {
  taskId: string;
  contextId: string;
  from: string;
  to: string;
  prompt: string;
  startMs: number;
}) {
  try {
    if (!existsSync(LIVE_STATE_FILE)) return;
    const raw = readFileSync(LIVE_STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    data.activeConnections = (data.activeConnections || []).filter((c: any) => (c.activeUntil || 0) > Date.now());
    data.activeConnections.push({
      id: `conn-${crypto.randomUUID().slice(0, 8)}`,
      from: info.from,
      to: info.to,
      startTime: info.startMs,
      activeUntil: info.startMs + 180000,
      contextId: info.contextId,
      taskId: info.taskId,
      prompt: info.prompt,
    });
    data.messages = data.messages || [];
    data.messages.unshift({
      id: `msg-${crypto.randomUUID().slice(0, 8)}`,
      fromAgentId: info.from,
      toAgentId: info.to,
      contextId: info.contextId,
      taskId: info.taskId,
      prompt: info.prompt,
      status: 'RUNNING',
      timestamp: info.startMs,
    });
    data.messages = data.messages.slice(0, 100);
    const tmp = `${LIVE_STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, LIVE_STATE_FILE);
  } catch {}
}

function recordLiveStateFinish(info: {
  taskId: string;
  status: string;
  responseText: string;
  durationMs: number;
}) {
  try {
    if (!existsSync(LIVE_STATE_FILE)) return;
    const raw = readFileSync(LIVE_STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    const now = Date.now();
    for (const c of data.activeConnections || []) {
      if (c.taskId === info.taskId) {
        c.activeUntil = now + 3500;
      }
    }
    for (const m of data.messages || []) {
      if (m.taskId === info.taskId) {
        m.status = info.status;
        m.responseText = info.responseText;
        m.durationMs = info.durationMs;
        break;
      }
    }
    const tmp = `${LIVE_STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, LIVE_STATE_FILE);
  } catch {}
}

export class A2AServer {
  private store: DurableStore;
  private agent: DurableAgent;
  private llm: LLMClient;
  private channels: Channel[];

  constructor(store: DurableStore, agent: DurableAgent, channels: Channel[] = []) {
    this.store = store;
    this.agent = agent;
    this.llm = new LLMClient();
    this.channels = channels;
  }

  private jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-ID, X-Agent-Name',
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
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const method = req.method;

        // Handle CORS preflight
        if (method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-ID, X-Agent-Name',
            },
          });
        }

        const hostUrl = `${url.protocol}//${url.host}`;

        // 0. Inbound channels (GitHub bot, ...)
        for (const channel of self.channels) {
          for (const route of channel.routes) {
            const methods = Array.isArray(route.method) ? route.method : [route.method];
            if (methods.includes(method) && route.match(path)) {
              try {
                return await route.handle(req, url);
              } catch (err: any) {
                return self.jsonResponse({ error: err.message, channel: channel.name }, 500);
              }
            }
          }
        }

        // 0b. Channel introspection
        if (method === 'GET' && path === '/channels') {
          return self.jsonResponse(
            self.channels.map((c) => ({
              name: c.name,
              description: c.description,
              ...(c.info ? c.info() : {}),
            }))
          );
        }

        // 1. Agent Card Discovery
        if (method === 'GET' && (path === '/.well-known/agent.json' || path === '/agent.json' || path === '/.well-known/agent-card.json')) {
          return self.jsonResponse(
            getAgentCard(hostUrl, {
              max: agent.getMaxConcurrency(),
              active: agent.getActiveTaskCount(),
            })
          );
        }

        // 1b. Health & Status Check
        if (method === 'GET' && (path === '/health' || path === '/status' || path === '/')) {
          return self.jsonResponse({
            status: 'healthy',
            agent: config.agentName,
            agentId: config.agentId,
            version: config.agentVersion,
            slots: {
              max: agent.getMaxConcurrency(),
              active: agent.getActiveTaskCount(),
            },
            timestamp: Math.floor(Date.now() / 1000),
          });
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

        // 3. Create Task (REST)
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
              system_prompt_mode: body.system_prompt_mode,
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

        // 3b. JSON-RPC 2.0 Handler (A2A JSON-RPC Protocol on POST / or POST /tasks)
        if (method === 'POST' && (path === '/' || path === '/tasks')) {
          let bodyJson: any = null;
          try {
            bodyJson = await req.json();
          } catch (err: any) {
            return self.jsonResponse(
              { jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${err.message}` } },
              400
            );
          }

          if (bodyJson && bodyJson.jsonrpc === '2.0') {
            const reqId = bodyJson.id;
            const rpcMethod = bodyJson.method;
            const params = bodyJson.params || {};

            console.log(`[A2A JSON-RPC] method=${rpcMethod} id=${reqId}`);

            if (rpcMethod === 'SendMessage' || rpcMethod === 'message/send') {
              const userText = extractPromptText(params);
              const ctxId = extractContextId(params);
              const taskId = `task_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
              const startMs = Date.now();
              const fromAgent = extractSender(params, req);
              const toAgent = config.agentId;

              console.log(`[A2A Task Starting] task=${taskId} ctx=${ctxId} from=${fromAgent} prompt="${userText.slice(0, 80)}..."`);

              recordLiveStateStart({
                taskId,
                contextId: ctxId,
                from: fromAgent,
                to: toAgent,
                prompt: userText,
                startMs,
              });

              // Create task in durable store
              const newTask: A2ATask = {
                id: taskId,
                status: 'PENDING',
                prompt: userText,
                system_prompt: params.system_prompt || params.message?.system_prompt,
                system_prompt_mode: params.system_prompt_mode,
                repo_url: params.repo?.url,
                base_branch: params.repo?.base_branch || 'main',
                target_branch: params.repo?.target_branch || `agent/${taskId}`,
                lease_expires_at: Date.now() + config.leaseDefaultSeconds * 1000,
                created_at: Date.now(),
                updated_at: Date.now(),
                artifacts: [],
              };
              store.createTask(newTask);

              let outputText = '';
              let state = 'TASK_STATE_COMPLETED';

              try {
                const finishedTask = await agent.runTask(taskId);
                const msgs = store.getMessages(taskId);
                const assistantMsgs = msgs.filter((m) => m.role === 'assistant');
                const lastMsg = assistantMsgs[assistantMsgs.length - 1];
                outputText = lastMsg?.content || finishedTask.summary || finishedTask.error || (finishedTask.status === 'COMPLETED' ? 'Task completed successfully.' : 'Task failed.');
                state = finishedTask.status === 'COMPLETED' ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_FAILED';
              } catch (err: any) {
                outputText = `Execution error: ${err.message}`;
                state = 'TASK_STATE_FAILED';
              }

              const durationMs = Date.now() - startMs;
              console.log(`[A2A Task Finished] task=${taskId} state=${state} in ${durationMs}ms`);

              recordLiveStateFinish({
                taskId,
                status: state === 'TASK_STATE_COMPLETED' ? 'COMPLETED' : 'FAILED',
                responseText: outputText,
                durationMs,
              });

              return self.jsonResponse({
                jsonrpc: '2.0',
                id: reqId,
                result: {
                  task: {
                    id: taskId,
                    contextId: ctxId,
                    status: {
                      state,
                      message: {
                        role: 'ROLE_AGENT',
                        contextId: ctxId,
                        parts: [{ text: outputText, mediaType: 'text/plain' }],
                      },
                    },
                    artifacts: [
                      {
                        name: 'response',
                        parts: [{ text: outputText, mediaType: 'text/plain' }],
                      },
                    ],
                  },
                },
              });
            }

            if (rpcMethod === 'GetTask' || rpcMethod === 'tasks/get') {
              const targetId = params?.id || 'unknown';
              const t = store.getTask(targetId);
              return self.jsonResponse({
                jsonrpc: '2.0',
                id: reqId,
                result: {
                  task: {
                    id: targetId,
                    status: {
                      state:
                        t?.status === 'COMPLETED'
                          ? 'TASK_STATE_COMPLETED'
                          : t?.status === 'RUNNING'
                          ? 'TASK_STATE_RUNNING'
                          : 'TASK_STATE_FAILED',
                    },
                  },
                },
              });
            }

            return self.jsonResponse({
              jsonrpc: '2.0',
              id: reqId,
              error: { code: -32601, message: `Method '${rpcMethod}' not found` },
            });
          }
        }

        // 4. List Tasks (REST)
        if (method === 'GET' && path === '/tasks') {
          const limit = parseInt(url.searchParams.get('limit') || '50', 10);
          return self.jsonResponse(store.listTasks(limit));
        }

        // 5. SSE Stream for Task Events: /tasks/:id/events
        const eventsMatch = path.match(/^\/tasks\/([^/]+)\/events$/);
        if (method === 'GET' && eventsMatch) {
          const taskId = eventsMatch[1]!;
          return self.handleSSE(taskId, req);
        }

        // 6. Heartbeat renewal: /tasks/:id/heartbeat
        const heartbeatMatch = path.match(/^\/tasks\/([^/]+)\/heartbeat$/);
        if (method === 'POST' && heartbeatMatch) {
          const taskId = heartbeatMatch[1]!;
          const task = store.getTask(taskId);
          if (!task) return self.jsonResponse({ error: 'Task not found' }, 404);

          const leaseExpiresAt = store.renewLease(taskId, config.leaseDefaultSeconds * 1000);
          return self.jsonResponse({ task_id: taskId, lease_expires_at: leaseExpiresAt, status: task.status });
        }

        // 7. Cancel Task: /tasks/:id/cancel
        const cancelMatch = path.match(/^\/tasks\/([^/]+)\/cancel$/);
        if (method === 'POST' && cancelMatch) {
          const taskId = cancelMatch[1]!;
          const success = agent.cancelTask(taskId);
          return self.jsonResponse({ task_id: taskId, cancelled: success });
        }

        // 8. Task Messages: GET /tasks/:id/messages & POST /tasks/:id/messages
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

        // 9. Get Task Detail: /tasks/:id
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

    // Boot inbound channels (bind listeners, reconcile replies missed while down)
    for (const channel of self.channels) {
      Promise.resolve()
        .then(() => channel.start?.())
        .then(() => console.log(`📡 Channel "${channel.name}" online — ${channel.description}`))
        .catch((err) => console.error(`⚠️ Channel "${channel.name}" failed to start: ${err.message}`));
    }

    // Trigger recovery of any unfinished tasks
    agent.recoverIncompleteTasks();

    return server;
  }
}
