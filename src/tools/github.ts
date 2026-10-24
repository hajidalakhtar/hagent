// src/tools/github.ts
import { config } from '../config.ts';
import type { ToolContext, ToolDefinition } from '../types.ts';

async function runGh(args: string[], context: ToolContext): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...context.env,
  };

  // Ensure GitHub token is present if available
  if (config.githubToken && !env.GH_TOKEN && !env.GITHUB_TOKEN) {
    env.GH_TOKEN = config.githubToken;
    env.GITHUB_TOKEN = config.githubToken;
  }

  const proc = Bun.spawn(['gh', ...args], {
    cwd: context.worktree_dir,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

export const ghIssueViewTool: ToolDefinition = {
  name: 'gh_issue_view',
  description: 'Fetches details of a GitHub issue (title, description, author, labels, and recent comments).',
  parameters: {
    type: 'object',
    properties: {
      issue_number: {
        type: 'number',
        description: 'The GitHub issue number to inspect.',
      },
      repo: {
        type: 'string',
        description: 'Optional "owner/repo" if different from current git origin.',
      },
    },
    required: ['issue_number'],
  },
  execute: async (args: { issue_number: number; repo?: string }, context: ToolContext) => {
    const ghArgs = ['issue', 'view', String(args.issue_number), '--json', 'number,title,body,author,labels,comments'];
    if (args.repo) {
      ghArgs.push('-R', args.repo);
    }

    const res = await runGh(ghArgs, context);
    if (res.exitCode !== 0) {
      return { output: `Failed to view issue #${args.issue_number}: ${res.stderr || res.stdout}`, isError: true };
    }

    try {
      const data = JSON.parse(res.stdout);
      const comments = (data.comments || [])
        .slice(-5)
        .map((c: any) => `[${c.author?.login || 'user'}]: ${c.body}`)
        .join('\n---\n');

      const formatted = [
        `Issue #${data.number}: ${data.title}`,
        `Author: ${data.author?.login || 'unknown'}`,
        `Labels: ${(data.labels || []).map((l: any) => l.name).join(', ') || 'none'}`,
        `\nDescription:\n${data.body || '(no description)'}`,
        comments ? `\nRecent Comments:\n${comments}` : '',
      ].join('\n');

      return { output: formatted };
    } catch {
      return { output: res.stdout };
    }
  },
};

export const ghIssueCommentTool: ToolDefinition = {
  name: 'gh_issue_comment',
  description: 'Adds a comment to a GitHub issue (e.g. progress update or link to PR).',
  parameters: {
    type: 'object',
    properties: {
      issue_number: {
        type: 'number',
        description: 'The GitHub issue number to comment on.',
      },
      body: {
        type: 'string',
        description: 'Markdown comment content.',
      },
      repo: {
        type: 'string',
        description: 'Optional "owner/repo" if different from current git origin.',
      },
    },
    required: ['issue_number', 'body'],
  },
  execute: async (args: { issue_number: number; body: string; repo?: string }, context: ToolContext) => {
    const ghArgs = ['issue', 'comment', String(args.issue_number), '--body', args.body];
    if (args.repo) {
      ghArgs.push('-R', args.repo);
    }

    const res = await runGh(ghArgs, context);
    if (res.exitCode !== 0) {
      return { output: `Failed to comment on issue #${args.issue_number}: ${res.stderr || res.stdout}`, isError: true };
    }

    return { output: `Successfully commented on issue #${args.issue_number}: ${res.stdout}` };
  },
};

export const ghPrCreateTool: ToolDefinition = {
  name: 'gh_pr_create',
  description: 'Pushes the current target branch to GitHub and opens a new Pull Request.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Pull request title (e.g. "fix: resolve token expiry in auth middleware (#42)").',
      },
      body: {
        type: 'string',
        description: 'Pull request markdown description explaining changes, tests run, and closing issue if applicable (e.g. "Closes #42").',
      },
      base_branch: {
        type: 'string',
        description: 'Base branch to merge into (default "main").',
      },
      draft: {
        type: 'boolean',
        description: 'Whether to create the PR as a draft (default false).',
      },
    },
    required: ['title', 'body'],
  },
  execute: async (args: { title: string; body: string; base_branch?: string; draft?: boolean }, context: ToolContext) => {
    // 1. Get current branch name
    const branchProc = Bun.spawn(['git', 'branch', '--show-current'], { cwd: context.worktree_dir, stdout: 'pipe' });
    const currentBranch = (await new Response(branchProc.stdout).text()).trim();

    if (!currentBranch) {
      return { output: 'Failed to determine current git branch', isError: true };
    }

    // 2. Push branch to remote origin
    context.logger(`Pushing branch ${currentBranch} to remote origin...`);
    const pushProc = Bun.spawn(['git', 'push', '-u', 'origin', currentBranch], {
      cwd: context.worktree_dir,
      env: { ...process.env, ...context.env, GH_TOKEN: config.githubToken },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const pushStderr = await new Response(pushProc.stderr).text();
    const pushCode = await pushProc.exited;

    if (pushCode !== 0 && !pushStderr.includes('Everything up-to-date')) {
      return { output: `Git push failed: ${pushStderr}`, isError: true };
    }

    // 3. Create PR using gh CLI
    const baseBranch = args.base_branch || 'main';
    const ghArgs = [
      'pr',
      'create',
      '--title',
      args.title,
      '--body',
      args.body,
      '--base',
      baseBranch,
      '--head',
      currentBranch,
    ];
    if (args.draft) {
      ghArgs.push('--draft');
    }

    const res = await runGh(ghArgs, context);
    if (res.exitCode !== 0) {
      return { output: `Failed to create pull request: ${res.stderr || res.stdout}`, isError: true };
    }

    const prUrl = res.stdout.trim();
    return {
      output: `Pull request created successfully:\n${prUrl}`,
      artifact: {
        type: 'github_pr',
        name: 'pull_request_url',
        value: prUrl,
        metadata: {
          title: args.title,
          branch: currentBranch,
          base: baseBranch,
        },
      },
    };
  },
};

export const ghPrViewTool: ToolDefinition = {
  name: 'gh_pr_view',
  description: 'Inspects a Pull Request details, status, review comments, and git diff.',
  parameters: {
    type: 'object',
    properties: {
      pr_number: {
        type: 'number',
        description: 'The Pull Request number to inspect.',
      },
      include_diff: {
        type: 'boolean',
        description: 'Whether to include the full git diff of the PR (default true).',
      },
      repo: {
        type: 'string',
        description: 'Optional "owner/repo" if different from current origin.',
      },
    },
    required: ['pr_number'],
  },
  execute: async (args: { pr_number: number; include_diff?: boolean; repo?: string }, context: ToolContext) => {
    const ghArgs = [
      'pr',
      'view',
      String(args.pr_number),
      '--json',
      'number,title,body,state,headRefName,baseRefName,reviews,mergeable',
    ];
    if (args.repo) ghArgs.push('-R', args.repo);

    const res = await runGh(ghArgs, context);
    if (res.exitCode !== 0) {
      return { output: `Failed to view PR #${args.pr_number}: ${res.stderr || res.stdout}`, isError: true };
    }

    let diffText = '';
    if (args.include_diff !== false) {
      const diffArgs = ['pr', 'diff', String(args.pr_number)];
      if (args.repo) diffArgs.push('-R', args.repo);
      const diffRes = await runGh(diffArgs, context);
      if (diffRes.exitCode === 0) {
        diffText = `\n\n--- PR Diff ---\n${diffRes.stdout.slice(0, 4000)}${diffRes.stdout.length > 4000 ? '\n...(diff truncated)...' : ''}`;
      }
    }

    return { output: `${res.stdout}${diffText}` };
  },
};

export const ghPrReviewTool: ToolDefinition = {
  name: 'gh_pr_review',
  description: 'Submits a review on a Pull Request (comment, approve, or request changes).',
  parameters: {
    type: 'object',
    properties: {
      pr_number: {
        type: 'number',
        description: 'The Pull Request number to review.',
      },
      action: {
        type: 'string',
        enum: ['comment', 'approve', 'request_changes'],
        description: 'Review decision: comment, approve, or request_changes.',
      },
      body: {
        type: 'string',
        description: 'Review comments and feedback markdown text.',
      },
      repo: {
        type: 'string',
        description: 'Optional "owner/repo" if different from current origin.',
      },
    },
    required: ['pr_number', 'action', 'body'],
  },
  execute: async (args: { pr_number: number; action: 'comment' | 'approve' | 'request_changes'; body: string; repo?: string }, context: ToolContext) => {
    const ghArgs = ['pr', 'review', String(args.pr_number), '--body', args.body];

    if (args.action === 'approve') {
      ghArgs.push('--approve');
    } else if (args.action === 'request_changes') {
      ghArgs.push('--request-changes');
    } else {
      ghArgs.push('--comment');
    }

    if (args.repo) ghArgs.push('-R', args.repo);

    const res = await runGh(ghArgs, context);
    if (res.exitCode !== 0) {
      return { output: `Failed to review PR #${args.pr_number}: ${res.stderr || res.stdout}`, isError: true };
    }

    return { output: `Successfully submitted ${args.action} review on PR #${args.pr_number}: ${res.stdout || 'Done'}` };
  },
};
