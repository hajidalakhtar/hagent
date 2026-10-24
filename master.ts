// master.ts
import { A2AMasterClient } from './src/client/master-client.ts';

const args = process.argv.slice(2);
const command = args[0] || 'help';

function getArgValue(flag: string, fallback = ''): string {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1]!;
  }
  return fallback;
}

const workerUrl = getArgValue('--worker', process.env.WORKER_URL || 'http://127.0.0.1:3000');
const client = new A2AMasterClient(workerUrl);

async function main() {
  switch (command) {
    case 'chat':
    case 'ask':
    case 'ping': {
      const message = args.slice(1).filter((a) => !a.startsWith('--')).join(' ') || getArgValue('--prompt') || 'halo';
      console.log(`💬 Sending message to worker (${workerUrl}): "${message}"...\n`);
      const res = await client.chat(message);
      console.log(`🤖 [${res.agent} | ${res.model}]:`);
      console.log(res.reply);
      console.log('');
      break;
    }

    case 'card': {
      console.log(`🔍 Inspecting Agent Card on ${workerUrl}...`);
      const card = await client.getAgentCard();
      console.log(JSON.stringify(card, null, 2));
      break;
    }

    case 'list': {
      console.log(`📋 Listing tasks on ${workerUrl}...`);
      const tasks = await client.listTasks();
      if (tasks.length === 0) {
        console.log('No tasks found.');
        return;
      }
      for (const t of tasks) {
        console.log(`[${t.status}] ${t.id} - "${t.prompt.slice(0, 50)}..." (Branch: ${t.target_branch})`);
      }
      break;
    }

    case 'status': {
      const taskId = args[1] || getArgValue('--task');
      if (!taskId) {
        console.error('Usage: bun run master.ts status <task_id>');
        process.exit(1);
      }
      const task = await client.getTask(taskId);
      console.log(JSON.stringify(task, null, 2));
      break;
    }

    case 'cancel': {
      const taskId = args[1] || getArgValue('--task');
      if (!taskId) {
        console.error('Usage: bun run master.ts cancel <task_id>');
        process.exit(1);
      }
      const res = await client.cancelTask(taskId);
      console.log(`Cancelled task ${taskId}:`, res);
      break;
    }

    case 'submit': {
      let prompt = getArgValue('--prompt') || args[1];
      const issueNum = getArgValue('--issue');
      const prNum = getArgValue('--pr');
      const systemPrompt = getArgValue('--system-prompt');

      if (issueNum) {
        prompt = `Resolve GitHub issue #${issueNum}. Inspect issue requirements using gh_issue_view, make exact code modifications, run test suite to verify, commit changes, and open a Pull Request using gh_pr_create (linking 'Closes #${issueNum}').${prompt ? `\nAdditional instructions: ${prompt}` : ''}`;
      } else if (prNum) {
        prompt = `Review GitHub Pull Request #${prNum}. Inspect PR details and diff using gh_pr_view, check code quality and test coverage, and submit review using gh_pr_review.${prompt ? `\nReview criteria: ${prompt}` : ''}`;
      }

      if (!prompt) {
        console.error('Usage: bun run master.ts submit [--issue <num>] [--pr <num>] [--prompt "instructions"] [--repo <url>]');
        process.exit(1);
      }

      const repoUrl = getArgValue('--repo');
      const baseBranch = getArgValue('--base-branch', 'main');
      const targetBranch = getArgValue('--target-branch', issueNum ? `issue-${issueNum}` : undefined);

      console.log(`\n📤 Submitting task to worker (${workerUrl})...`);
      const submission = await client.submitTask({
        prompt,
        systemPrompt,
        repo: repoUrl ? { url: repoUrl, base_branch: baseBranch, target_branch: targetBranch } : undefined,
      });

      console.log(`✅ Task Accepted! Task ID: ${submission.task_id}`);
      console.log(`⏳ Lease Expires: ${new Date(submission.lease_expires_at).toLocaleTimeString()}`);
      console.log(`📡 Connecting to live event stream...\n`);

      await client.streamEvents(submission.task_id, (event) => {
        const time = new Date(event.timestamp).toLocaleTimeString();
        switch (event.event) {
          case 'status_changed':
            console.log(`[${time}] 🚦 Status: ${event.data.status}`);
            break;
          case 'thought':
            if (event.data.content) {
              console.log(`\n💭 [Agent Thought]\n${event.data.content}\n`);
            } else if (event.data.message) {
              console.log(`[${time}] ℹ️  ${event.data.message}`);
            }
            break;
          case 'tool_call':
            console.log(`[${time}] 🛠️  [Tool Call] ${event.data.tool} -> ${event.data.arguments}`);
            break;
          case 'tool_result':
            const errTag = event.data.isError ? ' ❌ [ERROR]' : ' ✅ [SUCCESS]';
            console.log(`[${time}] ↳ [Tool Result]${errTag}\n${String(event.data.output).slice(0, 300)}...\n`);
            break;
          case 'done':
            console.log(`\n🎉 [TASK FINISHED] Status: ${event.data.status}`);
            console.log(`📝 Summary: ${event.data.summary}`);
            break;
          case 'error':
            console.error(`\n❌ [TASK ERROR]: ${event.data.error}`);
            break;
          case 'heartbeat':
            // keep-alive ping
            break;
          default:
            console.log(`[${time}] [${event.event}]`, event.data);
        }
      });

      console.log('\n🏁 Stream disconnected. Task execution finished.');
      break;
    }

    default: {
      console.log(`
Commands:
  bun run master.ts card [--worker <url>]
      Fetch and display the worker's A2A Agent Card.

  bun run master.ts submit --prompt "<task description>" [--repo <git_url>] [--worker <url>]
      Submit a coding task and stream the execution in real-time.

  bun run master.ts list [--worker <url>]
      List all tasks and statuses on the worker.

  bun run master.ts status <task_id> [--worker <url>]
      Show detailed status and artifacts for a task.

  bun run master.ts cancel <task_id> [--worker <url>]
      Cancel a running task.
      `);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
