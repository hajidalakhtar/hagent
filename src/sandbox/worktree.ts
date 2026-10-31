// src/sandbox/worktree.ts
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.ts';

export interface WorktreeResult {
  worktreeDir: string;
  targetBranch: string;
}

export class WorktreeManager {
  private baseDir: string;

  constructor(baseDir: string = config.worktreesDir) {
    this.baseDir = baseDir;
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private async runCommand(cmd: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(cmd, {
      cwd: cwd || this.baseDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return { stdout, stderr, exitCode };
  }

  /**
   * Prepares a dedicated worktree for a task.
   * If repoUrl is provided, ensures a base clone exists and creates a worktree.
   * If not provided, creates an isolated worktree folder.
   */
  async prepare(
    taskId: string,
    repoUrl?: string,
    baseBranch = 'main',
    targetBranch?: string
  ): Promise<WorktreeResult> {
    const branch = targetBranch || `agent/${taskId}`;
    const worktreeDir = resolve(this.baseDir, taskId);

    if (existsSync(worktreeDir)) {
      return { worktreeDir, targetBranch: branch };
    }

    if (repoUrl) {
      // Create a deterministic cache dir for the repo
      const repoHash = Buffer.from(repoUrl).toString('hex').slice(0, 12);
      const bareRepoDir = resolve(this.baseDir, `_repo_${repoHash}`);

      if (!existsSync(bareRepoDir)) {
        // Clone bare repository to save space and serve multiple worktrees
        const cloneRes = await this.runCommand(['git', 'clone', '--bare', repoUrl, bareRepoDir]);
        if (cloneRes.exitCode !== 0) {
          throw new Error(`Failed to clone repo ${repoUrl}: ${cloneRes.stderr}`);
        }
      } else {
        // Fetch latest updates
        await this.runCommand(['git', 'fetch', 'origin'], bareRepoDir);
      }

      await this.runCommand(['git', 'worktree', 'prune'], bareRepoDir);

      // Release any other worktree holding this branch
      const listRes = await this.runCommand(['git', 'worktree', 'list', '--porcelain'], bareRepoDir);
      if (listRes.exitCode === 0) {
        const lines = listRes.stdout.split("\n");
        let currentWt = "";
        for (const line of lines) {
          if (line.startsWith("worktree ")) currentWt = line.slice(9).trim();
          if (line.startsWith("branch ") && line.slice(7).trim().endsWith("/" + branch)) {
            if (currentWt && currentWt !== worktreeDir) {
              await this.runCommand(['git', 'worktree', 'remove', '--force', currentWt], bareRepoDir);
              try { rmSync(currentWt, { recursive: true, force: true }); } catch {}
            }
          }
        }
      }

      // Check if branch exists on origin
      const branchOnOrigin = await this.runCommand(['git', 'rev-parse', '--verify', "origin/" + branch], bareRepoDir);
      const startPoint = branchOnOrigin.exitCode === 0 ? "origin/" + branch : "origin/" + baseBranch;

      // Create the worktree on the target branch
      let worktreeRes = await this.runCommand(
        ['git', 'worktree', 'add', '-B', branch, worktreeDir, startPoint],
        bareRepoDir
      );
if (worktreeRes.exitCode !== 0) {
        // Try fallback if origin/baseBranch does not exist
        const fallbackRes = await this.runCommand(
          ['git', 'worktree', 'add', '-B', branch, worktreeDir, baseBranch],
          bareRepoDir
        );
        if (fallbackRes.exitCode !== 0) {
          throw new Error(`Failed to add git worktree: ${worktreeRes.stderr} / ${fallbackRes.stderr}`);
        }
      }
    } else {
      // Local standalone worktree directory for tasks without git repo url
      mkdirSync(worktreeDir, { recursive: true });
      // Initialize a local git repository so git tools still function
      await this.runCommand(['git', 'init', '-b', branch], worktreeDir);
      await this.runCommand(['git', 'config', 'user.name', 'Pi-Durable-Agent'], worktreeDir);
      await this.runCommand(['git', 'config', 'user.email', 'agent@pidurable.local'], worktreeDir);
    }

    return { worktreeDir, targetBranch: branch };
  }

  /**
   * Commits all changes in the worktree
   */
  async commitAll(worktreeDir: string, message: string): Promise<{ commitSha?: string; diffStat: string }> {
    await this.runCommand(['git', 'add', '-A'], worktreeDir);
    
    // Check if there are changes to commit
    const statusRes = await this.runCommand(['git', 'status', '--porcelain'], worktreeDir);
    if (!statusRes.stdout.trim()) {
      return { diffStat: 'No changes to commit' };
    }

    const commitRes = await this.runCommand(['git', 'commit', '-m', message], worktreeDir);
    if (commitRes.exitCode !== 0) {
      throw new Error(`Git commit failed: ${commitRes.stderr}`);
    }

    const revParse = await this.runCommand(['git', 'rev-parse', 'HEAD'], worktreeDir);
    const diffStat = await this.runCommand(['git', 'diff', '--stat', 'HEAD~1', 'HEAD'], worktreeDir);

    return {
      commitSha: revParse.stdout.trim(),
      diffStat: diffStat.stdout.trim() || 'Changes committed',
    };
  }

  /**
   * Pushes the branch to remote
   */
  async push(worktreeDir: string, targetBranch: string): Promise<boolean> {
    const res = await this.runCommand(['git', 'push', '-u', 'origin', targetBranch], worktreeDir);
    return res.exitCode === 0;
  }

  /**
   * Removes the worktree directory safely
   */
  async cleanup(worktreeDir: string): Promise<void> {
    if (!existsSync(worktreeDir)) return;
    try {
      await this.runCommand(['git', 'worktree', 'remove', '--force', worktreeDir]);
    } catch {
      // ignore git worktree remove error if directory is not registered
    }
    try {
      rmSync(worktreeDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
