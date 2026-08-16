/**
 * HS256 JWTs (docs/05 §1). 30-day expiry, `{ sub, email }`.
 *
 * Implemented on WebCrypto rather than a dependency: the Worker runtime has it,
 * and a token library is a supply-chain surface we do not need for one alg.
 */

import { JWT_TTL_SECONDS } from '@recruitexport/shared';

export interface JwtPayload {
  sub: string;
  email: string;
  iat: number;
  exp: number;
}

const encoder = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signJwt(
  payload: { sub: string; email: string },
  secret: string,
  ttlSeconds = JWT_TTL_SECONDS,
): Promise<{ token: string; expiresAt: string }> {
  const now = Math.floor(Date.now() / 1000);
  const body: JwtPayload = { ...payload, iat: now, exp: now + ttlSeconds };

  const header = b64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const claims = b64url(encoder.encode(JSON.stringify(body)));
  const signingInput = `${header}.${claims}`;

  const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(signingInput));

  return {
    token: `${signingInput}.${b64url(signature)}`,
    expiresAt: new Date(body.exp * 1000).toISOString(),
  };
}

/** Returns null for any invalid token — bad signature, malformed, or expired. */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, claims, signature] = parts as [string, string, string];

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await key(secret),
      b64urlDecode(signature),
      encoder.encode(`${header}.${claims}`),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let payload: JwtPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(claims))) as JwtPayload;
  } catch {
    return null;
  }

  if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
  if (payload.exp * 1000 <= Date.now()) return null;

  return payload;
}

/** Magic-link tokens are stored hashed, never in plaintext (docs/05 §1). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

/** Constant-time comparison for webhook signatures and token lookups. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
