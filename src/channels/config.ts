// src/channels/config.ts
// channels.json loader: one JSON file describes every inbound channel the
// agent exposes, including per-label system prompts.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { LabelPrompt } from './prompt-rules.ts';
import { resolvePromptValue } from './prompt-rules.ts';

export interface GithubTriggers {
  /** Respond when the bot is @mentioned in a comment or issue/PR body. Default: true. */
  mention?: boolean;
  /** Respond to every comment (self-replies are still filtered). Default: false. */
  all_comments?: boolean;
  /** Respond when one of these labels is added to an issue/PR. Default: []. */
  label_added?: string[];
}

export interface GithubChannelConfig {
  enabled?: boolean;
  /** Webhook endpoint path. Default: "/channels/github". */
  webhook_path?: string;
  /** Webhook HMAC-SHA256 secret, "env:NAME" or literal. Verifies x-hub-signature-256. */
  secret?: string;
  /** GitHub token used to read git auth + post replies, "env:NAME" or literal. */
  token?: string;
  /** REST API base (GitHub Enterprise supported). Default: https://api.github.com */
  api_base?: string;
  /** Handles the bot answers to, e.g. ["hagent"]. Default: []. */
  mentions?: string[];
  /** Our own GitHub login — used to filter our own comments (loop guard). */
  bot_login?: string;
  /** Fallback base branch when the payload does not say. Default: repository.default_branch, then "main". */
  base_branch?: string;
  /** "comment" (default) posts the answer back to the thread, "none" disables replies. */
  reply?: 'comment' | 'none';
  /** Markdown header prepended to every reply. */
  reply_header?: string;
  /** Post a comment when the task fails. Default: true. */
  reply_on_error?: boolean;
  /** Allow channel tasks to push their agent/<task> branch. Default: false (read-only bot). */
  push?: boolean;
  /** Inject the GitHub token as a git extraHeader so private repos can be cloned. Default: true. */
  git_auth?: boolean;
  /** Include the issue/PR description in the task prompt. Default: true. */
  include_body?: boolean;
  /** Truncation limit for quoted bodies. Default: 6000 chars. */
  body_char_limit?: number;
  triggers?: GithubTriggers;
  /** Default system prompt: inline text or "./path/to/prompt.md". */
  default_system_prompt?: string;
  default_system_prompt_file?: string;
  /**
   * System prompt per label:
   *   "review": "./prompts/review.md"
   *   "bug":    { "system_prompt": "...", "reply_header": "..." }
   * The first key (in file order) present on the issue/PR wins.
   */
  label_prompts?: Record<string, string | LabelPrompt>;
}

export interface ChannelsConfig {
  github?: GithubChannelConfig;
}

export interface ResolvedGithubConfig {
  enabled: boolean;
  webhookPath: string;
  secret: string;
  token: string;
  apiBase: string;
  mentions: string[];
  botLogin: string;
  baseBranch: string;
  reply: 'comment' | 'none';
  replyHeader: string;
  replyOnError: boolean;
  push: boolean;
  gitAuth: boolean;
  includeBody: boolean;
  bodyCharLimit: number;
  triggers: { mention: boolean; allComments: boolean; labelAdded: string[] };
  defaultSystemPrompt: string;
  /** label -> fully resolved prompt (files already read). */
  labelPrompts: Record<string, LabelPrompt>;
}

/** Expands "env:NAME" references so secrets can stay out of channels.json. */
export function resolveEnvRef(value?: string): string {
  if (!value) return '';
  const match = value.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/);
  if (match) return process.env[match[1]!] || '';
  return value;
}

/** Reads and parses channels.json. Missing file => no channels (not an error). */
export function loadChannelsConfig(configPath: string): ChannelsConfig {
  const path = resolve(configPath);
  if (!existsSync(path)) {
    console.log(`ℹ️ Channels config not found at ${path} — starting without inbound channels.`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err: any) {
    throw new Error(`Invalid JSON in ${path}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Channels config ${path} must be a JSON object`);
  }
  return parsed as ChannelsConfig;
}

/** Fills defaults, resolves env refs and prompt files. Throws on missing prompt files. */
export function resolveGithubChannelConfig(
  cfg: GithubChannelConfig,
  baseDir: string
): ResolvedGithubConfig {
  const defaultSystemPrompt = cfg.default_system_prompt_file
    ? resolvePromptValue(cfg.default_system_prompt_file, baseDir)
    : resolvePromptValue(cfg.default_system_prompt, baseDir);

  const labelPrompts: Record<string, LabelPrompt> = {};
  for (const [label, rule] of Object.entries(cfg.label_prompts || {})) {
    const asObject: LabelPrompt = typeof rule === 'string' ? { system_prompt: rule } : rule;
    labelPrompts[label] = {
      system_prompt: asObject.system_prompt_file
        ? resolvePromptValue(asObject.system_prompt_file, baseDir)
        : resolvePromptValue(asObject.system_prompt, baseDir),
      reply_header: asObject.reply_header || '',
    };
    if (!labelPrompts[label]!.system_prompt) {
      throw new Error(`label_prompts["${label}"] resolved to an empty system prompt`);
    }
  }

  return {
    enabled: cfg.enabled !== false,
    webhookPath: cfg.webhook_path || '/channels/github',
    secret: resolveEnvRef(cfg.secret),
    token: resolveEnvRef(cfg.token),
    apiBase: (cfg.api_base || 'https://api.github.com').replace(/\/+$/, ''),
    mentions: (cfg.mentions || []).map((m) => m.replace(/^@/, '')),
    botLogin: (cfg.bot_login || '').replace(/^@/, ''),
    baseBranch: cfg.base_branch || '',
    reply: cfg.reply === 'none' ? 'none' : 'comment',
    replyHeader: cfg.reply_header || '',
    replyOnError: cfg.reply_on_error !== false,
    push: cfg.push === true,
    gitAuth: cfg.git_auth !== false,
    includeBody: cfg.include_body !== false,
    bodyCharLimit: cfg.body_char_limit || 6000,
    triggers: {
      mention: cfg.triggers?.mention !== false,
      allComments: cfg.triggers?.all_comments === true,
      labelAdded: (cfg.triggers?.label_added || []).map((l) => l.toLowerCase()),
    },
    defaultSystemPrompt,
    labelPrompts,
  };
}
