/**
 * LinkedIn content script — the DUMB EXTRACTOR (docs/02 §2.1).
 *
 * READ-ONLY (CLAUDE.md guardrail 1). The complete list of things this file is
 * allowed to do to the page:
 *   - querySelector / read textContent and attributes
 *   - scroll a container to reveal results the search already returned
 *   - click the "next page" control
 * Nothing else. No messages, no connection requests, no profile edits, no
 * likes, no follows, no writes of any kind. If a change here needs more than
 * the above, it is out of scope by design — stop and flag it.
 *
 * All timing goes through lib/throttle.ts (guardrail 2). There is no path in
 * this file that paginates without awaiting a throttle delay.
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import type { ProfileId } from '@recruitexport/shared';
import { extractPage } from '../lib/extraction/engine';
import { loadConfig, profileFrom } from '../lib/extraction/config-loader';
import type { ProfileConfig, SelectorConfig } from '../lib/extraction/config-schema';
import {
  detectProfile,
  detectUiLanguage,
  isEnglishUi,
  isPlatformWarning,
} from '../lib/extraction/profiles';
import { firstMatch } from '../lib/extraction/strategies';
import { Throttle, ThrottleCapError, humanScroll } from '../lib/throttle';
import { CONTENT_PORT, type ContentToWorker, type PageStatus, type ScrapeEndReason, type WorkerToContent } from '../lib/messages';

export default defineContentScript({
  matches: ['https://www.linkedin.com/sales/*', 'https://www.linkedin.com/talent/*'],
  runAt: 'document_idle',

  async main() {
    let port: chrome.runtime.Port | null = null;
    let config: SelectorConfig | null = null;
    let configSource = 'bundled';
    let currentJob: { id: string; abort: AbortController } | null = null;

    // ── config ───────────────────────────────────────────────────────────────

    async function ensureConfig(): Promise<SelectorConfig> {
      if (config) return config;
      const loaded = await loadConfig(null, {
        onInvalidConfig: (issue, source) => {
          send({ type: 'extractorException', field: `config:${source}`, message: issue });
        },
      });
      config = loaded.config;
      configSource = loaded.source;
      return config;
    }

    // ── page status ──────────────────────────────────────────────────────────

    function statusFor(cfg: SelectorConfig): PageStatus {
      const outcome = detectProfile(document, location.href, cfg);
      if (outcome.status === 'not_a_search_page') return { kind: 'not_a_search_page' };
      if (outcome.status === 'unsupported_layout') {
        return { kind: 'unsupported_layout', profileId: outcome.profileId };
      }
      const lang = detectUiLanguage(document);
      return {
        kind: 'supported',
        profileId: outcome.result.profileId,
        resultCountEstimate: estimateResultCount(outcome.result.profile),
        uiLanguage: lang,
        isEnglishUi: isEnglishUi(lang),
      };
    }

    /** Best-effort "about N results" reading for the S2 header. Never required. */
    function estimateResultCount(profile: ProfileConfig): number | null {
      const indicator = firstMatch(document, profile.pagination.pageIndicator);
      const text = indicator?.textContent ?? '';
      const m = /of\s+([\d,.]+)/i.exec(text);
      if (m?.[1]) {
        const n = Number.parseInt(m[1].replace(/[^\d]/g, ''), 10);
        if (Number.isFinite(n)) return n;
      }
      return null;
    }

    // ── port ─────────────────────────────────────────────────────────────────

    function send(msg: ContentToWorker): void {
      try {
        port?.postMessage(msg);
      } catch {
        // Worker asleep or port closed — the next connect will re-sync.
      }
    }

    async function connect(): Promise<void> {
      const cfg = await ensureConfig();
      port = chrome.runtime.connect({ name: CONTENT_PORT });
      port.onMessage.addListener((msg: WorkerToContent) => {
        void handleWorkerMessage(msg);
      });
      port.onDisconnect.addListener(() => {
        port = null;
        // A disconnect mid-job means the worker went away; stop scraping.
        currentJob?.abort.abort();
        currentJob = null;
      });
      send({
        type: 'hello',
        href: location.href,
        status: statusFor(cfg),
        configSource,
        configVersion: cfg.configVersion,
      });
    }

    async function handleWorkerMessage(msg: WorkerToContent): Promise<void> {
      switch (msg.type) {
        case 'requestStatus': {
          const cfg = await ensureConfig();
          send({ type: 'status', href: location.href, status: statusFor(cfg) });
          break;
        }
        case 'startScrape':
          await runScrape(msg.jobId, msg.rowCap, msg.rolling24hUsed);
          break;
        case 'cancel':
          if (currentJob?.id === msg.jobId) currentJob.abort.abort();
          break;
        case 'captureFixture':
          captureFixture();
          break;
      }
    }

    // ── the scrape loop ──────────────────────────────────────────────────────

    async function runScrape(jobId: string, rowCap: number, rolling24hUsed: number): Promise<void> {
      if (currentJob) {
        // One job at a time (docs/03 §6). Concurrent attempts are rejected.
        send({ type: 'scrapeEnd', jobId, reason: 'error', pagesVisited: 0 });
        return;
      }

      const cfg = await ensureConfig();
      const status = statusFor(cfg);
      if (status.kind !== 'supported') {
        send({ type: 'scrapeEnd', jobId, reason: 'error', pagesVisited: 0 });
        return;
      }

      const profile = profileFrom(cfg, status.profileId);
      if (!profile) {
        send({ type: 'scrapeEnd', jobId, reason: 'error', pagesVisited: 0 });
        return;
      }

      const abort = new AbortController();
      currentJob = { id: jobId, abort };
      const throttle = new Throttle({ rolling24hUsed, signal: abort.signal });

      let rows = 0;
      let pageNumber = 0;
      let reason: ScrapeEndReason = 'no_more_pages';
      const startHref = location.href;

      try {
        // Loop invariant: every iteration past the first has awaited a
        // throttled page delay. There is no fast path.
        for (;;) {
          if (abort.signal.aborted) {
            reason = 'cancelled';
            break;
          }

          // The user navigating away ends the job cleanly — we never keep
          // scraping a page they left.
          if (!sameSearch(startHref, location.href)) {
            reason = 'navigated_away';
            break;
          }

          if (isPlatformWarning(document, profile)) {
            send({ type: 'platformWarning', jobId });
            reason = 'platform_warning';
            break;
          }

          throttle.registerPage();
          pageNumber += 1;

          // Reveal lazily-rendered cards by scrolling like a reader.
          const scrollTarget = firstMatch(document, profile.pagination.scrollContainer);
          await humanScroll(scrollTarget ?? window, throttle, {
            untilStable: () => abort.signal.aborted,
          });

          const page = extractPage({
            doc: document,
            profile,
            configVersion: cfg.configVersion,
            pageNumber,
            startIndex: rows,
            hooks: {
              onExtractorException: (field, message) =>
                send({ type: 'extractorException', field, message }),
            },
          });

          if (page.cardsFound === 0) {
            reason = pageNumber === 1 ? 'error' : 'no_more_pages';
            break;
          }

          const remaining = rowCap - rows;
          const cards = page.cards.slice(0, Math.max(0, remaining));
          rows += cards.length;
          throttle.registerRows(cards.length);

          send({
            type: 'cards',
            jobId,
            pageNumber,
            cards,
            extractionRate: page.extractionRate,
            fieldMisses: page.fieldMisses,
            cardsFound: page.cardsFound,
          });

          if (rows >= rowCap) {
            reason = 'reached_cap';
            break;
          }

          if (!throttle.canVisitAnotherPage()) {
            reason = 'page_cap';
            break;
          }

          const next = findNextControl(profile);
          if (!next) {
            reason = 'no_more_pages';
            break;
          }

          // The one and only permitted click: advance to results the user's own
          // search already returned.
          await throttle.pageDelay();
          if (abort.signal.aborted) {
            reason = 'cancelled';
            break;
          }
          next.click();

          // Give the SPA time to swap the list in, at human speed.
          await throttle.pageDelay();
        }
      } catch (err) {
        if (err instanceof ThrottleCapError) {
          reason = err.cap === 'pages' ? 'page_cap' : 'reached_cap';
        } else if ((err as Error)?.name === 'AbortError') {
          reason = 'cancelled';
        } else {
          reason = 'error';
        }
      } finally {
        currentJob = null;
        send({ type: 'scrapeEnd', jobId, reason, pagesVisited: pageNumber });
      }
    }

    /**
     * A "next" control that is disabled or absent means we are done — we never
     * synthesize navigation by editing the URL.
     */
    function findNextControl(profile: ProfileConfig): HTMLElement | null {
      const el = firstMatch(document, profile.pagination.nextButton);
      if (!el || !(el instanceof HTMLElement)) return null;
      if (el.hasAttribute('disabled')) return null;
      if (el.getAttribute('aria-disabled') === 'true') return null;
      return el;
    }

    /** Same search = same path and same query, ignoring the page cursor. */
    function sameSearch(a: string, b: string): boolean {
      try {
        const ua = new URL(a);
        const ub = new URL(b);
        return ua.origin === ub.origin && ua.pathname === ub.pathname;
      } catch {
        return false;
      }
    }

    // ── dev-only fixture capture (docs/03 §7) ────────────────────────────────

    function captureFixture(): void {
      if (import.meta.env.WXT_DEV_CAPTURE !== '1') return;
      void (async () => {
        const cfg = await ensureConfig();
        const status = statusFor(cfg);
        if (status.kind !== 'supported') return;
        const profile = profileFrom(cfg, status.profileId);
        if (!profile) return;
        const container = firstMatch(document, profile.resultsContainer);
        if (!container) return;
        // Raw capture — the human runs scripts/sanitize-fixture.ts before this
        // ever gets committed. Raw files are gitignored.
        send({ type: 'fixtureCaptured', html: container.outerHTML, profileId: status.profileId });
      })();
    }

    // ── SPA navigation: LinkedIn swaps pages without a reload ────────────────

    let lastHref = location.href;
    const observer = new MutationObserver(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      void (async () => {
        const cfg = await ensureConfig();
        send({ type: 'status', href: location.href, status: statusFor(cfg) });
      })();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    await connect();

    // The MV3 worker sleeps after ~30s idle; reconnect so the panel can always
    // reach a live content script.
    setInterval(() => {
      if (!port) void connect();
    }, 5000);
  },
});

export type { ProfileId };
