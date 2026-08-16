/**
 * Magic-link auth (docs/05 §1).
 *
 * No passwords, and never a LinkedIn credential (CLAUDE.md guardrail 3).
 * /auth/request-link always answers `{ok:true}` so the endpoint cannot be used
 * to enumerate which agencies have accounts.
 */

import { Hono } from 'hono';
import { MAGIC_LINK_TTL_MS, RATE_LIMITS } from '@recruitexport/shared';
import type { App } from '../lib/middleware';
import { clientIp, rateLimit, requireAuth } from '../lib/middleware';
import { fail } from '../lib/errors';
import { randomToken, sha256Hex, signJwt } from '../lib/jwt';
import { consumeAuthToken, storeAuthToken, upsertUser } from '../db/queries';
import { sendMagicLinkEmail } from '../lib/email';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

export const authRoutes = new Hono<App>();

authRoutes.post('/request-link', async (c) => {
  const body = await c.req.json<{ email?: unknown }>().catch(() => ({ email: undefined }));
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

  await rateLimit(c, `link-ip:${clientIp(c)}`, RATE_LIMITS.authLinkPerIpPerHour, 3600);

  // Invalid input still answers ok — same reason as the enumeration guard.
  if (!EMAIL_RE.test(email) || email.length > 254) return c.json({ ok: true });

  await rateLimit(c, `link-email:${email}`, RATE_LIMITS.authLinkPerEmailPerHour, 3600);

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString();

  await storeAuthToken(c.get('db'), { tokenHash, email, expiresAt });

  const link = `${c.env.SITE_BASE.replace(/\/$/, '')}/auth.html#token=${token}`;
  await sendMagicLinkEmail(c.env, email, link);

  return c.json({ ok: true });
});

/**
 * The handoff: the site page reads `#token=…`, POSTs it here, and hands the JWT
 * to the extension via `chrome.runtime.sendMessage` (externally_connectable).
 * The fragment never reaches our server logs because the browser does not send
 * fragments — the page posts it explicitly.
 */
authRoutes.post('/verify', async (c) => {
  const body = await c.req.json<{ token?: unknown }>().catch(() => ({ token: undefined }));
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) fail(400, 'bad_token', 'That sign-in link is not valid.');

  await rateLimit(c, `verify-ip:${clientIp(c)}`, 20, 3600);

  const row = await consumeAuthToken(c.get('db'), await sha256Hex(token));
  if (!row) fail(400, 'bad_token', 'That sign-in link has expired or was already used.');

  const user = await upsertUser(c.get('db'), row.email);
  const { token: jwt, expiresAt } = await signJwt(
    { sub: user.id, email: user.email },
    c.env.JWT_SECRET,
  );

  return c.json({ token: jwt, expiresAt, email: user.email });
});

authRoutes.post('/refresh', requireAuth, async (c) => {
  const { token, expiresAt } = await signJwt(
    { sub: c.get('userId'), email: c.get('email') },
    c.env.JWT_SECRET,
  );
  return c.json({ token, expiresAt, email: c.get('email') });
});
