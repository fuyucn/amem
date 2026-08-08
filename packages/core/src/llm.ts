import type { AmemConfig } from './domain.js';
import { provider } from './errors.js';

export interface LlmClient {
  complete(prompt: string, opts?: { maxTokens?: number }): Promise<string>;
  completeJSON<T>(prompt: string, opts?: { maxTokens?: number }): Promise<T>;
}

/** Marker intent used by distillation; MockLlmClient keys off this. */
export const LLM_EXTRACT_INTENT = 'atomic knowledge units';

/** Hard cap for any single LLM request so slow/unreachable providers can't hang the server. */
const LLM_REQUEST_TIMEOUT_MS = 30_000;

function stripFences(text: string): string {
  return text
    .replace(/```(?:json)?/gi, '')
    .replace(/^[^\n{]*\{/s, '{')
    .replace(/\}[^\n}]*$/s, '}')
    .trim();
}

function parseJson<T>(text: string): T {
  const cleaned = stripFences(text);
  const open = cleaned.indexOf('{');
  const close = cleaned.lastIndexOf('}');
  if (open >= 0 && close > open) {
    try {
      return JSON.parse(cleaned.slice(open, close + 1)) as T;
    } catch {
      /* fall through to retry below */
    }
  }
  if (cleaned.trim().length === 0) {
    throw provider('LLM returned an empty response when JSON was requested');
  }
  throw provider('Failed to parse LLM JSON response');
}

/** OpenAI-compatible chat completions client. */
export class OpenAiCompatibleLlm implements LlmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string,
  ) {}

  async complete(prompt: string, opts?: { maxTokens?: number }): Promise<string> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
    };
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw provider(`LLM API error ${res.status}: ${await res.text()}`);
    const data = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
    } | null;
    return data?.choices?.[0]?.message?.content ?? '';
  }

  async completeJSON<T>(prompt: string, opts?: { maxTokens?: number }): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    };
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw provider(`LLM API error ${res.status}: ${await res.text()}`);
    const data = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
    } | null;
    const content = data?.choices?.[0]?.message?.content ?? '';
    return parseJson<T>(content);
  }
}

/** Configurable canned-LLM for tests and offline mode. */
export class MockLlmClient implements LlmClient {
  constructor(
    private readonly handlers: Record<string, (prompt: string) => unknown> = {},
  ) {}

  async complete(prompt: string): Promise<string> {
    const handler = this.pick(prompt);
    if (!handler) return '';
    const value = handler(prompt);
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  async completeJSON<T>(prompt: string): Promise<T> {
    const handler = this.pick(prompt);
    if (!handler) return { units: [] } as T;
    return handler(prompt) as T;
  }

  private pick(prompt: string): ((prompt: string) => unknown) | undefined {
    for (const key of Object.keys(this.handlers)) {
      if (prompt.includes(key)) return this.handlers[key];
    }
    return undefined;
  }
}

export function createLlm(cfg: AmemConfig['llm']): LlmClient {
  if (cfg.baseUrl && cfg.model) {
    return new OpenAiCompatibleLlm(cfg.baseUrl, cfg.model, cfg.apiKey);
  }
  return new MockLlmClient({ [LLM_EXTRACT_INTENT]: () => ({ units: [] }) });
}
