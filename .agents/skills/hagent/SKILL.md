---
name: hagent
description: >-
  Orchestrate, delegate, and monitor tactical coding subtasks across a fleet of
  Pi Durable worker MicroVMs via native A2A (Agent-to-Agent) communication tools.
---

# HAgent Worker Fleet Orchestrator Skill

This skill enables Master Orchestrators (such as **Pi Agent**, **Claude Code**, **Google Cloud Code**, or **Google Antigravity**) to communicate natively with a distributed fleet of remote **Pi Durable Execution Workers** running inside MicroVMs on a Tailscale network.

--------------------------------------------------------------------------------

## 🤝 Native A2A Tools (No Raw HTTP Calls Required!)

When operating as an orchestrator, **do NOT write raw HTTP curl calls**. Use the native A2A agent tools registered via the Pi Extension or MCP Server:

| Native Tool | Description |
|---|---|
| `a2a_discover_fleet` | Discovers all worker MicroVMs, checks health, and returns active vs max concurrency slots. |
| `a2a_send_task` | Dispatches a coding task, GitHub issue fix, or test verification to a worker MicroVM. |
| `a2a_get_task_status` | Polls current task progress, logs, and artifacts (commit SHA, Pull Request URL). |
| `a2a_send_message` | **Bidirectional A2A**: Sends mid-flight instructions, feedback, or clarifications to an active worker task. |
| `a2a_chat` | Sends a direct conversational message / sanity ping to a worker node. |

--------------------------------------------------------------------------------

## 🔌 How to Load Native A2A Tools into Your Orchestrator

### 1. In Pi Agent (`@earendil-works/pi-coding-agent`)
Load the native Pi Extension:
```bash
# In your Pi Agent workspace:
mkdir -p .pi/extensions
cp orchestrator-pack/extensions/pi-extension.ts .pi/extensions/a2a.ts
```
Or start Pi with the extension:
```bash
pi --extension ./orchestrator-pack/extensions/pi-extension.ts
```
*Pi Agent will automatically register `a2a_discover_fleet`, `a2a_send_task`, `a2a_get_task_status`, etc. as first-class model tools!*

---

### 2. In Claude Code / Google Antigravity / Cursor (via MCP)
Add the A2A MCP Server to your `mcp.json` or `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "hagent-fleet": {
      "command": "bun",
      "args": ["run", "/path/to/orchestrator-pack/mcp/a2a-server.ts"],
      "env": {
        "FLEET_WORKERS": "http://worker-vm-1:3000,http://worker-vm-2:3000"
      }
    }
  }
}
```

---

## 📋 Standard Orchestrator Workflow (SOP)

When a user asks you to implement a feature or resolve an issue:

### Step 1: Discover Fleet
Call `a2a_discover_fleet()`.
Inspect which worker MicroVMs are online and which have available slots (`active < max`).

### Step 2: Dispatch Subtask via A2A
Call `a2a_send_task(...)`:
```json
{
  "prompt": "Fix calculation error in discount coupon and run bun test",
  "issue_number": 42,
  "repo_url": "https://github.com/my-org/backend.git",
  "base_branch": "main"
}
```
The remote worker immediately starts in an isolated Git worktree.

### Step 3: Monitor or Interact Mid-Flight
* Poll status using `a2a_get_task_status(task_id: "task_123")`.
* If you need to give extra context while the worker is working, call `a2a_send_message(task_id: "task_123", message: "Make sure to also check edge case when items count is 0")`.

### Step 4: Review Artifacts
Once status is `COMPLETED`, extract:
* `artifacts.github_pr`: The Pull Request opened by the worker.
* `artifacts.git_commit`: The commit SHA.
* `summary`: The execution report.
Review the PR and notify the user.
