/**
 * Cold-start importers (冷启动友好).
 *
 * Import existing assets so a new agent team starts from accumulated
 * experience instead of from scratch:
 * - importDirectory: docs (markdown/text) -> traces + distilled units.
 * - importCodebase: code files -> module units + symbol units + part_of links
 *   (a light-weight CodeGraph with stable ids, so re-imports are idempotent).
 * - importSessions: Codex/Claude/generic JSONL/JSON/TXT agent transcripts
 *   -> traces + distilled units.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { extractText, getDocumentProxy, renderPageAsImage } from 'unpdf';
import type {
  ImportCodebaseInput,
  ImportDirInput,
  ImportPdfInput,
  ImportSessionsInput,
  ImportSourcesResult,
  IngestInput,
  IngestResult,
  Link,
  LinkRelation,
  NewUnit,
  Unit,
  UnitId,
} from './domain.js';
import type { OcrClient } from './ocr.js';
import type { Storage } from './store.js';
import { nowIso } from './lib/util.js';

export interface ImporterDeps {
  storage: Storage;
  ingest: (input: IngestInput) => Promise<IngestResult>;
  saveUnit: (unit: NewUnit) => Promise<Unit>;
  linkUnits: (input: {
    sourceUnitId: UnitId;
    targetUnitId: UnitId;
    relation: LinkRelation;
    reason?: string;
  }) => Promise<Link>;
  /** Optional OCR back-end for scanned PDFs; null disables the fallback. */
  ocr?: OcrClient | null;
  /** Text-layer length below which a PDF is treated as a scan. */
  ocrMinChars?: number;
}

const DEFAULT_DOC_EXTS = ['.md', '.markdown', '.txt'];
const DEFAULT_MAX_FILES = 300;
const MAX_BYTES = 512 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const PDF_CHUNK_BYTES = 4000;
const OCR_PAGE_SCALE = 1.5;
const MAX_CODE_FILES = 500;
const MAX_SYMBOLS_PER_FILE = 60;

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

async function collectFiles(
  root: string,
  extensions: string[],
  maxFiles: number,
  out: string[] = [],
): Promise<string[]> {
  if (out.length >= maxFiles) return out;
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (out.length >= maxFiles) break;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') {
        continue;
      }
      await collectFiles(full, extensions, maxFiles, out);
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
      if (extensions.includes(ext)) out.push(full);
    }
  }
  return out;
}

async function readCapped(file: string, maxBytes = MAX_BYTES): Promise<string> {
  const st = await stat(file);
  if (st.size > maxBytes) return '';
  const buf = await readFile(file);
  return buf.toString('utf8').slice(0, maxBytes);
}

function stableId(prefix: string, key: string): string {
  return `${prefix}_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// importDirectory — documents
// ---------------------------------------------------------------------------

export async function importDirectory(
  deps: ImporterDeps,
  input: ImportDirInput,
): Promise<ImportSourcesResult> {
  const extensions = input.extensions ?? DEFAULT_DOC_EXTS;
  const files = await collectFiles(input.path, extensions, DEFAULT_MAX_FILES);
  let units = 0;
  let traces = 0;
  let links = 0;
  let sources = 0;
  let tokensSavedByDedup = 0;

  for (const file of files) {
    const content = await readCapped(file);
    if (!content.trim()) continue;
    const rel = relative(input.path, file);
    const result = await deps.ingest({
      title: rel,
      content,
      contentType: file.endsWith('.txt') ? 'text/plain' : 'text/markdown',
      sourceUri: rel,
      sourceKind: input.sourceKind ?? 'file',
      extract: input.extract ?? true,
      autoLink: false,
    });
    units += result.units.length;
    traces += 1;
    sources += 1;
    tokensSavedByDedup += result.tokensSavedByDedup;
  }
  links = await relink(deps, files.length);
  return { units, traces, links, sources, files: files.length, sessions: 0, tokensSavedByDedup };
}

/**
 * Import a single PDF: in-process text extraction (unpdf, pure JS) -> chunks
 * -> ingest. Scanned PDFs (no text layer) fall back to OCR when an OCR client
 * is configured. Self-local: bytes never leave the instance.
 */
export async function importPdf(
  deps: ImporterDeps,
  input: ImportPdfInput,
): Promise<ImportSourcesResult> {
  const maxBytes = input.maxBytes ?? MAX_PDF_BYTES;
  if (input.contentBase64.length > Math.ceil(maxBytes / 3) * 4 + 16) {
    throw new Error(`PDF too large: max ${maxBytes} bytes`);
  }
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (!bytes.length || bytes.length > maxBytes) {
    throw new Error(`PDF too large or empty: ${bytes.length} bytes`);
  }

  const { text } = await extractText(new Uint8Array(bytes), { mergePages: true });
  let plain = text.replaceAll('\u0000', '').trim();
  const minChars = deps.ocrMinChars ?? 60;
  let ocrPages = 0;
  if (plain.length < minChars) {
    if (deps.ocr) {
      const recovered = await ocrScannedPdf(bytes, deps.ocr);
      if (recovered.text) {
        plain = recovered.text;
        ocrPages = recovered.pages;
      }
    }
  }
  if (!plain) {
    return { units: 0, traces: 0, links: 0, sources: 0, files: 1, sessions: 0, tokensSavedByDedup: 0 };
  }

  const chunks = chunkPdfText(plain, PDF_CHUNK_BYTES);
  let units = 0;
  let tokensSavedByDedup = 0;
  const stem = input.filename.replace(/\.pdf$/i, '');

  for (const [index, chunk] of chunks.entries()) {
    const result = await deps.ingest({
      title: chunks.length > 1 ? `${stem} · §${index + 1}/${chunks.length}` : stem,
      content: chunk,
      contentType: 'text/plain',
      sourceUri: input.filename,
      sourceKind: 'file',
      extract: input.extract ?? true,
      autoLink: false,
      zoneId: input.zone,
    });
    units += result.units.length;
    tokensSavedByDedup += result.tokensSavedByDedup;
  }

  return {
    units,
    traces: 1,
    links: 0,
    sources: chunks.length,
    files: 1,
    sessions: 0,
    tokensSavedByDedup,
    ...(ocrPages > 0 ? { ocrPages } : {}),
  };
}

/**
 * Render every page to a PNG (via @napi-rs/canvas) and ask the OCR client to
 * transcribe it. Returns the concatenated Markdown, or '' when nothing could
 * be recovered. Page images are posted in-memory and never persisted.
 */
async function ocrScannedPdf(
  bytes: Buffer,
  ocr: OcrClient,
): Promise<{ text: string; pages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const png = await renderPageAsImage(new Uint8Array(bytes), pageNumber, {
      scale: OCR_PAGE_SCALE,
      canvasImport: () => import('@napi-rs/canvas'),
    });
    const base64 = Buffer.from(png).toString('base64');
    const markdown = (await ocr.recognize(base64, 'image/png')).trim();
    if (markdown) pages.push(markdown);
  }
  return { text: pages.join('\n\n'), pages: pages.length };
}

function chunkPdfText(text: string, maxBytes: number): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= 24);
  if (paragraphs.length === 0) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length >= 24 ? [flat.slice(0, maxBytes * 4)] : [];
  }
  const chunks: string[] = [];
  let buf: string[] = [];
  let size = 0;
  for (const p of paragraphs) {
    if (size + p.length > maxBytes && buf.length) {
      chunks.push(buf.join('\n\n'));
      buf = [];
      size = 0;
    }
    buf.push(p);
    size += p.length;
  }
  if (buf.length) chunks.push(buf.join('\n\n'));
  return chunks;
}

async function relink(_deps: ImporterDeps, _files: number): Promise<number> {
  // Link generation runs in the service wrapper (needs embedder); here we only
  // report a placeholder count that the service replaces.
  return 0;
}

// ---------------------------------------------------------------------------
// importCodebase — light CodeGraph
// ---------------------------------------------------------------------------

interface CodeSymbol {
  kind: string;
  name: string;
  signature: string;
  line: number;
}

const SYMBOL_EXTRACTORS: Array<{ exts: string[]; rules: Array<{ kind: string; re: RegExp }> }> = [
  {
    exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    rules: [
      { kind: 'function', re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm },
      { kind: 'class', re: /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
      { kind: 'interface', re: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm },
      { kind: 'type', re: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm },
      { kind: 'enum', re: /^(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/gm },
      { kind: 'const', re: /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm },
    ],
  },
  {
    exts: ['.py'],
    rules: [
      { kind: 'function', re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm },
      { kind: 'class', re: /^class\s+([A-Za-z_]\w*)/gm },
    ],
  },
  {
    exts: ['.go'],
    rules: [
      { kind: 'func', re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm },
      { kind: 'type', re: /^type\s+([A-Za-z_]\w*)\s/gm },
    ],
  },
  {
    exts: ['.rs'],
    rules: [
      { kind: 'fn', re: /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/gm },
      { kind: 'struct', re: /^(?:pub\s+)?struct\s+([A-Za-z_]\w*)/gm },
      { kind: 'enum', re: /^(?:pub\s+)?enum\s+([A-Za-z_]\w*)/gm },
      { kind: 'trait', re: /^(?:pub\s+)?trait\s+([A-Za-z_]\w*)/gm },
    ],
  },
  {
    exts: ['.java', '.kt', '.scala'],
    rules: [
      { kind: 'class', re: /^(?:public|private|protected|final|abstract|sealed)?\s*class\s+([A-Za-z_]\w*)/gm },
      { kind: 'interface', re: /^(?:public)?\s*interface\s+([A-Za-z_]\w*)/gm },
      { kind: 'enum', re: /^(?:public)?\s*enum\s+([A-Za-z_]\w*)/gm },
      { kind: 'method', re: /^(?:public|private|protected)\s+(?:static\s+)?[\w<>,?[\]]+\s+([a-zA-Z_]\w*)\s*\(/gm },
    ],
  },
];

function languageFor(file: string): { lang: string; rules: Array<{ kind: string; re: RegExp }> } | null {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  for (const group of SYMBOL_EXTRACTORS) {
    if (group.exts.includes(ext)) return { lang: ext.slice(1), rules: group.rules };
  }
  return null;
}

function extractSymbols(source: string, rules: Array<{ kind: string; re: RegExp }>): CodeSymbol[] {
  const lines = source.split('\n');
  const out: CodeSymbol[] = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(source)) !== null && out.length < MAX_SYMBOLS_PER_FILE) {
      const name = m[1];
      if (!name) continue;
      const lineNo = source.slice(0, m.index).split('\n').length;
      out.push({
        kind: rule.kind,
        name,
        signature: (lines[lineNo - 1] ?? '').trim().slice(0, 160),
        line: lineNo,
      });
    }
  }
  out.sort((a, b) => a.line - b.line);
  return out.slice(0, MAX_SYMBOLS_PER_FILE);
}

function moduleSummary(source: string): string {
  const first = source
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 3 && !l.startsWith('//') && !l.startsWith('#')) ?? '';
  return first.slice(0, 200) || '(no summary)';
}

export async function importCodebase(
  deps: ImporterDeps,
  input: ImportCodebaseInput,
): Promise<ImportSourcesResult> {
  const maxFiles = input.maxFiles ?? MAX_CODE_FILES;
  const extensions = input.extensions ?? [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.scala',
    '.rb', '.php', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.swift', '.sh', '.sql',
  ];
  const files = await collectFiles(input.path, extensions, maxFiles);
  const now = nowIso();
  let units = 0;
  let links = 0;
  let sources = 0;

  for (const file of files) {
    const lang = languageFor(file);
    const source = await readCapped(file, input.maxBytesPerFile ?? MAX_BYTES);
    if (!source.trim()) continue;
    const rel = relative(input.path, file);
    const symbols = lang ? extractSymbols(source, lang.rules) : [];
    const sourceRow = await deps.storage.upsertSource({
      id: stableId('src', rel),
      uri: rel,
      title: rel,
      kind: 'file',
      contentHash: createHash('sha1').update(source).digest('hex'),
      contentLength: source.length,
      createdAt: now,
    });
    sources += 1;

    const moduleUnit = await deps.saveUnit({
      id: stableId('mod', rel),
      type: 'concept',
      form: 'unit',
      title: `Module: ${rel}`,
      summary: moduleSummary(source),
      body:
        `Path: ${rel}\n` +
        `Symbols: ${symbols.length}\n` +
        symbols.map((s) => `- ${s.kind} ${s.name} (line ${s.line})`).join('\n'),
      tags: [lang?.lang ?? 'code', 'code', 'codegraph'],
      labels: { kind: 'module', lang: lang?.lang ?? 'unknown' },
      status: 'reviewed',
      quality: 0.8,
      confidence: 0.8,
      importance: 0.5,
      decay: 1,
    });
    units += 1;
    await deps.storage.addCitation({
      unitId: moduleUnit.id,
      sourceId: sourceRow.id,
      span: moduleUnit.summary,
      assertedAt: now,
    });

    for (const sym of symbols) {
      const symUnit = await deps.saveUnit({
        id: stableId('sym', `${rel}:${sym.name}`),
        type: 'fact',
        form: 'unit',
        title: `${sym.kind}: ${sym.name} — ${rel}`,
        summary: sym.signature || `${sym.kind} ${sym.name}`,
        body: `File: ${rel}\nLine: ${sym.line}\n\n${sym.signature}`,
        tags: [lang?.lang ?? 'code', 'code', 'codegraph', sym.kind],
        labels: { kind: 'symbol', symbolKind: sym.kind },
        status: 'reviewed',
        quality: 0.7,
        confidence: 0.8,
        importance: 0.3,
        decay: 1,
      });
      units += 1;
      await deps.storage.addCitation({
        unitId: symUnit.id,
        sourceId: sourceRow.id,
        span: sym.signature,
        assertedAt: now,
      });
      await deps.linkUnits({
        sourceUnitId: moduleUnit.id,
        targetUnitId: symUnit.id,
        relation: 'part_of',
        reason: `symbol ${sym.name} defined in ${rel}`,
      });
      links += 1;
    }
  }

  return { units, traces: 0, links, sources, files: files.length, sessions: 0, tokensSavedByDedup: 0 };
}

// ---------------------------------------------------------------------------
// importSessions — agent transcripts
// ---------------------------------------------------------------------------

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        const o = item as Record<string, unknown>;
        if (o.type === 'text' && typeof o.text === 'string') return o.text;
        if (o.type === 'text' && typeof o.content === 'string') return o.content;
        if (o.type === 'tool_call' || o.type === 'tool_use') return `[tool:${String(o.name ?? o.id ?? 'call')}]`;
        if (o.type === 'reasoning' || o.type === 'thinking') return '';
        if (typeof o.text === 'string') return o.text;
        if (typeof o.content === 'string') return o.content;
        return '';
      })
      .filter((t) => t.length > 0)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    const o = content as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.content === 'string') return o.content;
  }
  return '';
}

function messageRole(m: Record<string, unknown>): string {
  const inner = (m.message as Record<string, unknown> | undefined) ?? m;
  const role = typeof inner.role === 'string' ? inner.role : (m.role as string | undefined);
  return role ?? 'assistant';
}

function messageText(m: Record<string, unknown>): string {
  const inner = (m.message as Record<string, unknown> | undefined) ?? m;
  return contentToText(inner.content ?? m.content);
}

function parseJsonlFile(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as Record<string, unknown>;
      if (item.type === 'message' || item.type === 'input' || item.message || item.role || item.content) {
        const role = messageRole(item);
        const body = messageText(item);
        if (body.trim()) out.push([role, body.trim()]);
      }
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

function parseJsonFile(text: string): Array<[string, string]> {
  try {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)?.messages)
        ? ((parsed as Record<string, unknown>).messages as unknown[])
        : [];
    return list
      .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object')
      .map((m) => [messageRole(m), messageText(m)] as [string, string])
      .filter(([, t]) => t.trim().length > 0);
  } catch {
    return [];
  }
}

function parseTxtFile(text: string): Array<[string, string]> {
  const ROLE = /^(user|assistant|human|model|system|tool)\s*[:：]\s*/i;
  const out: Array<[string, string]> = [];
  let current: [string, string] | null = null;
  for (const raw of text.split('\n')) {
    const m = ROLE.exec(raw);
    if (m) {
      if (current && current[1].trim()) out.push(current);
      current = [(m[1] ?? 'assistant').toLowerCase(), raw.slice((m[0] ?? '').length)];
    } else if (current) {
      current[1] += `\n${raw}`;
    }
  }
  if (current && current[1].trim()) out.push(current);
  return out;
}

function formatTranscript(pairs: Array<[string, string]>): string {
  return pairs
    .map(([role, text]) => `${role}: ${text}`)
    .join('\n\n')
    .slice(0, 40000);
}

export async function importSessions(
  deps: ImporterDeps,
  input: ImportSessionsInput,
): Promise<ImportSourcesResult> {
  const st = await stat(input.path);
  const files: string[] = st.isDirectory() ? await collectFiles(input.path, ['.jsonl', '.json', '.txt'], 200) : [input.path];
  let units = 0;
  let traces = 0;
  let sources = 0;
  let tokensSavedByDedup = 0;

  for (const file of files) {
    const raw = await readCapped(file);
    if (!raw.trim()) continue;
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    const format = (input.format ?? 'auto') === 'auto' ? ext : input.format;
    const pairs =
      format === '.txt' || format === 'txt'
        ? parseTxtFile(raw)
        : format === '.json' || format === 'json'
          ? parseJsonFile(raw)
          : parseJsonlFile(raw);
    if (pairs.length === 0) continue;
    const label = input.sessionLabel ?? file.slice(file.lastIndexOf('/') + 1, file.lastIndexOf('.'));
    const result = await deps.ingest({
      title: label,
      content: formatTranscript(pairs),
      contentType: 'text/plain',
      sessionId: label,
      extract: input.extract ?? true,
      autoLink: false,
    });
    units += result.units.length;
    traces += 1;
    sources += result.units.length > 0 ? 1 : 0;
    tokensSavedByDedup += result.tokensSavedByDedup;
  }
  return { units, traces, links: 0, sources, files: files.length, sessions: files.length, tokensSavedByDedup };
}
