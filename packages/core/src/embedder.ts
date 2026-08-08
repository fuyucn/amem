import type { AmemConfig, EmbeddingMode } from './domain.js';
import { notConfigured, provider } from './errors.js';
import { DEFAULT_EMBEDDING_DIMS, hashEmbed, normalize } from './lib/vector.js';

export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedMany(texts: string[]): Promise<number[][]>;
  dims(): Promise<number>;
  readonly mode: EmbeddingMode;
}

/** Deterministic offline embedder backed by hashEmbed. */
export class OfflineEmbedder implements Embedder {
  readonly mode: EmbeddingMode = 'offline';
  constructor(private readonly dimsValue: number = DEFAULT_EMBEDDING_DIMS) {}

  async embed(text: string): Promise<number[]> {
    return normalize(hashEmbed(text, this.dimsValue));
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    return texts.map((t) => normalize(hashEmbed(t, this.dimsValue)));
  }

  async dims(): Promise<number> {
    return this.dimsValue;
  }
}

/** OpenAI-compatible embeddings POST client. */
export class ApiEmbedder implements Embedder {
  readonly mode: EmbeddingMode = 'api';
  private cachedDims?: number;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string,
  ) {}

  async embed(text: string): Promise<number[]> {
    const result = await this.post([text]);
    return result[0]!;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    return this.post(texts);
  }

  async dims(): Promise<number> {
    if (this.cachedDims !== undefined) return this.cachedDims;
    const vector = await this.embed('dims');
    this.cachedDims = vector.length;
    return vector.length;
  }

  private async post(texts: string[]): Promise<number[][]> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/embeddings`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw provider(`Embedding API error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json().catch(() => null)) as { data?: Array<{ embedding: number[] }> } | null;
    const embeddings = data?.data?.map((d) => d.embedding) ?? [];
    if (embeddings.length !== texts.length) {
      throw provider('Embedding API returned an unexpected number of vectors');
    }
    return embeddings;
  }
}

export function createEmbedder(cfg: AmemConfig['embedding']): Promise<Embedder> {
  if (cfg.mode === 'api') {
    if (!cfg.baseUrl || !cfg.model) {
      throw notConfigured('api embedding requires baseUrl and model');
    }
    return Promise.resolve(new ApiEmbedder(cfg.baseUrl, cfg.model, cfg.apiKey));
  }
  return Promise.resolve(new OfflineEmbedder(cfg.dims ?? DEFAULT_EMBEDDING_DIMS));
}
