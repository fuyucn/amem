import type { AmemConfig } from './domain.js';
import { provider } from './errors.js';

export interface OcrClient {
  /** Extract text from a base64 image (scanned page). Returns clean Markdown. */
  recognize(base64Image: string, mime?: 'image/png' | 'image/jpeg'): Promise<string>;
}

const OCR_REQUEST_TIMEOUT_MS = 120_000;
const OCR_PROMPT =
  'OCR this document image. Return all visible text as clean Markdown. ' +
  'Preserve headings, lists, tables and code blocks. ' +
  'Output only the extracted content, no commentary.';

/**
 * OpenAI-compatible vision endpoint used as the OCR back-end for scanned PDFs.
 * Self-local by design: the page image is posted once and never persisted.
 */
export class OpenAiCompatibleOcr implements OcrClient {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string,
  ) {}

  async recognize(
    base64Image: string,
    mime: 'image/png' | 'image/jpeg' = 'image/png',
  ): Promise<string> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: OCR_PROMPT },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64Image}` } },
          ],
        },
      ],
      max_tokens: 4096,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(OCR_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw provider(`OCR API error ${res.status}: ${await res.text()}`);
    const data = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
    } | null;
    return data?.choices?.[0]?.message?.content ?? '';
  }
}

/** Build an OCR client from config; null when no OCR endpoint is configured. */
export function createOcrClient(cfg: AmemConfig['ocr'] | undefined): OcrClient | null {
  if (!cfg?.baseUrl || !cfg.model) return null;
  return new OpenAiCompatibleOcr(cfg.baseUrl, cfg.model, cfg.apiKey);
}
