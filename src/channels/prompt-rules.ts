// src/channels/prompt-rules.ts
// Resolves which system prompt a channel task should use, based on labels
// (and, later, any other metadata a channel can provide).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LabelPrompt {
  system_prompt?: string;
  system_prompt_file?: string;
  reply_header?: string;
}

export interface ResolvedPrompt {
  systemPrompt: string;
  /** Label that selected the prompt, if any. */
  matchedLabel?: string;
  replyHeader?: string;
}

/** Built-in fallback when the config does not define a default prompt. */
export const DEFAULT_CHANNEL_SYSTEM_PROMPT = `You are a helpful repository assistant embedded in GitHub.

Rules:
- Answer using the real repository checked out in your worktree. Read files; never guess their contents.
- Be direct and concrete: cite file paths, line references, and commands the user can run.
- Write the answer in Markdown, as a standalone reply to a GitHub thread.
- Stay read-only unless the user explicitly asks you to change code.`;

/**
 * Reads a prompt value. A plain string is the prompt itself; a short path-like
 * string ("./prompts/review.md") is read from disk relative to baseDir.
 */
export function resolvePromptValue(value: string | undefined, baseDir: string): string {
  if (!value) return '';
  const trimmed = value.trim();
  const looksLikePath =
    !value.includes('\n') &&
    (trimmed.startsWith('./') || trimmed.startsWith('../') || /\.(md|txt|prompt)$/i.test(trimmed));
  if (looksLikePath) {
    const file = resolve(baseDir, trimmed);
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    if (trimmed.startsWith('./') || trimmed.startsWith('../')) {
      throw new Error(`Prompt file not found: ${file}`);
    }
  }
  return value;
}

/**
 * Picks the prompt for a task. Labels are matched against the keys of
 * labelPrompts in config order, so the first configured label that the
 * issue/PR carries wins.
 */
export function resolveChannelPrompt(params: {
  labels: string[];
  defaultPrompt?: string;
  labelPrompts?: Record<string, LabelPrompt | string>;
  baseDir: string;
}): ResolvedPrompt {
  const { labels, defaultPrompt, labelPrompts, baseDir } = params;
  const normalizedLabels = new Set(labels.map((l) => l.toLowerCase()));

  for (const [label, rule] of Object.entries(labelPrompts || {})) {
    if (!normalizedLabels.has(label.toLowerCase())) continue;

    const resolved: LabelPrompt = typeof rule === 'string' ? { system_prompt: rule } : rule;
    const systemPrompt =
      resolvePromptValue(resolved.system_prompt_file, baseDir) ||
      (resolved.system_prompt ? resolvePromptValue(resolved.system_prompt, baseDir) : '');

    if (!systemPrompt) {
      throw new Error(`label_prompts["${label}"] has no system_prompt or system_prompt_file`);
    }

    return {
      systemPrompt,
      matchedLabel: label,
      replyHeader: resolved.reply_header || '',
    };
  }

  const fallback = defaultPrompt
    ? resolvePromptValue(defaultPrompt, baseDir)
    : DEFAULT_CHANNEL_SYSTEM_PROMPT;

  return { systemPrompt: fallback };
}
