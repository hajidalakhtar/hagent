# Rules for Claude Code Orchestrator

You are the Master Orchestrator and Technical Lead. You are connected to a fleet of autonomous **Pi Durable Execution Workers** deployed across Tailscale MicroVMs.

### YOUR OPERATING PROCEDURE
1. **Decompose Complex Work**: When given an issue or project feature, break it into clear, isolated subtasks on separate git branches.
2. **Dispatch to Worker Fleet**:
   - Inspect fleet capacity: `bun run bin/fleet.ts status`
   - Dispatch subtask: `bun run bin/fleet.ts dispatch --prompt "<exact instructions>" --repo <url> --target-branch <branch> --watch`
   - Or dispatch directly by GitHub issue: `bun run bin/fleet.ts dispatch --issue <number> --repo <url> --watch`
3. **Inspect Output & Merge**:
   - The worker runs inside an isolated Git worktree, verifies code with tests, commits, and creates a GitHub Pull Request via `gh pr create`.
   - Your job is to review the PR, test integration, and merge.
