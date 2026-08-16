/**
 * Selector config schema (docs/03 §5).
 *
 * COMPLIANCE — DO NOT RELAX (docs/08 §3):
 * config carries ONLY declarative selector / regex / registered-postprocess-name
 * data. There is no field that can carry JavaScript, no eval, no dynamic import,
 * no URL that gets fetched and executed. This is what keeps remote selector
 * hot-fixes inside MV3's remote-code prohibition. Any PR that adds an
 * expression-like field to this schema breaks that guarantee.
 */

import { z } from 'zod';
import { PROFILE_IDS, FIELD_NAMES } from '@recruitexport/shared';
import { POSTPROCESS_NAMES } from './postprocess';

const tier = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/** What to pull off a matched element. */
const extractMode = z.enum(['textContent', 'exists']);

/** A CSS selector. Length-capped so a bad config can't build a pathological query. */
const selector = z.string().min(1).max(512);

/** Regex source string. Compiled with `new RegExp` — never with `eval`. */
const regexSource = z.string().min(1).max(512);

const baseStrategy = z.object({ tier });

export const strategySchema = z.discriminatedUnion('type', [
  /** Tier-1/3 workhorse: a CSS selector, scoped to the card root by default. */
  baseStrategy.extend({
    type: z.literal('css'),
    selector,
    extract: extractMode.default('textContent'),
    /** 'card' (default) scopes to the card root; 'document' searches the page. */
    within: z.enum(['card', 'document']).default('card'),
  }),

  /** CSS scoped to the card root, expressed as a path from it. */
  baseStrategy.extend({
    type: z.literal('relative'),
    from: z.literal('cardRoot'),
    path: selector,
    extract: extractMode.default('textContent'),
  }),

  /** Tier-2: regex over a subtree's textContent, capture group N. */
  baseStrategy.extend({
    type: z.literal('textRegex'),
    /** Optional CSS to narrow the subtree first; omitted = whole card. */
    within: selector.optional(),
    pattern: regexSource,
    flags: z.string().regex(/^[gimsuy]*$/).max(6).default('i'),
    group: z.number().int().min(0).max(9).default(1),
  }),

  /** An attribute of a matched node. */
  baseStrategy.extend({
    type: z.literal('attr'),
    selector,
    attribute: z.string().min(1).max(64),
  }),

  /** Pull a value out of an href: a query param, or a regex capture. */
  baseStrategy.extend({
    type: z.literal('urlParam'),
    selector,
    attribute: z.string().min(1).max(64).default('href'),
    /** query-string parameter name */
    param: z.string().min(1).max(64).optional(),
    /** or a regex capture over the whole URL */
    pattern: regexSource.optional(),
    group: z.number().int().min(0).max(9).default(1),
  }),
]);

export type Strategy = z.infer<typeof strategySchema>;

/** Only names registered in postprocess.ts are accepted — config cannot name code. */
const postprocessName = z.enum(POSTPROCESS_NAMES);

export const fieldMapSchema = z.object({
  field: z.enum(FIELD_NAMES),
  strategies: z.array(strategySchema).min(1).max(12),
  postprocess: z.array(postprocessName).max(12).default([]),
  /** Counted in the page extraction rate. Non-expected fields (surface-specific) are not. */
  expected: z.boolean().default(true),
});

export type FieldMap = z.infer<typeof fieldMapSchema>;

/** A structural probe: does this element exist? Used for detection + warnings. */
export const probeSchema = z.object({
  id: z.string().min(1).max(64),
  selector,
});

export const profileConfigSchema = z.object({
  profileId: z.enum(PROFILE_IDS),
  /** Regex sources matched against location.href. */
  urlPatterns: z.array(regexSource).min(1).max(8),
  /** Detection = URL match AND >= `minProbes` of these passing (docs/03 §2). */
  probes: z.array(probeSchema).min(2).max(12),
  minProbes: z.number().int().min(2).max(12).default(2),
  /** Ordered candidates for the element containing the result cards. */
  resultsContainer: z.array(selector).min(1).max(8),
  /** Ordered candidates for the repeating result card. */
  cardSelectors: z.array(selector).min(1).max(8),
  pagination: z.object({
    /** Ordered candidates for the "next page" control. Clicked, never mutated. */
    nextButton: z.array(selector).max(8).default([]),
    /** Element to scroll to reveal lazily-rendered cards. */
    scrollContainer: z.array(selector).max(8).default([]),
    /** Optional "page X of Y" text for progress display. */
    pageIndicator: z.array(selector).max(8).default([]),
  }),
  /**
   * If ANY of these match, LinkedIn is showing an interstitial/challenge.
   * The job aborts immediately and never auto-retries (docs/03 §6).
   */
  platformWarning: z.array(selector).max(12).default([]),
  fields: z.array(fieldMapSchema).min(1).max(40),
});

export type ProfileConfig = z.infer<typeof profileConfigSchema>;

export const selectorConfigSchema = z.object({
  configVersion: z.string().min(1).max(64),
  /**
   * Partial: a config may ship only the profile that changed. The loader merges
   * a single-profile remote response over the bundled set (config-loader.ts).
   */
  profiles: z.partialRecord(z.enum(PROFILE_IDS), profileConfigSchema),
});

export type SelectorConfig = z.infer<typeof selectorConfigSchema>;

/**
 * Parse untrusted config (remote or cached). Never throws — an invalid config
 * is rejected so the caller can keep the last-good one and emit `config_invalid`.
 */
export function parseSelectorConfig(
  input: unknown,
): { ok: true; config: SelectorConfig } | { ok: false; issue: string } {
  const result = selectorConfigSchema.safeParse(input);
  if (result.success) return { ok: true, config: result.data };
  const first = result.error.issues[0];
  const path = first?.path.join('.') ?? '(root)';
  return { ok: false, issue: `${path}: ${first?.message ?? 'invalid'}` };
}
