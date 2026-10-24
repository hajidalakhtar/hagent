// skills/a2a-worker-fleet/scripts/fleet.ts
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface FleetConfig {
  workers: string[];
}

function loadWorkers(): string[] {
  // 1. Check FLEET_WORKERS env var
  if (process.env.FLEET_WORKERS) {
    return process.env.FLEET_WORKERS.split(',').map((w) => w.trim()).filter(Boolean);
  }

  // 2. Check fleet.config.json
  const configPath = resolve(process.cwd(), 'fleet.config.json');
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as FleetConfig;
      if (Array.isArray(parsed.workers)) {
        return parsed.workers;
      }
    } catch {}
  }

  // 3. Fallback to default local worker
  return ['http://127.0.0.1:3000'];
}

const args = process.argv.slice(2);
const command = args[0] || 'help';

function getArgValue(flag: string, fallback = ''): string {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1]!;
  }
  return fallback;
}

const hasFlag = (flag: string) => args.includes(flag);

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function getWorkerStatus(workerUrl: string) {
  const url = workerUrl.replace(/\/+$/, '');
  try {
    const res = await fetchWithTimeout(`${url}/.well-known/agent.json`, {}, 3000);
    if (!res.ok) {
      return { workerUrl, online: false, error: `HTTP ${res.status}` };
    }
    const card = (await res.json()) as any;
    return {
      workerUrl,
      online: true,
      name: card.name,
      slots: card.slots || { max: 1, active: 0 },
      skills: card.skills || [],
    };
  } catch (err: any) {
    return { workerUrl, online: false, error: err.name === 'AbortError' ? 'Timeout' : err.message };
  }
}

async function main() {
  const workers = loadWorkers();

  switch (command) {
    case 'ping':
    case 'chat': {
      const msg = args.slice(1).filter((a) => !a.startsWith('--')).join(' ') || 'halo';
      const targetWorker = getArgValue('--worker', workers[0] || 'http://127.0.0.1:3000');
      console.log(`💬 Pinging worker ${targetWorker} with: "${msg}"...\n`);
      try {
        const res = await fetch(`${targetWorker.replace(/\/+$/, '')}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg }),
        });
        if (!res.ok) {
          console.error(`❌ Ping failed (${res.status}): ${await res.text()}`);
          process.exit(1);
        }
        const data = (await res.json()) as any;
        console.log(`🤖 [${data.agent} | ${data.model}]:`);
        console.log(data.reply);
        console.log('');
      } catch (err: any) {
        console.error(`❌ Failed to connect: ${err.message}`);
      }
      break;
    }

    case 'status':
    case 'list': {
      console.log(`\n🔍 Checking status of ${workers.length} worker node(s) on Tailscale fleet...\n`);
      const results = await Promise.all(workers.map(getWorkerStatus));

      console.log(
        '| Worker URL                | Status  | Active / Max Slots | Agent Name                         |'
      );
      console.log(
        '|---------------------------|---------|--------------------|------------------------------------|'
      );

      for (const r of results) {
        const urlCol = r.workerUrl.padEnd(25);
        if (r.online) {
          const statusCol = '🟢 Online'.padEnd(7);
          const slotsCol = `  ${r.slots.active} / ${r.slots.max}`.padEnd(18);
          const nameCol = (r.name || 'Worker').slice(0, 34).padEnd(34);
          console.log(`| ${urlCol} | ${statusCol} | ${slotsCol} | ${nameCol} |`);
        } else {
          const statusCol = '🔴 Down '.padEnd(7);
          const slotsCol = '  - / -           '.slice(0, 18);
          const errCol = (r.error || 'Unreachable').slice(0, 34).padEnd(34);
          console.log(`| ${urlCol} | ${statusCol} | ${slotsCol} | ${errCol} |`);
        }
      }
      console.log('');
      break;
    }

    case 'dispatch': {
      let prompt = getArgValue('--prompt');
      const issueNum = getArgValue('--issue');
      const prNum = getArgValue('--pr');
      const systemPrompt = getArgValue('--system-prompt');

      if (issueNum) {
        prompt = `Resolve GitHub issue #${issueNum}. Inspect issue requirements using gh_issue_view, make exact code modifications, run test suite to verify, commit changes, and open a Pull Request using gh_pr_create (linking 'Closes #${issueNum}').${prompt ? `\nAdditional instructions: ${prompt}` : ''}`;
      } else if (prNum) {
        prompt = `Review GitHub Pull Request #${prNum}. Inspect PR details and diff using gh_pr_view, check code quality and test coverage, and submit review using gh_pr_review.${prompt ? `\nReview criteria: ${prompt}` : ''}`;
      }

      if (!prompt) {
        console.error('Error: --prompt, --issue, or --pr is required.');
        process.exit(1);
      }

      const repoUrl = getArgValue('--repo');
      const baseBranch = getArgValue('--base-branch', 'main');
      const targetBranch = getArgValue('--target-branch', issueNum ? `issue-${issueNum}` : undefined);
      let targetWorker = getArgValue('--worker');

      // Auto load-balancing if worker not specified
      if (!targetWorker) {
        console.log('⚡ Auto-discovering least busy worker in fleet...');
        const statuses = await Promise.all(workers.map(getWorkerStatus));
        const available = statuses.filter((s) => s.online && s.slots.active < s.slots.max);

        if (available.length === 0) {
          // Fallback to any online worker
          const anyOnline = statuses.filter((s) => s.online);
          if (anyOnline.length === 0) {
            console.error('❌ Error: No online workers available in the fleet!');
            process.exit(1);
          }
          targetWorker = anyOnline[0]!.workerUrl;
          console.log(`⚠️ All workers at capacity. Queueing on ${targetWorker}...`);
        } else {
          // Sort by lowest load
          available.sort((a, b) => a.slots.active / a.slots.max - b.slots.active / b.slots.max);
          targetWorker = available[0]!.workerUrl;
          console.log(`🎯 Selected worker: ${targetWorker} (Load: ${available[0]!.slots.active}/${available[0]!.slots.max})`);
        }
      }

      console.log(`🚀 Dispatching subtask to ${targetWorker}...`);
      const payload: any = {
        prompt,
        system_prompt: systemPrompt,
        repo: repoUrl
          ? {
              url: repoUrl,
              base_branch: baseBranch,
              target_branch: targetBranch,
            }
          : undefined,
      };

      const res = await fetch(`${targetWorker.replace(/\/+$/, '')}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`❌ Dispatch failed (${res.status}): ${err}`);
        process.exit(1);
      }

      const result = (await res.json()) as any;
      console.log(`✅ Task Submitted successfully!`);
      console.log(`   Task ID:       ${result.task_id}`);
      console.log(`   Initial Status: ${result.status}`);
      console.log(`   Worker:        ${targetWorker}`);

      if (hasFlag('--watch')) {
        console.log(`\n📡 Live streaming execution events...\n`);
        await streamTaskEvents(targetWorker, result.task_id);
      }
      break;
    }

    case 'watch': {
      const taskId = args[1] || getArgValue('--task');
      const workerUrl = getArgValue('--worker', workers[0] || 'http://127.0.0.1:3000');
      if (!taskId) {
        console.error('Usage: bun run fleet.ts watch <task_id> [--worker <url>]');
        process.exit(1);
      }

      await streamTaskEvents(workerUrl, taskId);
      break;
    }

    case 'tasks': {
      console.log(`\n📋 Querying active and past tasks across fleet...\n`);
      for (const w of workers) {
        const url = w.replace(/\/+$/, '');
        try {
          const res = await fetchWithTimeout(`${url}/tasks`, {}, 3000);
          if (res.ok) {
            const list = (await res.json()) as any[];
            console.log(`=== Worker: ${w} (${list.length} tasks) ===`);
            for (const t of list) {
              console.log(`  [${t.status}] ${t.id} - "${t.prompt.slice(0, 45)}..." -> branch: ${t.target_branch}`);
            }
            console.log('');
          }
        } catch {
          console.log(`=== Worker: ${w} (Unreachable) ===\n`);
        }
      }
      break;
    }

    case 'cancel': {
      const taskId = args[1] || getArgValue('--task');
      const workerUrl = getArgValue('--worker', workers[0] || 'http://127.0.0.1:3000');
      if (!taskId) {
        console.error('Usage: bun run fleet.ts cancel <task_id> [--worker <url>]');
        process.exit(1);
      }

      const res = await fetch(`${workerUrl.replace(/\/+$/, '')}/tasks/${taskId}/cancel`, { method: 'POST' });
      const data = (await res.json()) as any;
      console.log(`Task ${taskId} cancellation result:`, data);
      break;
    }

    default: {
      console.log(`
A2A Worker Fleet Orchestrator CLI

Usage:
  bun run fleet.ts status
      Check health and slot availability across all workers.

  bun run fleet.ts dispatch --prompt "..." [--repo <url>] [--base-branch <branch>] [--target-branch <branch>] [--watch]
      Dispatch a subtask (automatically chooses least loaded worker if --worker not set).

  bun run fleet.ts watch <task_id> [--worker <url>]
      Stream live events from an executing task.

  bun run fleet.ts tasks
      List all tasks across all worker nodes.

  bun run fleet.ts cancel <task_id> [--worker <url>]
      Cancel an executing task.
      `);
    }
  }
}

async function streamTaskEvents(workerUrl: string, taskId: string) {
  const url = `${workerUrl.replace(/\/+$/, '')}/tasks/${taskId}/events`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Failed to connect to event stream (${res.status})`);
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (line && line.startsWith('data: ')) {
        try {
          const event = JSON.parse(line.slice(6));
          const time = new Date(event.timestamp).toLocaleTimeString();
          if (event.event === 'thought' && event.data.content) {
            console.log(`\n💭 [Worker Thought]\n${event.data.content}\n`);
          } else if (event.event === 'tool_call') {
            console.log(`[${time}] 🛠️  [Tool] ${event.data.tool} -> ${event.data.arguments}`);
          } else if (event.event === 'tool_result') {
            const errTag = event.data.isError ? ' ❌ [FAIL]' : ' ✅ [OK]';
            console.log(`[${time}] ↳ [Result]${errTag} ${String(event.data.output).slice(0, 150)}...`);
          } else if (event.event === 'done') {
            console.log(`\n🎉 [TASK FINISHED] Status: ${event.data.status}`);
            console.log(`📝 Summary: ${event.data.summary}`);
            return;
          } else if (event.event === 'error') {
            console.error(`\n❌ [TASK ERROR]: ${event.data.error}`);
            return;
          }
        } catch {}
      }
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
