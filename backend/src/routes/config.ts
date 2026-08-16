/**
 * Selector config endpoint (docs/05 §3).
 *
 * Public — the extension needs selectors before the user signs in.
 * Edge-cached 5 minutes, which is also the propagation target for a hot-fix
 * (docs/02 §3.3).
 *
 * What this serves is DATA: selectors, regex sources and postprocess NAMES,
 * validated on the way in (admin path) and again by the extension on the way
 * out. It never serves code (docs/08 §3).
 */

import { Hono } from 'hono';
import type { SelectorConfigResponse } from '@recruitexport/shared';
import { PROFILE_IDS } from '@recruitexport/shared';
import type { App } from '../lib/middleware';
import { getActiveSelectorConfig } from '../db/queries';

export const configRoutes = new Hono<App>();

configRoutes.get('/selectors', async (c) => {
  const profile = c.req.query('profile') ?? 'salesnav_people_search';
  // `v` is the extension version — logged for future version gating (docs/05 §3).
  const extensionVersion = c.req.query('v') ?? 'unknown';

  if (!(PROFILE_IDS as readonly string[]).includes(profile)) {
    return c.json({ error: 'unknown_profile', message: 'No such page profile.' }, 404);
  }

  let row;
  try {
    row = await getActiveSelectorConfig(c.get('db'), profile);
  } catch (err) {
    // Fail SOFT, deliberately. This is the endpoint every install polls, and a
    // 204 makes the extension use its bundled snapshot — which is the designed
    // fallback (docs/03 §5). Answering 500 would turn "our database blinked"
    // into an error surfaced across every user for no benefit, since the
    // extension's behaviour is identical either way.
    console.error(
      `selector config lookup failed for ${profile}: ${
        err instanceof Error ? err.message : 'unknown'
      }`,
    );
    return c.body(null, 204);
  }

  if (!row) {
    // No active config: the extension falls back to its bundled snapshot, which
    // is exactly the designed behaviour — so this is a 204, not an error.
    console.log(`no active config for ${profile} (ext ${extensionVersion})`);
    return c.body(null, 204);
  }

  const response: SelectorConfigResponse = {
    configVersion: row.config_version,
    profile: row.config,
  };

  c.header('cache-control', 'public, max-age=300');
  return c.json(response);
});
