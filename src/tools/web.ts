// src/tools/web.ts
import { config } from '../config.ts';
import type { ToolContext, ToolDefinition } from '../types.ts';

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description:
    'Searches the live web for technical documentation, library APIs, error troubleshooting, and real-time information using 9Router / search providers.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query string (e.g. "bun:sqlite WAL mode performance" or "hono jwt middleware example").',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of search results to return (default 5).',
      },
    },
    required: ['query'],
  },
  execute: async (args: { query: string; max_results?: number }, context: ToolContext) => {
    const searchUrl = config.web.searchEndpoint || `${config.web.routerUrl}/v1/search`;
    const maxResults = args.max_results || 5;

    context.logger(`[Web Search] Query: "${args.query}" via ${searchUrl} (Model: ${config.web.searchModel})`);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.web.apiKey) {
      headers['Authorization'] = `Bearer ${config.web.apiKey}`;
    }

    try {
      const response = await fetch(searchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.web.searchModel,
          query: args.query,
          max_results: maxResults,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        return {
          output: `Web search request to ${searchUrl} failed (${response.status}): ${errText}. Please check NINEROUTER_URL and WEB_SEARCH_MODEL in .env.`,
          isError: true,
        };
      }

      const data = (await response.json()) as any;
      const results = data.results || data.data || (Array.isArray(data) ? data : []);

      if (!Array.isArray(results) || results.length === 0) {
        if (data.answer || data.content) {
          return { output: `[Search Summary]\n${data.answer || data.content}` };
        }
        return { output: `No search results found for query: "${args.query}"` };
      }

      const formatted = results
        .slice(0, maxResults)
        .map((item: any, idx: number) => {
          const title = item.title || item.name || 'Untitled';
          const url = item.url || item.link || '';
          const snippet = item.content || item.snippet || item.body || '(no snippet)';
          return `### ${idx + 1}. [${title}](${url})\n${snippet}\n`;
        })
        .join('\n');

      return { output: `Web Search Results for "${args.query}":\n\n${formatted}` };
    } catch (err: any) {
      return {
        output: `Error performing web search: ${err.message}. Ensure 9Router or search endpoint is reachable at ${searchUrl}.`,
        isError: true,
      };
    }
  },
};

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Scrapes and fetches web pages, documentation, or online articles, returning clean markdown or text for analysis.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The target web page URL to fetch.',
      },
    },
    required: ['url'],
  },
  execute: async (args: { url: string }, context: ToolContext) => {
    context.logger(`[Web Fetch] Fetching: ${args.url}`);

    const fetchEndpoint = config.web.fetchEndpoint || `${config.web.routerUrl}/v1/web/fetch`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.web.apiKey) {
      headers['Authorization'] = `Bearer ${config.web.apiKey}`;
    }

    // 1. Try 9Router Web Fetch Endpoint
    try {
      const res = await fetch(fetchEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.web.fetchModel,
          url: args.url,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        const content = data.content || data.markdown || data.text || JSON.stringify(data);
        const truncated = content.slice(0, 8000);
        return {
          output: `Content from ${args.url}:\n\n${truncated}${content.length > 8000 ? '\n\n...(content truncated to 8000 characters)...' : ''}`,
        };
      }
    } catch {
      // If 9Router endpoint is unreachable, fallback to Jina Reader
    }

    // 2. Resilient Fallback: Jina Reader API
    try {
      context.logger(`[Web Fetch Fallback] Using Jina Reader for: ${args.url}`);
      const jinaRes = await fetch(`https://r.jina.ai/${args.url}`, {
        headers: {
          'Accept': 'text/plain',
        },
      });

      if (jinaRes.ok) {
        const text = await jinaRes.text();
        const truncated = text.slice(0, 8000);
        return {
          output: `Content from ${args.url} (via Jina Reader):\n\n${truncated}${text.length > 8000 ? '\n\n...(content truncated to 8000 characters)...' : ''}`,
        };
      }
    } catch (jinaErr: any) {
      context.logger(`[Web Fetch Fallback Error]: ${jinaErr.message}`);
    }

    // 3. Fallback: Direct Fetch
    try {
      const directRes = await fetch(args.url);
      if (directRes.ok) {
        const raw = await directRes.text();
        const clean = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 6000);
        return {
          output: `Content from ${args.url} (Direct Fetch):\n\n${clean}`,
        };
      }
      return { output: `Failed to fetch URL ${args.url} (${directRes.status})`, isError: true };
    } catch (err: any) {
      return { output: `Failed to fetch URL ${args.url}: ${err.message}`, isError: true };
    }
  },
};
