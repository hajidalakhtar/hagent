// src/channels/index.ts
// Builds the enabled channel list from a channels.json config file.

import { dirname, resolve } from 'node:path';
import type { DurableAgent } from '../agent/durable-agent.ts';
import type { DurableStore } from '../store/durable-store.ts';
import { loadChannelsConfig, resolveGithubChannelConfig } from './config.ts';
import { GitHubChannel } from './github.ts';
import type { Channel } from './types.ts';

export * from './types.ts';
export * from './config.ts';
export { GitHubChannel, matchesMention, verifySignature } from './github.ts';
export { resolveChannelPrompt, DEFAULT_CHANNEL_SYSTEM_PROMPT } from './prompt-rules.ts';

export interface CreateChannelsOptions {
  configPath: string;
  store: DurableStore;
  agent: DurableAgent;
}

export function createChannels(opts: CreateChannelsOptions): Channel[] {
  const configPath = resolve(opts.configPath);
  const cfg = loadChannelsConfig(configPath);
  const baseDir = dirname(configPath);
  const channels: Channel[] = [];

  if (cfg.github) {
    const githubCfg = resolveGithubChannelConfig(cfg.github, baseDir);
    if (githubCfg.enabled) {
      channels.push(
        new GitHubChannel({
          config: githubCfg,
          store: opts.store,
          agent: opts.agent,
        })
      );
    }
  }

  return channels;
}
