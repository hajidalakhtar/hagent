// src/a2a/agent-card.ts
import { config } from '../config.ts';
import type { A2AAgentCard } from '../types.ts';

export function getAgentCard(hostUrl: string): A2AAgentCard {
  return {
    name: config.agentName,
    description:
      'Autonomous software engineering agent running on Pi Durable harness with Git Worktree isolation and crash recovery.',
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
    skills: [
      {
        id: 'coding_task',
        name: 'Autonomous Code Implementation',
        description:
          'Executes software engineering tasks: writes code, runs test suites, manages isolated Git worktrees, and pushes branches.',
        input_schema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Detailed instruction of the feature, fix, or task.' },
            repo: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'Git repository URL' },
                base_branch: { type: 'string', description: 'Base branch to branch off from' },
                target_branch: { type: 'string', description: 'Target branch name to create and push' },
              },
            },
          },
          required: ['prompt'],
        },
      },
    ],
  };
}
