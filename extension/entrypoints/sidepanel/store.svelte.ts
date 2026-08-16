/**
 * Panel ⇄ service worker connection.
 *
 * The panel is a pure renderer: it holds no job logic, no quota arithmetic and
 * no extraction knowledge. It sends intents and draws whatever snapshot comes
 * back (docs/02 §2.1).
 *
 * Renders in < 100 ms (docs/06 §4): the first paint uses cached storage values,
 * and the live snapshot hydrates over it.
 */

import { PANEL_PORT, type PanelSnapshot, type PanelToWorker, type WorkerToPanel } from '../../lib/messages';
import { IDLE_JOB } from '../../lib/messages';
import { DEFAULT_SETTINGS } from '../../lib/storage';

export type Screen = 'main' | 'account' | 'presets';

const EMPTY: PanelSnapshot = {
  job: IDLE_JOB,
  page: { kind: 'not_a_search_page' },
  settings: DEFAULT_SETTINGS,
  account: null,
  signedIn: false,
  rolling24hUsed: 0,
  configSource: 'bundled',
  configVersion: 'unknown',
  lastResult: null,
  extensionVersion: '0.0.0',
};

class PanelStore {
  snapshot = $state<PanelSnapshot>(EMPTY);
  screen = $state<Screen>('main');
  toast = $state<{ level: 'info' | 'error' | 'success'; message: string } | null>(null);
  magicLinkSent = $state(false);
  /** True until the first snapshot lands, so we can show skeletons not spinners. */
  hydrating = $state(true);

  #port: chrome.runtime.Port | null = null;
  #toastTimer: ReturnType<typeof setTimeout> | null = null;

  connect(): void {
    this.#port = chrome.runtime.connect({ name: PANEL_PORT });

    this.#port.onMessage.addListener((msg: WorkerToPanel) => {
      switch (msg.type) {
        case 'snapshot':
          this.snapshot = msg.snapshot;
          this.hydrating = false;
          break;
        case 'toast':
          this.showToast(msg.level, msg.message);
          break;
        case 'magicLinkSent':
          this.magicLinkSent = true;
          break;
        case 'fixtureCaptured':
          this.showToast('success', `Fixture saved to ${msg.filename}`);
          break;
      }
    });

    // The MV3 worker sleeps; reconnect so the panel never goes stale.
    this.#port.onDisconnect.addListener(() => {
      this.#port = null;
      setTimeout(() => this.connect(), 250);
    });

    this.send({ type: 'getState' });
    this.send({ type: 'refreshAccount' });
  }

  send(msg: PanelToWorker): void {
    try {
      this.#port?.postMessage(msg);
    } catch {
      /* worker asleep; the reconnect will re-sync */
    }
  }

  showToast(level: 'info' | 'error' | 'success', message: string): void {
    this.toast = { level, message };
    if (this.#toastTimer) clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => (this.toast = null), 6000);
  }

  go(screen: Screen): void {
    this.screen = screen;
  }
}

export const store = new PanelStore();
