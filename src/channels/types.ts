// src/channels/types.ts
// Channel abstraction: an inbound integration that turns external events into
// durable agent tasks and delivers the agent's final answer back out.

import type { DurableAgent } from '../agent/durable-agent.ts';
import type { DurableStore } from '../store/durable-store.ts';

export interface ChannelRoute {
  /** HTTP method(s) this route answers. */
  method: string | string[];
  /** True when this route handles the incoming pathname. */
  match: (pathname: string) => boolean;
  handle: (req: Request, url: URL) => Promise<Response> | Response;
}

export interface Channel {
  name: string;
  description: string;
  routes: ChannelRoute[];
  /** Called once when the A2A server starts (bind listeners, reconcile state). */
  start?: () => void | Promise<void>;
  /** Called when the server shuts down. */
  stop?: () => void;
  /** Extra metadata exposed on GET /channels. */
  info?: () => Record<string, unknown>;
}

export interface ChannelRuntime {
  store: DurableStore;
  agent: DurableAgent;
  /** Directory of the channels config file — relative prompt files resolve against it. */
  baseDir: string;
}
