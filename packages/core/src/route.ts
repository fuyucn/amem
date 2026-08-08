/**
 * Task-to-asset routing (统一管理、审核和路由).
 *
 * Given a task description, rank published assets (skills/wiki/codegraph/
 * prompts) by how well they apply. Deterministic and offline-safe: keyword
 * overlap over name/description/trigger/tags/body, with a trigger-hit bonus
 * so "when to use" hints dominate. Agent scope follows the same rule as
 * callAsset (public/workspace, or an explicit agent binding).
 */
import type {
  Asset,
  AssetKind,
  AssetRouteItem,
  AssetRouteResult,
  RouteAssetsInput,
} from './domain.js';
import type { Storage } from './store.js';
import { countTokens } from './lib/tokenizer.js';

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'what', 'how', 'did', 'was',
  'please', 'help', 'need', 'want', 'would', 'could', 'should', 'about',
]);

export interface RouteEngineOptions {
  /** defaults to 5 */
  limit?: number;
}

function termsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function overlap(queryTerms: string[], text: string): number {
  if (queryTerms.length === 0) return 0;
  const haystack = new Set(termsOf(text));
  let hits = 0;
  for (const t of queryTerms) if (haystack.has(t)) hits++;
  return hits / queryTerms.length;
}

/** True when the agent may use this asset (mirrors callAsset's rule). */
export function agentCanUse(asset: Asset, agent?: string): boolean {
  if (!agent) return true;
  return (
    asset.visibility === 'public' ||
    asset.visibility === 'workspace' ||
    asset.boundAgents.includes(agent)
  );
}

function scoreAsset(queryTerms: string[], asset: Asset): { score: number; reason: string } {
  const haystacks: Array<[string, number, string]> = [
    [asset.name, 1, 'name'],
    [asset.description, 0.6, 'description'],
    [asset.trigger, 0.8, 'trigger'],
    [asset.tags.join(' '), 0.7, 'tags'],
    [asset.body.slice(0, 1200), 0.4, 'body'],
  ];
  let score = 0;
  const signals: string[] = [];
  for (const [text, weight, label] of haystacks) {
    const o = overlap(queryTerms, text);
    if (o > 0) {
      score += o * weight;
      signals.push(`${label} ${o.toFixed(2)}`);
    }
  }
  if (score === 0) return { score: 0, reason: 'no signal' };
  return { score: Math.min(2, score), reason: signals.join(' + ') };
}

/** Rank published, agent-visible assets against a task description. */
export async function routeAssets(
  storage: Storage,
  input: RouteAssetsInput,
  opts: RouteEngineOptions = {},
): Promise<AssetRouteResult> {
  const queryTerms = termsOf(input.task);
  const limit = input.limit ?? opts.limit ?? 5;
  const all = await storage.listAssets({
    kind: input.kind,
    status: 'published',
    limit: 1000,
  });
  const items: AssetRouteItem[] = [];
  let usedTokens = 0;
  for (const asset of all) {
    if (!agentCanUse(asset, input.agent)) continue;
    if (asset.status !== 'published') continue;
    const { score, reason } = scoreAsset(queryTerms, asset);
    if (score <= 0) continue;
    usedTokens += countTokens(`${asset.name}\n${asset.description}\n${asset.trigger}`);
    items.push({ asset, score, reason });
  }
  items.sort((a, b) => b.score - a.score || (a.asset.name < b.asset.name ? -1 : 1));
  return { query: input.task, items: items.slice(0, limit), usedTokens };
}

export type { AssetKind, AssetRouteResult };
