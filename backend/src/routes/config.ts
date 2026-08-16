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

  const row = await getActiveSelectorConfig(c.get('db'), profile);

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
