---
name: a2a-worker-fleet
description: >-
  Orchestrate, delegate, and monitor tactical coding subtasks across a fleet of
  Pi Durable worker MicroVMs via Tailscale using the A2A (Agent-to-Agent) protocol.
---

# A2A Worker Fleet Orchestrator Skill

This skill guides Master Agents (Claude Code, Google Antigravity, Pi Agent, or custom scripts) to act as the **high-level orchestrator / architect**, delegating discrete, parallel coding subtasks to remote **Pi Durable Execution Workers** running inside MicroVMs on a Tailscale network.

--------------------------------------------------------------------------------

## 🧠 Role Division: Master vs Worker

| Role | Entity | Responsibilities |
|---|---|---|
| **Master Orchestrator** | Claude Code / Antigravity / Master VM | High-level reasoning, system architecture, task decomposition, git PR review, human interaction. |
| **Execution Worker** | Pi Durable Worker (MicroVM) | Tactical execution in isolated Git worktree: edits code, runs tests, commits, and returns diff/artifacts. |

--------------------------------------------------------------------------------

## 🚀 Quick Commands Reference

All fleet management commands can be executed via the bundled script:

```bash
# 1. Check health and available slots across all worker VMs
bun run skills/a2a-worker-fleet/scripts/fleet.ts status

# 2. Dispatch subtask (automatically selects least-loaded worker)
bun run skills/a2a-worker-fleet/scripts/fleet.ts dispatch \
  --prompt "Implement JWT verification in src/auth.ts and run bun test" \
  --repo https://github.com/my-org/backend.git \
  --base-branch main \
  --target-branch agent/auth-verification \
  --watch

# 3. View all active and completed tasks across all workers
bun run skills/a2a-worker-fleet/scripts/fleet.ts tasks

# 4. Stream live logs for a running task
bun run skills/a2a-worker-fleet/scripts/fleet.ts watch <task_id> --worker <worker_url>

# 5. Cancel a running task
bun run skills/a2a-worker-fleet/scripts/fleet.ts cancel <task_id> --worker <worker_url>
```

--------------------------------------------------------------------------------

## 📋 Standard Operating Procedure (SOP) for Master Agent

When assigned a complex coding task or large feature:

### Step 1: Decompose into Orthogonal Subtasks
Do not send an open-ended "build the whole app" prompt to a worker. Break the problem into orthogonal, non-overlapping subtasks:
* **Subtask 1**: Backend API changes (Branch: `agent/api-changes`)
* **Subtask 2**: Database schema migration (Branch: `agent/db-migrations`)
* **Subtask 3**: Frontend UI components (Branch: `agent/frontend-components`)

> [!IMPORTANT]
> Ensure parallel subtasks touch different files or directories to minimize git merge conflicts.

### Step 2: Check Fleet Capacity
Run:
```bash
bun run skills/a2a-worker-fleet/scripts/fleet.ts status
```
Inspect which worker MicroVMs are online (`🟢 Online`) and how many slots are active versus free (`active / max`).

### Step 3: Dispatch Subtasks to Workers
For each decomposed subtask, call `fleet.ts dispatch`. 

**Prompt Guidelines for Worker Tasks:**
1. State the objective clearly.
2. Specify the exact files to create or modify.
3. Specify the test command to verify the fix (e.g. `bun test`, `npm test`, `pytest`).
4. Remind the worker to commit before calling `finish_task`.

Example command:
```bash
bun run skills/a2a-worker-fleet/scripts/fleet.ts dispatch \
  --prompt "1. Modify src/services/mailer.ts to support SendGrid provider. 2. Add unit test in test/mailer.test.ts. 3. Run 'bun test' and ensure 100% pass." \
  --repo https://github.com/my-org/backend.git \
  --target-branch agent/mailer-sendgrid \
  --watch
```

### Step 4: Monitor Progress & Collect Artifacts
If dispatched without `--watch`, monitor progress with:
```bash
bun run skills/a2a-worker-fleet/scripts/fleet.ts tasks
```
When the task reaches `COMPLETED`, extract the artifacts:
* `target_branch`: The branch pushed to the remote repository.
* `git_commit`: The commit SHA created by the worker.
* `summary`: The execution report provided by the worker.

### Step 5: Review & Merge
From the Master VM:
1. Fetch the remote branch: `git fetch origin <target_branch>`.
2. Inspect the diff: `git diff main origin/<target_branch>`.
3. If clean, merge into main or open a Pull Request on GitHub.
4. If tests or code fail, dispatch a targeted follow-up subtask to the worker or resolve manually.

--------------------------------------------------------------------------------

## ⚙️ Configuration

Set known worker URLs in environment variable or `fleet.config.json`:

### Option A: Environment Variable
```bash
export FLEET_WORKERS="http://100.64.0.10:3000,http://100.64.0.11:3000"
```

### Option B: `fleet.config.json`
Create `fleet.config.json` in project root:
```json
{
  "workers": [
    "http://worker-node-1:3000",
    "http://worker-node-2:3000"
  ]
}
```
*(MagicDNS names or Tailscale 100.x.y.z IPs work seamlessly).*
