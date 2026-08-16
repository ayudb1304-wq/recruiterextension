/**
 * Extraction engine (docs/03 §4).
 *
 * Contract, in order of importance:
 *  1. It never throws. A mutilated card yields nulls and a recorded miss.
 *  2. It never writes to the DOM.
 *  3. It records WHICH strategy tier won, so telemetry can tell "still working"
 *     from "limping along on tier-3 class names about to break".
 */

import {
  FIELD_NAMES,
  TIER_CONFIDENCE,
  type ExtractedCard,
  type FieldName,
  type FieldResult,
  type ProfileId,
} from '@recruitexport/shared';
import type { FieldMap, ProfileConfig } from './config-schema';
import { applyPostprocess } from './postprocess';
import { firstMatch, firstMatchAll, resolveStrategy } from './strategies';

const MISS: FieldResult = { value: null, confidence: 'low', strategyTier: null };

export interface EngineHooks {
  /** Called when a field extractor throws — surfaced as `extractor_exception`. */
  onExtractorException?: (field: FieldName, message: string) => void;
}

/** Resolve one field: strategies in config order, first hit wins. */
export function extractField(
  map: FieldMap,
  cardRoot: Element,
  doc: Document,
  hooks: EngineHooks = {},
): FieldResult {
  for (const strategy of map.strategies) {
    let raw: string | null;
    try {
      raw = resolveStrategy(strategy, { cardRoot, doc });
    } catch (err) {
      // resolveStrategy is defensive already; this is the belt to its braces.
      hooks.onExtractorException?.(map.field, err instanceof Error ? err.message : 'unknown');
      continue;
    }
    if (raw == null) continue;

    const value = applyPostprocess(raw, map.postprocess);
    if (value == null) continue;

    return {
      value,
      confidence: TIER_CONFIDENCE[strategy.tier],
      strategyTier: strategy.tier,
    };
  }
  return { ...MISS };
}

/** Extract every mapped field from one card. Never throws. */
export function extractCard(
  cardRoot: Element,
  opts: {
    profile: ProfileConfig;
    configVersion: string;
    cardIndex: number;
    pageNumber: number;
    doc: Document;
    hooks?: EngineHooks;
  },
): ExtractedCard {
  const fields = {} as Record<FieldName, FieldResult>;
  // Start every known field as a miss so the record shape is always complete,
  // even for fields this profile does not map.
  for (const name of FIELD_NAMES) fields[name] = { ...MISS };

  for (const map of opts.profile.fields) {
    try {
      fields[map.field] = extractField(map, cardRoot, opts.doc, opts.hooks);
    } catch (err) {
      opts.hooks?.onExtractorException?.(
        map.field,
        err instanceof Error ? err.message : 'unknown',
      );
      fields[map.field] = { ...MISS };
    }
  }

  return {
    fields,
    cardIndex: opts.cardIndex,
    pageNumber: opts.pageNumber,
    extractedAt: new Date().toISOString(),
    profileId: opts.profile.profileId as ProfileId,
    configVersion: opts.configVersion,
  };
}

export interface PageExtraction {
  cards: ExtractedCard[];
  /** fields extracted / fields expected, across the page (docs/03 §4). */
  extractionRate: number;
  /** per-field miss counts — counts only, no scraped values (docs/03 §9). */
  fieldMisses: Record<string, number>;
  /** How many cards the card selector found. */
  cardsFound: number;
}

/** Find the repeating result cards on the current page. */
export function findCards(doc: Document, profile: ProfileConfig): Element[] {
  const container = firstMatch(doc, profile.resultsContainer) ?? doc;
  return firstMatchAll(container, profile.cardSelectors);
}

/** Extract every card currently in the DOM. Never throws. */
export function extractPage(opts: {
  doc: Document;
  profile: ProfileConfig;
  configVersion: string;
  pageNumber: number;
  /** cardIndex continues across pages so indices are unique within a job. */
  startIndex?: number;
  hooks?: EngineHooks;
}): PageExtraction {
  const cardEls = findCards(opts.doc, opts.profile);
  const expectedFields = opts.profile.fields.filter((f) => f.expected);
  const fieldMisses: Record<string, number> = {};
  const cards: ExtractedCard[] = [];

  let extracted = 0;
  const startIndex = opts.startIndex ?? 0;

  cardEls.forEach((el, i) => {
    const card = extractCard(el, {
      profile: opts.profile,
      configVersion: opts.configVersion,
      cardIndex: startIndex + i,
      pageNumber: opts.pageNumber,
      doc: opts.doc,
      hooks: opts.hooks ?? {},
    });
    cards.push(card);

    for (const map of expectedFields) {
      const result = card.fields[map.field];
      if (result?.value != null) {
        extracted += 1;
      } else {
        fieldMisses[map.field] = (fieldMisses[map.field] ?? 0) + 1;
      }
    }
  });

  const expectedTotal = expectedFields.length * cardEls.length;
  // No cards found is a detection problem, not a 0% extraction rate — report 0
  // and let the caller distinguish via `cardsFound`.
  const extractionRate = expectedTotal === 0 ? 0 : extracted / expectedTotal;

  return { cards, extractionRate, fieldMisses, cardsFound: cardEls.length };
}
