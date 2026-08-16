/**
 * Dodo checkout links (docs/05 §2).
 *
 * Built from the product id rather than pasted in as whole URLs, so the query
 * parameters below are applied EVERY time a link is produced — there is no
 * second copy of this logic to forget about.
 *
 * Static-link format verified against the live Dodo docs and by request on
 * 2026-08-16:
 *   test  https://test.checkout.dodopayments.com/buy/{product_id}
 *   live  https://checkout.dodopayments.com/buy/{product_id}
 *
 * WHY `disableEmail=true` MATTERS, and why it is not optional:
 * the webhook maps a subscription back to a user BY CUSTOMER EMAIL
 * (routes/webhooks.ts). If someone signs into the extension as a@agency.com but
 * pays as personal@gmail.com, the upgrade lands on a different user row — the
 * payer stays on the free plan and support has to reconcile it by hand. Locking
 * the field to the authenticated account email removes that failure mode
 * entirely. Do not remove it without changing how webhooks resolve users.
 */

import type { Plan } from '@recruitexport/shared';
import type { Env } from '../env';

export type PaidPlan = Exclude<Plan, 'free'>;

export function productIdFor(env: Env, plan: PaidPlan): string {
  return plan === 'pro_annual'
    ? env.DODO_PRODUCT_ID_PRO_ANNUAL
    : env.DODO_PRODUCT_ID_PRO_MONTHLY;
}

function checkoutBase(env: Env): string {
  if (env.DODO_CHECKOUT_BASE) return env.DODO_CHECKOUT_BASE.replace(/\/$/, '');
  // Fail safe: an unconfigured production Worker should not silently send
  // customers to the TEST checkout, where their card is never charged.
  return env.ENVIRONMENT === 'production'
    ? 'https://checkout.dodopayments.com/buy'
    : 'https://test.checkout.dodopayments.com/buy';
}

export function checkoutUrl(env: Env, plan: PaidPlan, email: string): string {
  const productId = productIdFor(env, plan);
  if (!productId) return '';

  const url = new URL(`${checkoutBase(env)}/${productId}`);
  url.searchParams.set('quantity', '1');
  url.searchParams.set('email', email);
  url.searchParams.set('disableEmail', 'true');

  // Only send people somewhere we actually host. A localhost SITE_BASE during
  // development would strand the customer after a successful payment.
  const site = env.SITE_BASE?.replace(/\/$/, '') ?? '';
  if (/^https:\/\//.test(site)) {
    url.searchParams.set('redirect_url', `${site}/thanks.html`);
  }

  return url.toString();
}

export function checkoutUrls(env: Env, email: string): Record<PaidPlan, string> {
  return {
    pro_monthly: checkoutUrl(env, 'pro_monthly', email),
    pro_annual: checkoutUrl(env, 'pro_annual', email),
  };
}
