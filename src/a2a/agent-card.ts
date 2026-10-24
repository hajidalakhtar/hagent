// src/a2a/agent-card.ts
import { config } from '../config.ts';
import type { A2AAgentCard } from '../types.ts';

export function getAgentCard(hostUrl: string, slots?: { max: number; active: number }): A2AAgentCard & { slots?: { max: number; active: number } } {
  return {
    name: `${config.agentName} [${config.agentId}]`,
    description:
      'Autonomous tactical execution coding worker running on Pi Durable with Git Worktree isolation. Designed to receive decomposed sub-tasks from Master Agents (Claude Code, Google Antigravity, Pi Agent).',
    version: config.agentVersion,
    endpoints: {
      agent_card: `${hostUrl}/.well-known/agent.json`,
      tasks: `${hostUrl}/tasks`,
      heartbeat: `${hostUrl}/tasks/{id}/heartbeat`,
    },
    capabilities: {
      streaming: true,
      tools: [
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
        id: 'execute_coding_subtask',
        name: 'Execute Tactical Coding Subtask',
        description:
          'Executes concrete code edits, runs verification test suites, commits to dedicated Git branch/worktree, and produces diff artifacts for the Master Agent.',
        input_schema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Concrete instructions on what to change and what tests to run.' },
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
