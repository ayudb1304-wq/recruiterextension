/**
 * Worker bindings. Secrets are set with `wrangler secret put` and NEVER
 * committed (docs/08 §7). The extension bundle contains none of these.
 */

export interface Env {
  // secrets
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  JWT_SECRET: string;
  ENRICH_API_KEY: string;
  DODO_WEBHOOK_SECRET: string;
  EMAIL_API_KEY: string;

  // vars
  ENVIRONMENT: string;
  ENRICH_PROVIDER: string;
  EMAIL_FROM: string;
  SITE_BASE: string;
  /**
   * Base for static checkout links, without a trailing slash, e.g.
   * https://test.checkout.dodopayments.com/buy — the product id is appended.
   * Optional: lib/checkout.ts picks test/live from ENVIRONMENT when unset.
   */
  DODO_CHECKOUT_BASE: string;
  DODO_PORTAL_URL: string;
  DODO_PRODUCT_ID_PRO_MONTHLY: string;
  DODO_PRODUCT_ID_PRO_ANNUAL: string;
  /** chrome-extension://<id> allowed by CORS; empty in dev. */
  ALLOWED_EXTENSION_ID: string;

  // bindings
  RE_KV: KVNamespace;
}

export const VERSION = '0.1.0';

export function isDev(env: Env): boolean {
  return env.ENVIRONMENT !== 'production';
}
