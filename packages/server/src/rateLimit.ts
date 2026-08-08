import { AmemError } from '@amem/core';

export type RateLimitBucket = 'login' | 'bootstrap' | 'oauth' | 'register';

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface RateLimiterOptions {
  enabled: boolean;
  rules: Record<RateLimitBucket, RateLimitRule>;
  /** Injected clock for deterministic tests. */
  now?: () => number;
}

interface BucketState {
  timestamps: number[];
}

/**
 * Per-IP sliding-window rate limiter for auth/token endpoints.
 *
 * In-memory only (single process, same as login sessions). Keys are
 * `${bucket}:${ip}` so a burst against one endpoint never blocks another.
 * Stale entries are pruned on every check, keeping memory bounded.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly opts: RateLimiterOptions;

  constructor(opts: RateLimiterOptions) {
    this.opts = opts;
  }

  /** Returns the rule's limit, or 0 when throttling is disabled. */
  private limitFor(bucket: RateLimitBucket): number {
    if (!this.opts.enabled) return 0;
    return this.opts.rules[bucket].limit;
  }

  /**
   * Records a hit for `ip`+`bucket` and throws RATE_LIMITED when the sliding
   * window is over the limit. Returns remaining allowance for instrumentation.
   */
  check(bucket: RateLimitBucket, ip: string): { allowed: boolean; remaining: number } {
    const limit = this.limitFor(bucket);
    if (limit <= 0) return { allowed: true, remaining: Number.POSITIVE_INFINITY };
    const now = this.opts.now ? this.opts.now() : Date.now();
    const { windowMs } = this.opts.rules[bucket];
    const key = `${bucket}:${ip}`;
    let state = this.buckets.get(key);
    if (!state) {
      state = { timestamps: [] };
      this.buckets.set(key, state);
    }
    state.timestamps.push(now);
    // Sliding window: keep only hits within the last windowMs.
    const cutoff = now - windowMs;
    state.timestamps = state.timestamps.filter((t) => t > cutoff);
    if (state.timestamps.length > limit) {
      throw new AmemError('RATE_LIMITED', `Too many requests for ${bucket}; try again later`);
    }
    return { allowed: true, remaining: limit - state.timestamps.length };
  }

  /** Drop all state (tests, config reloads). */
  reset(): void {
    this.buckets.clear();
  }
}

/** Map an auth-adjacent URL to its rate-limit bucket, if any. */
export function bucketForUrl(url: string): RateLimitBucket | undefined {
  if (url === '/api/v1/auth/login') return 'login';
  if (url === '/api/v1/auth/bootstrap') return 'bootstrap';
  if (url === '/oauth/register') return 'register';
  if (
    url === '/oauth/authorize' ||
    url === '/oauth/consent' ||
    url === '/oauth/token' ||
    url === '/oauth/revoke'
  ) {
    return 'oauth';
  }
  return undefined;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** Build a limiter from AmemConfig-style values with per-bucket defaults. */
export function createRateLimiter(partial?: {
  enabled?: boolean;
  loginPerMinute?: number;
  bootstrapPerHour?: number;
  oauthPerMinute?: number;
  registerPerHour?: number;
  now?: () => number;
}): RateLimiter {
  return new RateLimiter({
    enabled: partial?.enabled ?? true,
    now: partial?.now,
    rules: {
      login: { limit: partial?.loginPerMinute ?? 10, windowMs: MINUTE },
      bootstrap: { limit: partial?.bootstrapPerHour ?? 3, windowMs: HOUR },
      oauth: { limit: partial?.oauthPerMinute ?? 20, windowMs: MINUTE },
      register: { limit: partial?.registerPerHour ?? 10, windowMs: HOUR },
    },
  });
}
