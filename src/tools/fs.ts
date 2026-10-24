// src/tools/fs.ts
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { ToolContext, ToolDefinition } from '../types.ts';

function safePath(worktreeDir: string, filePath: string): string {
  const fullPath = resolve(worktreeDir, filePath);
  if (!fullPath.startsWith(resolve(worktreeDir))) {
    throw new Error(`Path escape detected: ${filePath} is outside worktree`);
  }
  return fullPath;
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Reads the contents of a file within the worktree.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path of the file to read.',
      },
      start_line: {
        type: 'number',
        description: 'Optional start line (1-indexed).',
      },
      end_line: {
        type: 'number',
        description: 'Optional end line (inclusive).',
      },
    },
    required: ['path'],
  },
  execute: async (args: { path: string; start_line?: number; end_line?: number }, context: ToolContext) => {
    try {
      const fullPath = safePath(context.worktree_dir, args.path);
      if (!existsSync(fullPath)) {
        return { output: `File not found: ${args.path}`, isError: true };
      }

      const content = readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');

      const start = args.start_line ? Math.max(1, args.start_line) : 1;
      const end = args.end_line ? Math.min(lines.length, args.end_line) : lines.length;

      const numbered = lines
        .slice(start - 1, end)
        .map((line, idx) => `${start + idx}: ${line}`)
        .join('\n');

      return {
        output: numbered || '(empty file)',
      };
    } catch (err: any) {
      return { output: `Failed to read file: ${err.message}`, isError: true };
    }
  },
};

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Creates or overwrites a file within the worktree.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path of the file to write.',
      },
      content: {
        type: 'string',
        description: 'Full text content to write.',
      },
    },
    required: ['path', 'content'],
  },
  execute: async (args: { path: string; content: string }, context: ToolContext) => {
    try {
      const fullPath = safePath(context.worktree_dir, args.path);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(fullPath, args.content, 'utf8');
      return { output: `Successfully wrote ${args.content.length} characters to ${args.path}` };
    } catch (err: any) {
      return { output: `Failed to write file: ${err.message}`, isError: true };
    }
  },
};

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: 'Replaces exact target text with replacement text in a file.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path of the file to edit.',
      },
      target: {
        type: 'string',
        description: 'The exact string to find and replace.',
      },
      replacement: {
        type: 'string',
        description: 'The new string to replace the target with.',
      },
    },
    required: ['path', 'target', 'replacement'],
  },
  execute: async (args: { path: string; target: string; replacement: string }, context: ToolContext) => {
    try {
      const fullPath = safePath(context.worktree_dir, args.path);
      if (!existsSync(fullPath)) {
        return { output: `File not found: ${args.path}`, isError: true };
      }

      const content = readFileSync(fullPath, 'utf8');
      if (!content.includes(args.target)) {
        return {
          output: `Target text not found in ${args.path}. Please verify the exact whitespace and content.`,
          isError: true,
        };
      }

      const updated = content.replaceAll(args.target, args.replacement);
      writeFileSync(fullPath, updated, 'utf8');

      return { output: `Successfully replaced target in ${args.path}` };
    } catch (err: any) {
      return { output: `Failed to edit file: ${err.message}`, isError: true };
    }
  },
};

export const listFilesTool: ToolDefinition = {
  name: 'list_files',
  description: 'Lists files and directories recursively within the worktree.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Subdirectory path to list (default root).',
      },
      max_depth: {
        type: 'number',
        description: 'Maximum depth to traverse (default 3).',
      },
    },
  },
  execute: async (args: { path?: string; max_depth?: number }, context: ToolContext) => {
    try {
      const targetDir = safePath(context.worktree_dir, args.path || '.');
      const maxDepth = args.max_depth ?? 3;
      const fileList: string[] = [];

      function walk(currentDir: string, depth: number) {
        if (depth > maxDepth) return;
        const entries = readdirSync(currentDir);
        for (const entry of entries) {
          if (entry === '.git' || entry === 'node_modules' || entry === '.worktrees') continue;
          const full = join(currentDir, entry);
          const rel = relative(context.worktree_dir, full);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            fileList.push(`${rel}/`);
            walk(full, depth + 1);
          } else {
            fileList.push(rel);
          }
        }
      }

      walk(targetDir, 1);
      return { output: fileList.join('\n') || '(no files found)' };
    } catch (err: any) {
      return { output: `Failed to list files: ${err.message}`, isError: true };
    }
  },
};
