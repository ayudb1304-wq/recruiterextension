/**
 * Enrichment provider interface (docs/02 §2.5).
 *
 * One interface, swappable adapters, so the concrete vendor is a Sept-1 pricing
 * decision and not an architectural commitment. Record the chosen provider and
 * its pricing in docs/05 §5 when you sign up.
 *
 * The provider key lives only here, in the Worker (docs/08 §1).
 */

import type { EmailStatus } from '@recruitexport/shared';
import type { Env } from '../env';

export interface FindEmailInput {
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  companyDomain: string | null;
}

export interface FindEmailResult {
  email: string | null;
  status: EmailStatus;
  companyDomain: string | null;
  /** Provider-side id, for support tickets. Never stored (docs/04 §5). */
  providerRef: string | null;
}

export interface EnrichProvider {
  readonly name: string;
  findEmail(input: FindEmailInput, env: Env, signal?: AbortSignal): Promise<FindEmailResult>;
}

export const NOT_FOUND: FindEmailResult = {
  email: null,
  status: 'not_found',
  companyDomain: null,
  providerRef: null,
};

/**
 * Dev/test adapter. Deterministic, hits no network, spends no credits.
 * ENRICH_PROVIDER=mock selects it — the default in .dev.vars.example.
 */
export const mockProvider: EnrichProvider = {
  name: 'mock',
  async findEmail(input) {
    if (!input.lastName) return NOT_FOUND;
    const domain = input.companyDomain ?? guessDomain(input.companyName);
    if (!domain) return NOT_FOUND;
    const local = [input.firstName, input.lastName]
      .filter(Boolean)
      .join('.')
      .toLowerCase()
      .replace(/[^a-z.]/g, '');
    if (!local) return NOT_FOUND;
    // Vary the status so the UI's verified/risky/not_found paths get exercised.
    const bucket = local.charCodeAt(0) % 3;
    const status: EmailStatus = bucket === 0 ? 'verified' : bucket === 1 ? 'risky' : 'not_found';
    return {
      email: status === 'not_found' ? null : `${local}@${domain}`,
      status,
      companyDomain: domain,
      providerRef: `mock_${local}`,
    };
  },
};

function guessDomain(companyName: string | null): string | null {
  if (!companyName) return null;
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return slug.length >= 2 && slug.length <= 40 ? `${slug}.com` : null;
}

/**
 * ⚠️ ADAPTER TEMPLATE — not wired to a real vendor yet (docs/07 Phase 6).
 * Fill in the request/response shape from the provider's docs after signup,
 * then record the vendor + pricing in docs/05 §5. Kept deliberately thin: the
 * only thing that should differ between vendors is this file.
 */
export const httpProviderTemplate: EnrichProvider = {
  name: 'http-template',
  async findEmail(input, env, signal) {
    if (!env.ENRICH_API_KEY) return NOT_FOUND;
    // A real adapter replaces the URL, auth header and body mapping below.
    console.warn('enrichment adapter not configured; returning not_found');
    void input;
    void signal;
    return NOT_FOUND;
  },
};

export function resolveProvider(env: Env): EnrichProvider {
  switch (env.ENRICH_PROVIDER) {
    case 'mock':
      return mockProvider;
    default:
      return httpProviderTemplate;
  }
}
