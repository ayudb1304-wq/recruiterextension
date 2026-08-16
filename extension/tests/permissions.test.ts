import { describe, expect, it } from 'vitest';
import { HOST_PERMISSIONS, MANIFEST_PERMISSIONS } from '@recruitexport/shared';

/**
 * CLAUDE.md guardrail 5 / docs/08 §2. If this test fails, someone widened the
 * extension's reach. That is allowed — but only together with an update to
 * docs/08 §2 and the CWS permission-justification text in docs/09, because a
 * reviewer will ask why. Update the expectation deliberately, never reflexively.
 */
describe('manifest permissions', () => {
  it('is exactly the documented set', () => {
    expect([...MANIFEST_PERMISSIONS]).toEqual([
      'storage',
      'sidePanel',
      'downloads',
      'identity',
      'alarms',
    ]);
  });

  it('reaches linkedin.com and nothing else', () => {
    expect([...HOST_PERMISSIONS]).toEqual(['https://www.linkedin.com/*']);
  });

  it('does not request the permissions docs/08 §2 forbids', () => {
    const forbidden = ['tabs', '<all_urls>', 'scripting', 'webRequest', 'cookies', 'history'];
    for (const permission of forbidden) {
      expect(MANIFEST_PERMISSIONS as readonly string[]).not.toContain(permission);
      expect(HOST_PERMISSIONS as readonly string[]).not.toContain(permission);
    }
  });
});
