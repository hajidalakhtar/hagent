// src/agent/durable-agent.ts
import { EventEmitter } from 'node:events';
import { config } from '../config.ts';
import { LLMClient } from '../llm/client.ts';
import { WorktreeManager } from '../sandbox/worktree.ts';
import { DurableStore } from '../store/durable-store.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { A2AEvent, A2ATask, AgentMessage, ToolContext } from '../types.ts';
import { getCodingAgentSystemPrompt } from './prompt.ts';

export class DurableAgent extends EventEmitter {
  private store: DurableStore;
  private worktreeMgr: WorktreeManager;
  private tools: ToolRegistry;
  private llm: LLMClient;
  private runningTasks = new Set<string>();
  private maxConcurrency: number;

  constructor(store: DurableStore, worktreeMgr: WorktreeManager, concurrency = config.concurrency) {
    super();
    this.store = store;
    this.worktreeMgr = worktreeMgr;
    this.tools = new ToolRegistry(store);
    this.llm = new LLMClient();
    this.maxConcurrency = concurrency;
  }

  emitA2AEvent(event: A2AEvent) {
    this.emit('task_event', event);
    this.emit(`task_event:${event.task_id}`, event);
  }

  isTaskRunning(taskId: string): boolean {
    return this.runningTasks.has(taskId);
  }

  getActiveTaskCount(): number {
    return this.runningTasks.size;
  }

  getMaxConcurrency(): number {
    return this.maxConcurrency;
  }

  cancelTask(taskId: string): boolean {
    const task = this.store.getTask(taskId);
    if (!task) return false;
    this.runningTasks.delete(taskId);
    this.store.updateTaskStatus(taskId, 'CANCELLED', 'Task cancelled by user/master request');
    this.emitA2AEvent({
      event: 'status_changed',
      task_id: taskId,
      timestamp: Date.now(),
      data: { status: 'CANCELLED' },
    });
    this.processQueue();
    return true;
  }

  /**
   * Schedules a task: if slots are free, executes immediately; otherwise leaves in PENDING queue
   */
  schedule(taskId: string): void {
    if (this.runningTasks.size < this.maxConcurrency) {
      this.runTask(taskId).catch((err) => {
        console.error(`[Task Execution Error] Task ${taskId}:`, err.message);
      });
    } else {
      console.log(`[Queue] Task ${taskId} queued. Active tasks: ${this.runningTasks.size}/${this.maxConcurrency}`);
      this.emitA2AEvent({
        event: 'status_changed',
        task_id: taskId,
        timestamp: Date.now(),
        data: { status: 'PENDING', message: 'Queued waiting for available worker slot' },
      });
    }
  }

  /**
   * Triggers pending tasks if concurrency slots are available
   */
  processQueue(): void {
    if (this.runningTasks.size >= this.maxConcurrency) return;

    const availableSlots = this.maxConcurrency - this.runningTasks.size;
    const pendingTasks = this.store.getPendingTasks(availableSlots);

    for (const task of pendingTasks) {
      if (!this.runningTasks.has(task.id)) {
        console.log(`[Queue] Dispatched queued task ${task.id} to worker slot`);
        this.runTask(task.id).catch((err) => {
          console.error(`[Task Execution Error] Task ${task.id}:`, err.message);
        });
      }
    }
  }

  /**
   * Runs or resumes a task in the Pi Durable loop
   */
  async runTask(taskId: string): Promise<A2ATask> {
    if (this.runningTasks.has(taskId)) {
      throw new Error(`Task ${taskId} is already executing.`);
    }

    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found in store.`);
    }

    if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
      return task;
    }

    this.runningTasks.add(taskId);
    this.store.updateTaskStatus(taskId, 'RUNNING');
    this.emitA2AEvent({
      event: 'status_changed',
      task_id: taskId,
      timestamp: Date.now(),
      data: { status: 'RUNNING' },
    });

    try {
      // 1. Prepare Dedicated Worktree for this task
      let worktreeDir = task.worktree_dir;
      if (!worktreeDir) {
        const prep = await this.worktreeMgr.prepare(
          task.id,
          task.repo_url,
          task.base_branch,
          task.target_branch
        );
        worktreeDir = prep.worktreeDir;
        this.store.updateTaskStatus(taskId, 'RUNNING');
      }

      // Add git branch artifact
      this.store.addArtifact(taskId, {
        type: 'git_branch',
        name: 'target_branch',
        value: task.target_branch,
      });

      // 2. Load or Initialize Messages
      let messages = this.store.getMessages(taskId);
      if (messages.length === 0) {
        const systemPrompt = getCodingAgentSystemPrompt({
          taskId,
          worktreeDir,
          baseBranch: task.base_branch,
          targetBranch: task.target_branch,
          repoUrl: task.repo_url,
          customSystemPrompt: task.system_prompt,
          systemPromptMode: task.system_prompt_mode,
        });

        const sysMsg: AgentMessage = {
          id: `msg_${crypto.randomUUID()}`,
          task_id: taskId,
          turn_index: 0,
          role: 'system',
          content: systemPrompt,
          created_at: Date.now(),
        };
        this.store.addMessage(sysMsg);

        const userMsg: AgentMessage = {
          id: `msg_${crypto.randomUUID()}`,
          task_id: taskId,
          turn_index: 0,
          role: 'user',
          content: task.prompt,
          created_at: Date.now(),
        };
        this.store.addMessage(userMsg);

        messages = [sysMsg, userMsg];
      }

      // 3. Setup Context & Tool definitions
      const context: ToolContext = {
        task_id: taskId,
        worktree_dir: worktreeDir,
        env: {},
        logger: (msg: string) => {
          this.emitA2AEvent({
            event: 'thought',
            task_id: taskId,
            timestamp: Date.now(),
            data: { message: msg },
          });
        },
      };

      const toolDefs = this.tools.getAllDefinitions();
      let isDone = false;
      let finalSummary = '';

      // 4. Pi Durable Agent Loop
      const maxTurns = config.maxTurnsPerTask;
      let currentTurn = messages.length > 0 ? Math.max(...messages.map((m) => m.turn_index)) + 1 : 1;

      while (!isDone && currentTurn <= maxTurns) {
        // Check if task was cancelled asynchronously
        const currentTaskState = this.store.getTask(taskId);
        if (!currentTaskState || currentTaskState.status === 'CANCELLED') {
          break;
        }

        // Renew lease
        this.store.renewLease(taskId, config.leaseDefaultSeconds * 1000);
        this.emitA2AEvent({
          event: 'heartbeat',
          task_id: taskId,
          timestamp: Date.now(),
          data: { lease_expires_at: currentTaskState.lease_expires_at },
        });

        // Call LLM
        const currentHistory = this.store.getMessages(taskId);
        const response = await this.llm.chat(currentHistory, toolDefs);
        console.log("[AGENT TURN " + currentTurn + "] Content: ", (response.content || "").slice(0, 100), " Tools: ", response.toolCalls ? response.toolCalls.map(t => t.function.name) : "none");

        // Record assistant response
        const assistantMsg: AgentMessage = {
          id: `msg_${crypto.randomUUID()}`,
          task_id: taskId,
          turn_index: currentTurn,
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.toolCalls,
          created_at: Date.now(),
        };
        this.store.addMessage(assistantMsg);

        if (response.content) {
          this.emitA2AEvent({
            event: 'thought',
            task_id: taskId,
            timestamp: Date.now(),
            data: { content: response.content },
          });
        }

        // If no tool calls, model concluded
        if (!response.toolCalls || response.toolCalls.length === 0) {
          if (!response.content || response.content.trim() === "") {
            console.log("[AGENT TURN " + currentTurn + "] Empty content without tool calls, nudging...");
            this.store.addMessage({
              id: "msg_" + crypto.randomUUID(),
              task_id: taskId,
              turn_index: currentTurn,
              role: "user",
              content: "Lanjutkan pekerjaanmu sesuai instruksi sampai selesai.",
              created_at: Date.now(),
            });
            currentTurn++;
            continue;
          }
          finalSummary = response.content || "Execution completed.";
          isDone = true;
          break;
        }

        // Step through Tool Calls with Effect Sandwich
        for (const call of response.toolCalls) {
          this.emitA2AEvent({
            event: 'tool_call',
            task_id: taskId,
            timestamp: Date.now(),
            data: { tool: call.function.name, arguments: call.function.arguments },
          });

          const result = await this.tools.executeWithEffectSandwich(call, currentTurn, context);

          // Record Tool Result Message
          const toolMsg: AgentMessage = {
            id: `msg_${crypto.randomUUID()}`,
            task_id: taskId,
            turn_index: currentTurn,
            role: 'tool',
            name: call.function.name,
            tool_call_id: call.id,
            content: result.output,
            created_at: Date.now(),
          };
          this.store.addMessage(toolMsg);

          this.emitA2AEvent({
            event: 'tool_result',
            task_id: taskId,
            timestamp: Date.now(),
            data: {
              tool: call.function.name,
              output: result.output,
              isError: result.isError,
            },
          });

          // Check if finish_task was called
          if (call.function.name === 'finish_task') {
            try {
              const parsed = JSON.parse(call.function.arguments);
              finalSummary = parsed.summary || 'Task completed successfully.';
            } catch {
              finalSummary = 'Task completed successfully.';
            }
            isDone = true;
            break;
          }
        }

        currentTurn++;
      }

      if (currentTurn > maxTurns && !isDone) {
        throw new Error(`Task exceeded maximum allowed turns (${maxTurns}) without completing.`);
      }

      // 5. Finalize task
      this.store.updateTaskStatus(taskId, 'COMPLETED', undefined, finalSummary);

      // Attempt git push if remote repo is configured (channel tasks are read-only by default)
      if (task.repo_url && !task.no_push) {
        try {
          await this.worktreeMgr.push(worktreeDir, task.target_branch);
        } catch (pushErr: any) {
          context.logger(`Git push note: ${pushErr.message}`);
        }
      }

      this.emitA2AEvent({
        event: 'done',
        task_id: taskId,
        timestamp: Date.now(),
        data: { status: 'COMPLETED', summary: finalSummary },
      });

      return this.store.getTask(taskId)!;
    } catch (err: any) {
      this.store.updateTaskStatus(taskId, 'FAILED', err.message);
      this.emitA2AEvent({
        event: 'error',
        task_id: taskId,
        timestamp: Date.now(),
        data: { error: err.message },
      });
      throw err;
    } finally {
      this.runningTasks.delete(taskId);
      // Automatically drain queue
      this.processQueue();
    }
  }

  /**
   * Resumes all pending or running tasks that were interrupted (e.g. after crash / reboot)
   */
  async recoverIncompleteTasks(): Promise<void> {
    const incomplete = this.store.getIncompleteTasks();
    if (incomplete.length === 0) return;

    console.log(`[Durable Recovery] Found ${incomplete.length} incomplete tasks. Processing...`);
    for (const t of incomplete) {
      this.schedule(t.id);
    }
  }
}
