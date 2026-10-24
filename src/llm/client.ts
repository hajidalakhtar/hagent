// src/llm/client.ts
import { config } from '../config.ts';
import type { AgentMessage, ToolCallRecord } from '../types.ts';

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCallRecord[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export class LLMClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor() {
    this.apiKey = config.llm.apiKey;
    this.baseUrl = config.llm.baseUrl.replace(/\/+$/, '');
    this.model = config.llm.model;
  }

  /**
   * Universal chat completions request supporting function calling
   */
  async chat(
    messages: AgentMessage[],
    tools: Array<{ type: 'function'; function: Record<string, unknown> }>
  ): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error(
        'LLM API key is not configured. Set GEMINI_API_KEY, OPENAI_API_KEY, or LLM_API_KEY in .env or environment.'
      );
    }

    const formattedMessages = messages.map((m) => {
      const msg: any = {
        role: m.role,
        content: m.content || '',
      };

      if (m.tool_calls && m.tool_calls.length > 0) {
        msg.tool_calls = m.tool_calls;
      }

      if (m.tool_call_id) {
        msg.tool_call_id = m.tool_call_id;
      }

      if (m.name) {
        msg.name = m.name;
      }

      return msg;
    });

    const url = `${this.baseUrl}/chat/completions`;
    const payload: any = {
      model: this.model,
      messages: formattedMessages,
      temperature: config.llm.temperature,
      max_tokens: config.llm.maxTokens,
    };

    if (tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LLM API returned ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as any;
    const choice = data.choices?.[0];

    if (!choice) {
      throw new Error('LLM returned no choices in response');
    }

    const message = choice.message;
    const content = message.content || '';
    const toolCalls: ToolCallRecord[] = (message.tool_calls || []).map((tc: any) => ({
      id: tc.id || `call_${crypto.randomUUID()}`,
      type: 'function' as const,
      function: {
        name: tc.function.name,
        arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments),
      },
    }));

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }
}
