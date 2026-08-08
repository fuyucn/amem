import { describe, expect, it } from 'vitest';
import { AmemError } from '@amem/core';
import { bucketForUrl, createRateLimiter } from '../src/rateLimit.js';

describe('RateLimiter', () => {
  it('allows requests under the limit and rejects the first over-limit hit', () => {
    const now = () => 1_700_000_000_000;
    const limiter = createRateLimiter({ loginPerMinute: 2, now });
    expect(limiter.check('login', '1.2.3.4').allowed).toBe(true);
    expect(limiter.check('login', '1.2.3.4').allowed).toBe(true);
    expect(() => limiter.check('login', '1.2.3.4')).toThrowError(AmemError);
    try {
      limiter.check('login', '1.2.3.4');
    } catch (err) {
      expect((err as AmemError).code).toBe('RATE_LIMITED');
    }
  });

  it('buckets are independent per IP and per endpoint', () => {
    const now = () => 1_700_000_000_000;
    const limiter = createRateLimiter({ loginPerMinute: 1, oauthPerMinute: 1, now });
    expect(() => limiter.check('login', '1.2.3.4')).not.toThrow();
    expect(() => limiter.check('login', '5.6.7.8')).not.toThrow();
    expect(() => limiter.check('oauth', '1.2.3.4')).not.toThrow();
    expect(() => limiter.check('login', '1.2.3.4')).toThrowError(AmemError);
  });

  it('sliding window expires old hits', () => {
    let t = 1_700_000_000_000;
    const limiter = createRateLimiter({ loginPerMinute: 1, now: () => t });
    limiter.check('login', '1.2.3.4');
    t += 61_000; // window is 60s — the old hit has expired
    expect(() => limiter.check('login', '1.2.3.4')).not.toThrow();
  });

  it('disabled limiter never rejects', () => {
    const limiter = createRateLimiter({ enabled: false });
    for (let i = 0; i < 100; i++) {
      expect(() => limiter.check('login', '1.2.3.4')).not.toThrow();
    }
  });

  it('maps auth endpoints to buckets', () => {
    expect(bucketForUrl('/api/v1/auth/login')).toBe('login');
    expect(bucketForUrl('/api/v1/auth/bootstrap')).toBe('bootstrap');
    expect(bucketForUrl('/oauth/register')).toBe('register');
    expect(bucketForUrl('/oauth/token')).toBe('oauth');
    expect(bucketForUrl('/oauth/consent')).toBe('oauth');
    expect(bucketForUrl('/oauth/authorize')).toBe('oauth');
    expect(bucketForUrl('/api/v1/health')).toBeUndefined();
    expect(bucketForUrl('/mcp')).toBeUndefined();
  });
});
