import type { Context, MiddlewareHandler, Next } from 'hono';
import { RATE_LIMITS } from '@recruitexport/shared';
import type { Env } from '../env';
import { Db } from '../db/client';
import { fail } from './errors';
import { verifyJwt } from './jwt';

export interface Vars {
  userId: string;
  email: string;
  db: Db;
}

export type App = { Bindings: Env; Variables: Vars };

export const withDb: MiddlewareHandler<App> = async (c, next) => {
  c.set('db', new Db(c.env));
  await next();
};

export const requireAuth: MiddlewareHandler<App> = async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) fail(401, 'not_signed_in', 'Sign in to continue.');

  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) fail(401, 'not_signed_in', 'Your session expired. Sign in again.');

  c.set('userId', payload.sub);
  c.set('email', payload.email);
  await next();
};

/**
 * CORS: the extension origin and the site (for the auth handoff page).
 * Never `*` (docs/05 §8) — this API is called with a bearer token.
 */
export function corsMiddleware(): MiddlewareHandler<App> {
  return async (c, next) => {
    const origin = c.req.header('origin') ?? '';
    const allowed = allowedOrigin(c.env, origin);

    if (c.req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(allowed) });
    }

    await next();
    if (allowed) {
      for (const [key, value] of Object.entries(corsHeaders(allowed))) {
        c.res.headers.set(key, value);
      }
    }
  };
}

function allowedOrigin(env: Env, origin: string): string | null {
  if (!origin) return null;
  if (env.ALLOWED_EXTENSION_ID && origin === `chrome-extension://${env.ALLOWED_EXTENSION_ID}`) {
    return origin;
  }
  // Compare ORIGINS, not raw strings. SITE_BASE legitimately carries a path
  // (GitHub Pages project sites live at /<repo>/), but a browser's Origin
  // header is only scheme + host + port. Comparing the two directly meant the
  // auth handoff page would be refused by CORS the moment SITE_BASE had a path.
  if (env.SITE_BASE) {
    try {
      if (origin === new URL(env.SITE_BASE).origin) return origin;
    } catch {
      // Malformed SITE_BASE: fall through rather than throwing on every request.
    }
  }
  // Dev convenience only: unpacked extension ids change on every reload.
  if (env.ENVIRONMENT !== 'production' && origin.startsWith('chrome-extension://')) return origin;
  if (env.ENVIRONMENT !== 'production' && origin.startsWith('http://localhost')) return origin;
  return null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

/**
 * KV-backed fixed-window counter. Not perfectly accurate under concurrency —
 * accepted: this is abuse dampening, not billing (docs/08 §1 "accept residual
 * risk"). The authoritative caps are the quota reservations in Postgres.
 */
export async function rateLimit(
  c: Context<App>,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${bucket}:${window}`;
  const current = Number((await c.env.RE_KV.get(key)) ?? '0');

  if (current >= limit) {
    fail(429, 'rate_limited', 'Too many requests. Try again shortly.', {
      retryAfter: new Date((window + 1) * windowSeconds * 1000).toISOString(),
    });
  }

  await c.env.RE_KV.put(key, String(current + 1), { expirationTtl: windowSeconds * 2 });
}

export function clientIp(c: Context<App>): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
}

export const globalRateLimit: MiddlewareHandler<App> = async (c, next) => {
  await rateLimit(c, `ip:${clientIp(c)}`, RATE_LIMITS.perIpPerMin, 60);
  await next();
};

export const perUserRateLimit: MiddlewareHandler<App> = async (c, next) => {
  await rateLimit(c, `user:${c.get('userId')}`, RATE_LIMITS.perUserPerMin, 60);
  await next();
};

export async function noop(_c: Context<App>, next: Next): Promise<void> {
  await next();
}
