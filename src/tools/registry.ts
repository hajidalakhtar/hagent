// src/tools/registry.ts
import { DurableStore } from '../store/durable-store.ts';
import type { A2ATaskArtifact, ToolCallRecord, ToolContext, ToolDefinition } from '../types.ts';
import { bashTool } from './bash.ts';
import { editFileTool, listFilesTool, readFileTool, writeFileTool } from './fs.ts';
import { finishTaskTool, gitCommitTool, gitStatusTool } from './git.ts';

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private store: DurableStore;

  constructor(store: DurableStore) {
    this.store = store;
    this.register(bashTool);
    this.register(readFileTool);
    this.register(writeFileTool);
    this.register(editFileTool);
    this.register(listFilesTool);
    this.register(gitStatusTool);
    this.register(gitCommitTool);
    this.register(finishTaskTool);
  }

  register(tool: ToolDefinition) {
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAllDefinitions() {
    return Array.from(this.tools.values()).map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * The Pi Durable Effect Sandwich:
   * 1. Check if tool was already executed in DB (crash recovery).
   * 2. If not, record intent with status PENDING.
   * 3. Execute side effect.
   * 4. Commit result to durable storage.
   */
  async executeWithEffectSandwich(
    call: ToolCallRecord,
    turnIndex: number,
    context: ToolContext
  ): Promise<{ output: string; isError: boolean; artifact?: A2ATaskArtifact }> {
    const existing = this.store.getToolExecution(call.id);

    // If already executed before a crash, return persisted result without re-executing side effect
    if (existing && existing.status === 'COMPLETED' && existing.result !== undefined) {
      context.logger(`[Durable Replay] Tool ${call.function.name} already completed. Using persisted result.`);
      return { output: existing.result, isError: false };
    }

    const tool = this.tools.get(call.function.name);
    if (!tool) {
      const err = `Tool ${call.function.name} not found`;
      this.store.recordToolIntent({
        id: call.id,
        task_id: context.task_id,
        turn_index: turnIndex,
        tool_name: call.function.name,
        arguments: call.function.arguments,
      });
      this.store.commitToolResult(call.id, err, true);
      return { output: err, isError: true };
    }

    // Step 1: Record Intent (Pending)
    if (!existing) {
      this.store.recordToolIntent({
        id: call.id,
        task_id: context.task_id,
        turn_index: turnIndex,
        tool_name: call.function.name,
        arguments: call.function.arguments,
      });
    } else {
      this.store.updateToolExecutionStatus(call.id, 'RUNNING');
    }

    // Step 2: Execute side effect
    let args: any = {};
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      args = {};
    }

    try {
      context.logger(`[Executing Tool] ${call.function.name}(${JSON.stringify(args)})`);
      const result = await tool.execute(args, context);

      // Step 3: Commit result to SQLite
      this.store.commitToolResult(call.id, result.output, result.isError);

      if (result.artifact) {
        this.store.addArtifact(context.task_id, result.artifact);
      }

      return {
        output: result.output,
        isError: result.isError || false,
        artifact: result.artifact,
      };
    } catch (err: any) {
      const errorMsg = `Exception in tool ${call.function.name}: ${err.message}`;
      this.store.commitToolResult(call.id, errorMsg, true);
      return { output: errorMsg, isError: true };
    }
  }
}
