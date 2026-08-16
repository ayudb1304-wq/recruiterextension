import { Hono } from 'hono';
import type { MeResponse } from '@recruitexport/shared';
import type { App } from '../lib/middleware';
import { requireAuth, perUserRateLimit } from '../lib/middleware';
import { effectivePlan, findUserById, getSubscription, getUsage } from '../db/queries';
import { fail } from '../lib/errors';

export const meRoutes = new Hono<App>();

meRoutes.use('*', requireAuth, perUserRateLimit);

/** docs/05 §2 */
meRoutes.get('/', async (c) => {
  const db = c.get('db');
  const userId = c.get('userId');

  const user = await findUserById(db, userId);
  if (!user) fail(401, 'not_signed_in', 'Account not found. Sign in again.');

  const subscription = await getSubscription(db, userId);
  const plan = effectivePlan(subscription);
  const usage = await getUsage(db, userId, plan);

  const response: MeResponse = {
    email: user.email,
    plan,
    status: subscription.status,
    periodEnd: subscription.current_period_end,
    usage,
    checkoutUrls: {
      // Prefilled email so the user does not retype it at checkout.
      pro_monthly: withEmail(c.env.DODO_CHECKOUT_URL_PRO_MONTHLY, user.email),
      pro_annual: withEmail(c.env.DODO_CHECKOUT_URL_PRO_ANNUAL, user.email),
    },
    portalUrl: c.env.DODO_PORTAL_URL ?? '',
  };

  return c.json(response);
});

function withEmail(url: string, email: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('email', email);
    return parsed.toString();
  } catch {
    return url;
  }
}
