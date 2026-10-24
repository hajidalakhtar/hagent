// src/tools/bash.ts
import type { ToolContext, ToolDefinition } from '../types.ts';

export const bashTool: ToolDefinition = {
  name: 'bash_run',
  description: 'Executes a bash shell command inside the task worktree directory. Can run build, test, install, grep, etc.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The exact bash command line string to execute.',
      },
      timeout_seconds: {
        type: 'number',
        description: 'Maximum seconds to wait before terminating the command (default 60).',
      },
    },
    required: ['command'],
  },
  execute: async (args: { command: string; timeout_seconds?: number }, context: ToolContext) => {
    const timeout = (args.timeout_seconds || 60) * 1000;

    try {
      const proc = Bun.spawn(['bash', '-c', args.command], {
        cwd: context.worktree_dir,
        env: {
          ...process.env,
          ...context.env,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Implement timeout
      const timeoutPromise = new Promise<{ stdout: string; stderr: string; exitCode: number }>((_, reject) => {
        setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          reject(new Error(`Command timed out after ${timeout / 1000}s`));
        }, timeout);
      });

      const execPromise = (async () => {
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        return { stdout, stderr, exitCode };
      })();

      const result = await Promise.race([execPromise, timeoutPromise]);

      const outputParts = [];
      if (result.stdout) outputParts.push(`[stdout]\n${result.stdout.trim()}`);
      if (result.stderr) outputParts.push(`[stderr]\n${result.stderr.trim()}`);
      outputParts.push(`[exit code: ${result.exitCode}]`);

      return {
        output: outputParts.join('\n\n') || '(no output)',
        isError: result.exitCode !== 0,
      };
    } catch (err: any) {
      return {
        output: `Error executing command: ${err.message}`,
        isError: true,
      };
    }
  },
};
