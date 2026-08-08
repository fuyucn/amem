import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Provider API-key encryption (AES-256-GCM).
 *
 * Keys are derived from the instance `authSecret` with a domain-separation
 * prefix so the same secret is never reused for a different purpose. When no
 * secret is configured (auth disabled), keys are stored with a `plain:`
 * marker so the format is still unambiguous — API responses mask keys either
 * way. Changing AMEM_AUTH_SECRET invalidates previously encrypted keys; the
 * UI will show them as missing and they must be re-entered.
 */

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(`amem.provider.v1:${secret}`).digest();
}

export function encryptProviderKey(apiKey: string, secret?: string): string {
  if (!secret) return `plain:${apiKey}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const enc = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptProviderKey(stored: string, secret?: string): string {
  if (stored.startsWith('plain:')) return stored.slice('plain:'.length);
  if (!stored.startsWith('enc:')) return '';
  const parts = stored.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || !secret) return '';
  const ivHex = parts[2]!;
  const tagHex = parts[3]!;
  const dataHex = parts[4]!;
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
