/**
 * Page-profile detection (docs/03 §2).
 *
 * Detection = URL match AND >= minProbes structural probes passing.
 * A URL match with failing probes is the "unsupported layout" case: we show
 * state E-unsupported in the UI and emit `profile_detect_fail` — we do NOT
 * guess our way through a layout we do not recognise.
 */

import type { ProfileId } from '@recruitexport/shared';
import type { ProfileConfig, SelectorConfig } from './config-schema';
import { safeQueryAll } from './strategies';

export interface DetectionResult {
  profileId: ProfileId;
  profile: ProfileConfig;
  probesPassed: string[];
  probesFailed: string[];
}

export type DetectionOutcome =
  | { status: 'detected'; result: DetectionResult }
  | { status: 'unsupported_layout'; profileId: ProfileId; probesFailed: string[] }
  | { status: 'not_a_search_page' };

function urlMatches(profile: ProfileConfig, href: string): boolean {
  return profile.urlPatterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(href);
    } catch {
      return false;
    }
  });
}

export function detectProfile(
  doc: Document,
  href: string,
  config: SelectorConfig,
): DetectionOutcome {
  for (const profile of Object.values(config.profiles)) {
    if (!profile || !urlMatches(profile, href)) continue;

    const passed: string[] = [];
    const failed: string[] = [];
    for (const probe of profile.probes) {
      if (safeQueryAll(doc, probe.selector).length > 0) passed.push(probe.id);
      else failed.push(probe.id);
    }

    if (passed.length >= profile.minProbes) {
      return {
        status: 'detected',
        result: {
          profileId: profile.profileId,
          profile,
          probesPassed: passed,
          probesFailed: failed,
        },
      };
    }

    return {
      status: 'unsupported_layout',
      profileId: profile.profileId,
      probesFailed: failed,
    };
  }

  return { status: 'not_a_search_page' };
}

/**
 * Interstitial / challenge / unusual-activity probe (docs/03 §6).
 * If this returns true the job aborts immediately and NEVER auto-retries.
 */
export function isPlatformWarning(doc: Document, profile: ProfileConfig): boolean {
  return profile.platformWarning.some((sel) => safeQueryAll(doc, sel).length > 0);
}

/**
 * Detect a non-English LinkedIn UI (docs/06 state E5). We extract English UI
 * only in v1; the user is warned but allowed to proceed.
 */
export function detectUiLanguage(doc: Document): string | null {
  const lang =
    doc.documentElement.getAttribute('lang') ??
    doc.querySelector('html')?.getAttribute('lang') ??
    null;
  return lang ? lang.toLowerCase() : null;
}

export function isEnglishUi(lang: string | null): boolean {
  // Unknown language: assume English rather than nagging the user (fail soft).
  if (!lang) return true;
  return lang.startsWith('en');
}
