// src/tools/git.ts
import type { ToolContext, ToolDefinition } from '../types.ts';

async function runGit(args: string[], cwd: string) {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

export const gitStatusTool: ToolDefinition = {
  name: 'git_status',
  description: 'Shows the current working tree status and branch info.',
  parameters: {
    type: 'object',
    properties: {},
  },
  execute: async (_args: any, context: ToolContext) => {
    const branchRes = await runGit(['branch', '--show-current'], context.worktree_dir);
    const statusRes = await runGit(['status', '--short'], context.worktree_dir);
    const diffRes = await runGit(['diff', '--stat'], context.worktree_dir);

    const output = [
      `Branch: ${branchRes.stdout || 'unknown'}`,
      'Status:',
      statusRes.stdout || '(clean working tree)',
      diffRes.stdout ? `\nDiff Summary:\n${diffRes.stdout}` : '',
    ].join('\n');

    return { output };
  },
};

export const gitCommitTool: ToolDefinition = {
  name: 'git_commit',
  description: 'Stages all changes and creates a commit with the specified message.',
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Descriptive commit message.',
      },
    },
    required: ['message'],
  },
  execute: async (args: { message: string }, context: ToolContext) => {
    await runGit(['add', '-A'], context.worktree_dir);
    const commitRes = await runGit(['commit', '-m', args.message], context.worktree_dir);

    if (commitRes.exitCode !== 0) {
      if (commitRes.stdout.includes('nothing to commit') || commitRes.stderr.includes('nothing to commit')) {
        return { output: 'Nothing to commit (working tree clean).' };
      }
      return { output: `Git commit error: ${commitRes.stderr || commitRes.stdout}`, isError: true };
    }

    const shaRes = await runGit(['rev-parse', 'HEAD'], context.worktree_dir);
    const commitSha = shaRes.stdout;

    return {
      output: `Committed successfully: [${commitSha.slice(0, 7)}] ${args.message}`,
      artifact: {
        type: 'git_commit',
        name: 'git_commit',
        value: commitSha,
        metadata: { message: args.message },
      },
    };
  },
};

export const finishTaskTool: ToolDefinition = {
  name: 'finish_task',
  description: 'Signals that the coding task is completely finished. Provides final summary.',
  parameters: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Comprehensive summary of what was implemented or fixed, files touched, and test results.',
      },
    },
    required: ['summary'],
  },
  execute: async (args: { summary: string }) => {
    return {
      output: `Task completion acknowledged. Summary: ${args.summary}`,
      artifact: {
        type: 'summary',
        name: 'task_summary',
        value: args.summary,
      },
    };
  },
};
