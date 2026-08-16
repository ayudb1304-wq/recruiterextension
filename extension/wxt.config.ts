import { defineConfig } from 'wxt';
import { HOST_PERMISSIONS, MANIFEST_PERMISSIONS } from '../shared/src/constants';

/** Set once the Google Cloud OAuth client exists (Phase 3, human task). */
const GOOGLE_CLIENT_ID = import.meta.env.WXT_GOOGLE_CLIENT_ID ?? '';

/**
 * MINIMAL PERMISSIONS (CLAUDE.md guardrail 5, docs/08 §2).
 * Adding anything here requires updating docs/08 §2 and the CWS listing
 * justification text in docs/09. No `tabs`, no `<all_urls>`, no `scripting`,
 * no `webRequest`.
 */
export default defineConfig({
  srcDir: '.',
  modules: ['@wxt-dev/module-svelte'],
  manifestVersion: 3,
  manifest: ({ mode }) => ({
    name: 'Recruiter Export — Sales Navigator to CSV & ATS',
    // Single-purpose statement. Reviewers read this first (docs/08 §3).
    description:
      'Export the LinkedIn Sales Navigator or Recruiter search results you are already viewing into a clean, ATS-ready CSV or Google Sheet.',
    permissions: [...MANIFEST_PERMISSIONS],
    host_permissions: [...HOST_PERMISSIONS],
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    action: { default_title: 'Recruiter Export' },
    side_panel: { default_path: 'sidepanel.html' },
    // Omitted entirely until the client id exists — Chrome refuses to load an
    // unpacked extension with an empty oauth2.client_id. Human task, Phase 3:
    // create the Google Cloud OAuth client and set WXT_GOOGLE_CLIENT_ID.
    ...(GOOGLE_CLIENT_ID
      ? {
          oauth2: {
            client_id: GOOGLE_CLIENT_ID,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
          },
        }
      : {}),
    // The auth handoff page (site/auth.html) posts the JWT to the extension.
    externally_connectable: {
      matches:
        mode === 'development'
          ? ['http://localhost/*', 'https://*.github.io/*']
          : ['https://*.github.io/*'],
    },
    minimum_chrome_version: '116',
  }),
  webExt: {
    // Don't auto-open a browser during `wxt dev`; the developer loads unpacked.
    disabled: true,
  },
  vite: () => ({
    build: {
      // CWS reviewers dislike opaque bundles; keep output readable-ish.
      minify: 'esbuild',
      sourcemap: false,
    },
  }),
});
