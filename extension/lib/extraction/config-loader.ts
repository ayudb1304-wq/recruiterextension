/**
 * Selector config loading (docs/03 §5).
 *
 * Load order, strictly: fresh remote → cached last-good → bundled snapshot.
 * An invalid remote config is REJECTED and the last-good is kept, plus a
 * `config_invalid` telemetry event. The extension must keep working with the
 * endpoint dead — that fallback chain is tested in Phase 7.
 */

import type { ProfileId } from '@recruitexport/shared';
import snapshot from './config.snapshot.json';
import { parseSelectorConfig, type ProfileConfig, type SelectorConfig } from './config-schema';
import { getCachedConfig, saveCachedConfig } from '../storage';
import { getSelectorConfig } from '../api';

export type ConfigSource = 'remote' | 'cache' | 'bundled';

export interface LoadedConfig {
  config: SelectorConfig;
  source: ConfigSource;
}

/** The bundled snapshot, parsed once. If THIS fails the build is broken. */
let bundledCache: SelectorConfig | null = null;

export function bundledConfig(): SelectorConfig {
  if (bundledCache) return bundledCache;
  const parsed = parseSelectorConfig(snapshot);
  if (!parsed.ok) {
    throw new Error(`bundled config.snapshot.json is invalid: ${parsed.issue}`);
  }
  bundledCache = parsed.config;
  return bundledCache;
}

export interface LoadOptions {
  /** Skip the network entirely (offline, or the caller already has fresh config). */
  offline?: boolean;
  onInvalidConfig?: (issue: string, source: ConfigSource) => void;
}

/**
 * Resolve the config to use right now. Never throws (except on a broken build,
 * see bundledConfig) and never returns null — there is always a config.
 */
export async function loadConfig(
  profileHint: ProfileId | null,
  opts: LoadOptions = {},
): Promise<LoadedConfig> {
  if (!opts.offline) {
    try {
      const res = await getSelectorConfig(profileHint ?? 'salesnav_people_search');
      // The endpoint returns one profile; normalize to the full-config shape.
      const candidate = normalizeRemote(res);
      const parsed = parseSelectorConfig(candidate);
      if (parsed.ok) {
        await saveCachedConfig(candidate);
        return { config: parsed.config, source: 'remote' };
      }
      opts.onInvalidConfig?.(parsed.issue, 'remote');
    } catch {
      // Offline or 5xx — fall through to cache.
    }
  }

  const cached = await getCachedConfig();
  if (cached) {
    const parsed = parseSelectorConfig(cached.raw);
    if (parsed.ok) return { config: parsed.config, source: 'cache' };
    opts.onInvalidConfig?.(parsed.issue, 'cache');
  }

  return { config: bundledConfig(), source: 'bundled' };
}

/**
 * The endpoint may answer either with the full `{configVersion, profiles}` shape
 * or with docs/05 §3's single-profile `{configVersion, profile}` shape. Accept
 * both, and merge a single profile over the bundled set so the other profile
 * still works.
 */
function normalizeRemote(res: unknown): unknown {
  if (!res || typeof res !== 'object') return res;
  const obj = res as Record<string, unknown>;
  if (obj['profiles']) return obj;

  const profile = obj['profile'];
  if (!profile || typeof profile !== 'object') return obj;

  const profileId = (profile as Record<string, unknown>)['profileId'];
  if (typeof profileId !== 'string') return obj;

  return {
    configVersion: obj['configVersion'] ?? 'unknown',
    profiles: {
      ...bundledConfig().profiles,
      [profileId]: profile,
    },
  };
}

export function profileFrom(
  config: SelectorConfig,
  profileId: ProfileId,
): ProfileConfig | null {
  return config.profiles[profileId] ?? null;
}
