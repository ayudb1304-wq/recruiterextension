import { describe, expect, it } from 'vitest';
import { randomToken, sha256Hex, signJwt, timingSafeEqual, verifyJwt } from '../src/lib/jwt';

const SECRET = 'test-secret-at-least-32-characters-long!!';

describe('signJwt / verifyJwt', () => {
  it('round-trips a payload', async () => {
    const { token } = await signJwt({ sub: 'user-1', email: 'a@b.com' }, SECRET);
    const payload = await verifyJwt(token, SECRET);
    expect(payload?.sub).toBe('user-1');
    expect(payload?.email).toBe('a@b.com');
  });

  it('reports the expiry it issued', async () => {
    const { expiresAt } = await signJwt({ sub: 'u', email: 'e' }, SECRET, 3600);
    const delta = new Date(expiresAt).getTime() - Date.now();
    expect(delta).toBeGreaterThan(3_500_000);
    expect(delta).toBeLessThan(3_700_000);
  });

  it('rejects a token signed with a different secret', async () => {
    const { token } = await signJwt({ sub: 'u', email: 'e' }, SECRET);
    expect(await verifyJwt(token, 'a-completely-different-secret-value!!')).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const { token } = await signJwt({ sub: 'user-1', email: 'a@b.com' }, SECRET);
    const [header, , signature] = token.split('.');
    const forged = btoa(JSON.stringify({ sub: 'admin', email: 'x', iat: 1, exp: 9e9 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await verifyJwt(`${header}.${forged}.${signature}`, SECRET)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { token } = await signJwt({ sub: 'u', email: 'e' }, SECRET, -10);
    expect(await verifyJwt(token, SECRET)).toBeNull();
  });

  it('rejects structurally invalid tokens instead of throwing', async () => {
    for (const bad of ['', 'a', 'a.b', 'a.b.c.d', 'not.a.token']) {
      expect(await verifyJwt(bad, SECRET)).toBeNull();
    }
  });

  it('survives a unicode email round-trip', async () => {
    const { token } = await signJwt({ sub: 'u', email: 'jörg@münchen.de' }, SECRET);
    expect((await verifyJwt(token, SECRET))?.email).toBe('jörg@münchen.de');
  });
});

describe('sha256Hex', () => {
  it('matches the known digest for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('randomToken', () => {
  it('produces distinct URL-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('timingSafeEqual', () => {
  it('compares correctly', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
