// src/a2a/agent-card.ts
import { config } from '../config.ts';
import type { A2AAgentCard } from '../types.ts';

export function getAgentCard(hostUrl: string, slots?: { max: number; active: number }): A2AAgentCard & { slots?: { max: number; active: number } } {
  return {
    name: `${config.agentName} [${config.agentId}]`,
    description:
      'Autonomous tactical execution coding worker running on Pi Durable with Git Worktree isolation and GitHub CLI integration. Handles GitHub Issues, code edits, verification tests, PR creation, and PR reviews.',
    version: config.agentVersion,
    endpoints: {
      agent_card: `${hostUrl}/.well-known/agent.json`,
      tasks: `${hostUrl}/tasks`,
      heartbeat: `${hostUrl}/tasks/{id}/heartbeat`,
    },
    capabilities: {
      streaming: true,
      tools: [
        'gh_issue_view',
        'gh_issue_comment',
        'gh_pr_create',
        'gh_pr_view',
        'gh_pr_review',
        'bash_run',
        'read_file',
        'write_file',
        'edit_file',
        'list_files',
        'git_status',
        'git_commit',
        'finish_task',
      ],
      languages: ['typescript', 'javascript', 'python', 'go', 'rust', 'shell', 'any'],
    },
    slots: slots || { max: config.concurrency, active: 0 },
    skills: [
      {
        id: 'execute_github_task',
        name: 'GitHub Issue & Pull Request Automation',
        description:
          'Fetches GitHub issues, implements features/bugfixes in dedicated Git worktrees, runs tests, creates Pull Requests via GitHub CLI, and performs PR reviews.',
        input_schema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Instructions on the issue to solve or PR to review.' },
            system_prompt: { type: 'string', description: 'Optional custom system prompt to guide this specific execution.' },
            repo: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'Git repository URL' },
                base_branch: { type: 'string', description: 'Base branch name' },
                target_branch: { type: 'string', description: 'Dedicated branch for this subtask' },
              },
            },
          },
          required: ['prompt'],
        },
      },
    ],
  };
}
