import { UNIT_TYPES, type AmemConfig, type UnitType } from './domain.js';
import type { Storage } from './store.js';
import type { Embedder } from './embedder.js';
import { LLM_EXTRACT_INTENT, type LlmClient } from './llm.js';
import { findDuplicate, mergeUnits } from './dedup.js';
import { countTokens } from './lib/tokenizer.js';
import { EMBED_BODY_HEAD, hashUnitEmbed } from './lib/vector.js';

export interface CandidateUnit {
  type: UnitType;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  importance: number;
  quality: number;
}

export interface DistillResult {
  units: CandidateUnit[];
  deduplicated: Array<{ candidateTitle: string; matchedUnitId: string }>;
  tokensSavedByDedup: number;
}

const UNIT_TYPES_SET = new Set<string>(UNIT_TYPES);

function isUnitType(v: unknown): v is UnitType {
  return typeof v === 'string' && UNIT_TYPES_SET.has(v);
}

function buildPrompt(rawText: string): string {
  return [
    LLM_EXTRACT_INTENT,
    ` from the text below. Return ONLY valid JSON of the form ` +
      `{"units":[{"type":"fact|decision|plan|procedure|preference|concept|lesson|question",` +
      `"title":"short title","summary":"one line","body":"atomic detail","tags":["a","b"]}]}.`,
    `Prefer durable knowledge (decisions, procedures, lessons, preferences, facts).`,
    `Ignore chit-chat, greetings, and pure role labels (user:/assistant:).`,
    `Do not include anything outside the JSON object.`,
    '---TEXT---',
    rawText.slice(0, 30000),
  ].join('\n');
}

const LABEL_RE =
  /^(decision|fact|procedure|lesson|preference|plan|concept|question|fix|todo|note)\s*[:：\-–—]\s*(.+)$/i;

const ROLE_RE = /^(user|assistant|system|tool|human|model)\s*[:：\-–—]\s*/i;

const SIGNAL_RE =
  /\b(decision|decided|procedure|prefer|preference|lesson|must|should|always|never|fact|store|sqlite|hook|recall|ingest|workspace|auth|oauth|graph|api|mcp|bug|fix|root cause)\b/i;

const NOISE_RE =
  /^(ok|okay|thanks|thank you|hi|hello|hey|yes|no|sure|cool|great|lgtm|wip|test|ping|pong)\b/i;

function stripRole(line: string): string {
  return line.replace(ROLE_RE, '').trim();
}

function inferType(text: string, labeled?: string): UnitType {
  const key = (labeled || '').toLowerCase();
  if (key === 'decision' || key === 'fix') return 'decision';
  if (key === 'procedure' || key === 'todo') return 'procedure';
  if (key === 'lesson') return 'lesson';
  if (key === 'preference' || key === 'prefer') return 'preference';
  if (key === 'plan') return 'plan';
  if (key === 'concept') return 'concept';
  if (key === 'question') return 'question';
  if (key === 'fact' || key === 'note') return 'fact';
  const t = text.toLowerCase();
  if (/\b(decided|decision|we will|we chose|will use)\b/.test(t)) return 'decision';
  if (/\b(procedure|steps?:|how to|workflow|must call|at session)\b/.test(t)) return 'procedure';
  if (/\b(prefer|preference|always|never store)\b/.test(t)) return 'preference';
  if (/\b(lesson|learned|root cause|because)\b/.test(t)) return 'lesson';
  if (/\b(plan|next|todo|roadmap)\b/.test(t)) return 'plan';
  if (/\?$/.test(t.trim())) return 'question';
  return 'fact';
}

function titleFrom(text: string, type: UnitType): string {
  const cleaned = text
    .replace(LABEL_RE, '$2')
    .replace(ROLE_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Prefer first clause
  const clause = cleaned.split(/(?<=[.!?。！？])\s+|;\s+| — | - /)[0] || cleaned;
  const words = clause.replace(/[^\p{L}\p{N} _\-./]/gu, ' ').split(/\s+/).filter(Boolean);
  let title = words.slice(0, 10).join(' ').slice(0, 80);
  if (!title) title = 'Untitled note';
  // Avoid titles that are just role leftovers
  if (/^(user|assistant|system)$/i.test(title)) title = `${type}: ${clause.slice(0, 60)}`;
  // Capitalize first letter
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function tagsFrom(text: string, type: UnitType): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4 && !/^(about|their|there|these|those|which|would|could|should|after|before|using|with)$/.test(w));
  const uniq = [...new Set(words)].slice(0, 5);
  if (!uniq.includes(type)) uniq.unshift(type);
  return uniq.slice(0, 6);
}

function scoreChunk(text: string, labeled: boolean): number {
  let score = 0;
  if (labeled) score += 3;
  if (SIGNAL_RE.test(text)) score += 2;
  if (text.length >= 40 && text.length <= 400) score += 1;
  if (NOISE_RE.test(text)) score -= 5;
  if (ROLE_RE.test(text) && stripRole(text).length < 20) score -= 3;
  // Agent transcripts often start with user:/assistant: — body after strip matters
  const body = stripRole(text);
  if (body.length < 20) score -= 4;
  if (/codex-hook:\/\//i.test(text)) score -= 1;
  return score;
}

function splitIntoCandidates(rawText: string): string[] {
  // Keep paragraph structure; also split bullet-like lines.
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    const joined = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) chunks.push(joined);
    buf = [];
  };

  for (const line of lines) {
    const stripped = stripRole(line);
    const isLabel = LABEL_RE.test(stripped) || LABEL_RE.test(line);
    const isBullet = /^([-*•]|\d+[.)])\s+/.test(stripped);
    if (isLabel || isBullet) {
      flush();
      chunks.push(stripped.replace(/^([-*•]|\d+[.)])\s+/, ''));
      continue;
    }
    // New paragraph boundary on short connector-only lines
    if (stripped.length < 12 && buf.length) {
      flush();
      continue;
    }
    buf.push(stripped);
    // Prefer sentence-sized units
    if (stripped.length > 180 || /[.!?。！？]$/.test(stripped)) flush();
  }
  flush();

  if (chunks.length === 0) {
    const flat = stripRole(rawText).replace(/\s+/g, ' ').trim();
    if (flat.length >= 24) chunks.push(flat.slice(0, 600));
  }
  return chunks;
}

/**
 * Heuristic extraction fallback used when no LLM is configured (offline mode).
 * Tuned for agent transcripts + labeled notes so Stop-hook ingest does not
 * create noisy "user Foo" / "assistant Bar" units.
 */
export function heuristicExtract(rawText: string, maxUnits = 12): CandidateUnit[] {
  const chunks = splitIntoCandidates(rawText);
  const scored = chunks
    .map((chunk, index) => {
      const stripped = stripRole(chunk);
      const labelMatch = stripped.match(LABEL_RE) || chunk.match(LABEL_RE);
      const labeledType = labelMatch?.[1];
      const body = (labelMatch?.[2] || stripped).trim();
      const labeled = Boolean(labelMatch);
      return { chunk: body, labeled, labeledType, score: scoreChunk(chunk, labeled), index };
    })
    .filter((c) => c.chunk.length >= 20 && c.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxUnits);

  // Preserve document order among the top-scoring survivors.
  const selected = [...scored].sort((a, b) => a.index - b.index);

  // If everything filtered out, keep the single best non-empty slice
  const finalChunks =
    selected.length > 0
      ? selected
      : [
          {
            chunk: stripRole(rawText).replace(/\s+/g, ' ').trim().slice(0, 600),
            labeled: false,
            labeledType: undefined as string | undefined,
            score: 0,
          },
        ].filter((c) => c.chunk.length >= 24);

  return finalChunks.map((c) => {
    const type = inferType(c.chunk, c.labeledType);
    const title = titleFrom(c.chunk, type);
    return {
      type,
      title,
      summary: c.chunk.slice(0, 160),
      body: c.chunk,
      tags: tagsFrom(c.chunk, type),
      importance: c.labeled || SIGNAL_RE.test(c.chunk) ? 0.7 : 0.5,
      quality: c.labeled ? 0.75 : 0.55,
    };
  });
}

/** Extract + dedup atomic units from raw text into NEW candidates. */
export async function distillUnits(
  llm: LlmClient,
  embed: Embedder,
  rawText: string,
  storage: Storage,
  config: AmemConfig,
): Promise<DistillResult> {
  const prompt = buildPrompt(rawText);
  let extracted:
    | {
        units?: Array<{ type?: string; title?: string; summary?: string; body?: string; tags?: string[] }>;
      }
    | undefined;
  try {
    extracted = await llm.completeJSON<{
      units?: Array<{ type?: string; title?: string; summary?: string; body?: string; tags?: string[] }>;
    }>(prompt);
  } catch (err) {
    // A flaky/misconfigured provider must never take down ingest: fall back to
    // the deterministic extractor and surface the failure in the activity feed.
    const message = err instanceof Error ? err.message : String(err);
    await storage.recordEvent({
      kind: 'distill_llm_failed',
      summary: 'LLM distillation failed — used offline extraction',
      meta: { error: message.slice(0, 300) },
    }).catch(() => {});
  }
  const existing = await storage.allUnitsWithEmbeddings();

  // Offline / no-LLM mode: if the model produced nothing, fall back to a
  // deterministic heuristic extraction so ingest still yields units.
  const extractedUnits =
    extracted?.units && extracted.units.length > 0 ? extracted.units : heuristicExtract(rawText);

  const units: CandidateUnit[] = [];
  const deduplicated: Array<{ candidateTitle: string; matchedUnitId: string }> = [];
  let tokensSavedByDedup = 0;

  for (const raw of extractedUnits) {
    if (!raw.title) continue;
    // Hard reject role-only garbage titles even if an LLM emits them.
    if (/^(user|assistant|system)\b/i.test(raw.title.trim()) && raw.title.trim().split(/\s+/).length <= 3) {
      continue;
    }
    const candidate: CandidateUnit = {
      type: isUnitType(raw.type) ? raw.type : 'fact',
      title: raw.title,
      summary: raw.summary ?? '',
      body: raw.body ?? '',
      tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
      importance: 0.5,
      quality: 0.8,
    };
    const vector =
      embed.mode === 'offline'
        ? hashUnitEmbed(
            {
              title: candidate.title,
              summary: candidate.summary,
              body: candidate.body,
            },
            await embed.dims(),
          )
        : await embed.embed(
            [candidate.title, candidate.summary, candidate.body.slice(0, EMBED_BODY_HEAD)]
              .filter(Boolean)
              .join(' '),
          );
    const dup = findDuplicate(
      { title: candidate.title, embedding: { dims: vector.length, values: vector } },
      existing,
      config.thresholds.dedupSimThreshold,
    );
    if (dup) {
      deduplicated.push({ candidateTitle: candidate.title, matchedUnitId: dup.unit.id });
      tokensSavedByDedup += countTokens(candidate.body);
      const merged = mergeUnits(dup.unit, {
        summary: candidate.summary,
        body: candidate.body,
        quality: candidate.quality,
      });
      await storage.updateUnit(merged);
    } else {
      units.push(candidate);
    }
  }

  return { units, deduplicated, tokensSavedByDedup };
}
