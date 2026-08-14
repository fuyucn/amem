import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMBEDDING_DIMS,
  cosine,
  EMBED_BODY_HEAD,
  hashEmbed,
  hashUnitEmbed,
  normalize,
  tokenizeForEmbedding,
} from '../src/lib/vector.js';

const D = DEFAULT_EMBEDDING_DIMS;

describe('offline embedder quality (feature hashing)', () => {
  it('same text is deterministic and self-similar', () => {
    const a = hashEmbed('Deploy uses docker compose', D);
    const b = hashEmbed('Deploy uses docker compose', D);
    expect(a).toEqual(b);
    expect(cosine(a, a)).toBeCloseTo(1, 6);
  });

  it('longer text sharing the same words stays similar (old bug: -0.54)', () => {
    const short = hashEmbed('Temp file cleaned', D);
    const long = hashEmbed('Temp file cleaned Temporary file cleaned up', D);
    const unrelated = hashEmbed('refactor payment gateway invoice retry', D);
    const related = cosine(short, long);
    const noise = cosine(short, unrelated);
    expect(related).toBeGreaterThan(0.5);
    expect(related).toBeGreaterThan(noise + 0.3);
  });

  it('unrelated texts are near-orthogonal (old bug: +0.8 noise)', () => {
    const a = hashEmbed('rotate database credentials on rotation schedule', D);
    const b = hashEmbed('render dashboard charts with d3 force layout', D);
    expect(Math.abs(cosine(a, b))).toBeLessThan(0.35);
  });

  it('mixed Chinese/English text produces a non-zero, useful vector', () => {
    const v = hashEmbed('部署 使用 docker compose up -d', D);
    const mag = Math.hypot(...v);
    expect(mag).toBeCloseTo(1, 4);
    const same = hashEmbed('部署 使用 docker compose up -d', D);
    expect(cosine(v, same)).toBeCloseTo(1, 6);
  });

  it('Chinese bigram overlap beats unrelated Chinese', () => {
    const a = hashEmbed('知识库自动分区与记忆检索', D);
    const b = hashEmbed('知识库自动分区策略优化', D);
    const c = hashEmbed('前端组件样式重构', D);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c) + 0.2);
  });

  it('empty text yields a zero vector (safe cosine)', () => {
    const v = hashEmbed('', D);
    expect(v.every((x) => x === 0)).toBe(true);
    expect(cosine(v, hashEmbed('anything', D))).toBe(0);
  });
});

describe('tokenizeForEmbedding', () => {
  it('splits camelCase and snake_case identifiers into parts', () => {
    expect(tokenizeForEmbedding('hashEmbed AMEM_OCR_BASE_URL')).toEqual([
      'hash',
      'embed',
      'amem',
      'ocr',
      'base',
      'url',
    ]);
  });

  it('emits CJK chars and bigrams', () => {
    const tokens = tokenizeForEmbedding('记忆管理');
    expect(tokens).toContain('记');
    expect(tokens).toContain('忆');
    expect(tokens).toContain('记忆');
    expect(tokens).toContain('忆管');
  });

  it('normalizes to unit length via normalize()', () => {
    const v = normalize(hashEmbed('normalize twice is idempotent', D));
    expect(Math.hypot(...v)).toBeCloseTo(1, 4);
  });
});

describe('hashUnitEmbed (title-dominant unit vectors)', () => {
  const longBody = (name: string) =>
    `export interface ${name} {
  id: string;
  createdAt: string;
  updatedAt: string;
  role: string;
  background: string;
  personality: string;
  goals: string[];
  constraints: string[];
  preferences: Record<string, string>;
  skills: string[];
  tools: string[];
  metadata: Record<string, unknown>;
  // padding to make the body long enough to dilute a flat embedding
  ${'x'.repeat(300)}
}`;

  it('is deterministic', () => {
    const a = hashUnitEmbed({ title: 'interface: Persona — domain.ts', summary: 'export interface Persona {', body: longBody('Persona') }, D);
    const b = hashUnitEmbed({ title: 'interface: Persona — domain.ts', summary: 'export interface Persona {', body: longBody('Persona') }, D);
    expect(a).toEqual(b);
  });

  it('query naming a unit outranks same-family units despite a long body', () => {
    const query = hashEmbed('interface Persona domain.ts export interface Persona {', D);
    const persona = hashUnitEmbed(
      { title: 'interface: Persona — domain.ts', summary: 'export interface Persona {', body: longBody('Persona') },
      D,
    );
    const scenario = hashUnitEmbed(
      { title: 'interface: Scenario — domain.ts', summary: 'export interface Scenario {', body: longBody('Scenario') },
      D,
    );
    const searchResult = hashUnitEmbed(
      { title: 'interface: SearchResult — domain.ts', summary: 'export interface SearchResult {', body: longBody('SearchResult') },
      D,
    );
    expect(cosine(query, persona)).toBeGreaterThan(cosine(query, scenario));
    expect(cosine(query, persona)).toBeGreaterThan(cosine(query, searchResult));
  });

  it('ignores body content past the head (retrieval only needs the front)', () => {
    const body = longBody('Persona');
    const a = hashUnitEmbed({ title: 't', summary: 's', body }, D);
    const b = hashUnitEmbed({ title: 't', summary: 's', body: body + ' TRAILING NOISE AFTER THE HEAD' }, D);
    expect(a).toEqual(b);
  });

  it('weighted title beats a flat concatenation for identity queries', () => {
    const name = 'Persona';
    const title = `interface: ${name} — domain.ts`;
    const summary = `export interface ${name} {`;
    const body = longBody(name);
    const query = hashEmbed(`interface ${name} domain.ts export interface ${name} {`, D);

    const flat = normalize(hashEmbed([title, summary, body].filter(Boolean).join(' '), D));
    const weighted = hashUnitEmbed({ title, summary, body }, D);
    const other = hashUnitEmbed(
      { title: 'interface: OtherType — domain.ts', summary: 'export interface OtherType {', body: longBody('OtherType') },
      D,
    );

    // Both should beat the same-family competitor, but the weighted vector
    // must be at least as good as the flat one (and strictly better in the
    // regression case that originally failed).
    expect(cosine(query, weighted)).toBeGreaterThanOrEqual(cosine(query, flat));
    expect(cosine(query, weighted)).toBeGreaterThan(cosine(query, other));
  });

  it('exposes the shared body-head constant used by keyword and embedding paths', () => {
    expect(EMBED_BODY_HEAD).toBe(400);
  });
});
