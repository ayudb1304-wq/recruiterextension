/**
 * Service worker — job orchestration (docs/02 §2.1).
 *
 * Owns: the export job state machine, quota calls, enrichment batching, output
 * assembly, dedupe history, telemetry. The content script decides nothing; the
 * side panel renders what this sends it.
 *
 * MV3 note: this worker sleeps. Nothing here assumes it stays alive between
 * user actions — state that must survive is in chrome.storage, and both ports
 * reconnect on wake.
 */

import { defineBackground } from 'wxt/utils/define-background';
import { CONFIG_REFRESH_MINUTES, type ProfileId } from '@recruitexport/shared';
import * as api from '../lib/api';
import { ApiRequestError } from '../lib/api';
import { buildCsv, buildRows, csvDataUrl, csvFilename } from '../lib/csv';
import { loadConfig } from '../lib/extraction/config-loader';
import { ExportJob, type JobDeps } from '../lib/job';
import {
  CONTENT_PORT,
  IDLE_JOB,
  PANEL_PORT,
  type ContentToWorker,
  type ExportRequest,
  type JobState,
  type LastResult,
  type PageStatus,
  type PanelSnapshot,
  type PanelToWorker,
  type WorkerToContent,
  type WorkerToPanel,
} from '../lib/messages';
import { resolvePreset } from '../lib/presets';
import { pushToSheets, SheetsApiError, SheetsAuthError } from '../lib/sheets';
import * as storage from '../lib/storage';
import { flushTelemetry, TelemetryBuffer } from '../lib/telemetry';

export default defineBackground(() => {
  // ── in-memory state (rebuilt on wake) ──────────────────────────────────────

  const contentPorts = new Map<number, chrome.runtime.Port>();
  const contentStatus = new Map<number, PageStatus>();
  const panelPorts = new Set<chrome.runtime.Port>();

  let job: ExportJob | null = null;
  let jobState: JobState = { ...IDLE_JOB };
  let jobTabId: number | null = null;
  let lastResult: LastResult | null = null;
  /** Held only long enough for the user to re-download / push to Sheets. */
  let lastCsv: string | null = null;
  let lastRowsForSheets: string[][] | null = null;
  let configSource = 'bundled';
  let configVersion = 'unknown';

  // ── side panel plumbing ────────────────────────────────────────────────────

  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    void chrome.alarms.create('config-refresh', { periodInMinutes: CONFIG_REFRESH_MINUTES });
    void refreshConfig();
  });

  chrome.runtime.onStartup?.addListener(() => {
    void refreshConfig();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'config-refresh') void refreshConfig();
  });

  async function refreshConfig(): Promise<void> {
    const loaded = await loadConfig(null, {
      onInvalidConfig: () => {
        void flushTelemetry([
          {
            event: 'config_invalid',
            profileId: 'unknown',
            configVersion: null,
            extensionVersion: api.EXTENSION_VERSION,
            at: new Date().toISOString(),
          },
        ]);
      },
    });
    configSource = loaded.source;
    configVersion = loaded.config.configVersion;
    for (const port of contentPorts.values()) {
      post(port, { type: 'requestStatus' });
    }
  }

  // ── ports ──────────────────────────────────────────────────────────────────

  function post(port: chrome.runtime.Port, msg: WorkerToContent): void {
    try {
      port.postMessage(msg);
    } catch {
      /* port closed */
    }
  }

  function toPanels(msg: WorkerToPanel): void {
    for (const port of panelPorts) {
      try {
        port.postMessage(msg);
      } catch {
        panelPorts.delete(port);
      }
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === CONTENT_PORT) {
      const tabId = port.sender?.tab?.id;
      if (tabId === undefined) return;
      contentPorts.set(tabId, port);

      port.onMessage.addListener((msg: ContentToWorker) => {
        void handleContentMessage(tabId, msg);
      });
      port.onDisconnect.addListener(() => {
        contentPorts.delete(tabId);
        contentStatus.delete(tabId);
        if (jobTabId === tabId && job) {
          // The user closed or navigated the tab we were reading.
          job.scrapeEnded('navigated_away');
        }
        void broadcastSnapshot();
      });
      return;
    }

    if (port.name === PANEL_PORT) {
      panelPorts.add(port);
      port.onMessage.addListener((msg: PanelToWorker) => {
        void handlePanelMessage(msg);
      });
      port.onDisconnect.addListener(() => panelPorts.delete(port));
      void broadcastSnapshot();
    }
  });

  async function handleContentMessage(tabId: number, msg: ContentToWorker): Promise<void> {
    switch (msg.type) {
      case 'hello':
        contentStatus.set(tabId, msg.status);
        configSource = msg.configSource;
        configVersion = msg.configVersion;
        await broadcastSnapshot();
        break;

      case 'status':
        contentStatus.set(tabId, msg.status);
        await broadcastSnapshot();
        break;

      case 'cards':
        if (job && jobState.jobId === msg.jobId) {
          await job.ingestCards(msg);
        }
        break;

      case 'scrapeEnd':
        if (job && jobState.jobId === msg.jobId) job.scrapeEnded(msg.reason);
        break;

      case 'platformWarning':
        job?.notePlatformWarning();
        break;

      case 'extractorException':
        // Counted, not stored. The field NAME is safe; the value never leaves.
        telemetry?.record('extractor_exception', { metrics: { exceptionCount: 1 } });
        break;

      case 'fixtureCaptured':
        await saveFixture(msg.html, msg.profileId);
        break;
    }
  }

  let telemetry: TelemetryBuffer | null = null;

  // ── panel messages ─────────────────────────────────────────────────────────

  async function handlePanelMessage(msg: PanelToWorker): Promise<void> {
    switch (msg.type) {
      case 'getState':
        await broadcastSnapshot();
        break;

      case 'startExport':
        await startExport(msg.request);
        break;

      case 'cancel':
        job?.cancel();
        break;

      case 'requestMagicLink':
        try {
          await api.requestMagicLink(msg.email);
          toPanels({ type: 'magicLinkSent' });
        } catch (err) {
          toPanels({ type: 'toast', level: 'error', message: errorText(err) });
        }
        break;

      case 'signOut':
        await api.signOut();
        await storage.saveCachedMe(null);
        await broadcastSnapshot();
        break;

      case 'refreshAccount':
        await refreshAccount();
        break;

      case 'saveSettings':
        await storage.saveSettings(msg.patch);
        await broadcastSnapshot();
        break;

      case 'redownload':
        await downloadLastCsv();
        break;

      case 'pushToSheets':
        await sendLastToSheets();
        break;

      case 'clearHistory':
        await storage.clearDedupeHashes();
        toPanels({ type: 'toast', level: 'success', message: 'Export history cleared.' });
        break;

      case 'captureFixture': {
        const tabId = await activeSupportedTabId();
        const port = tabId === null ? null : contentPorts.get(tabId);
        if (port) post(port, { type: 'captureFixture' });
        break;
      }
    }
  }

  // ── snapshot ───────────────────────────────────────────────────────────────

  /** The tab the panel is talking about: the active one, if it has a live script. */
  async function activeSupportedTabId(): Promise<number | null> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const id = tab?.id;
      if (id !== undefined && contentPorts.has(id)) return id;
    } catch {
      /* no host permission for this tab — fine, fall through */
    }
    // Fall back to any single live LinkedIn tab.
    const ids = [...contentPorts.keys()];
    return ids.length === 1 ? (ids[0] as number) : null;
  }

  async function currentPageStatus(): Promise<PageStatus> {
    const tabId = await activeSupportedTabId();
    if (tabId === null) return { kind: 'not_a_search_page' };
    return contentStatus.get(tabId) ?? { kind: 'not_a_search_page' };
  }

  async function buildSnapshot(): Promise<PanelSnapshot> {
    const [settings, session, account, rolling] = await Promise.all([
      storage.getSettings(),
      storage.getSession(),
      storage.getCachedMe(),
      storage.rolling24hTotal(),
    ]);
    return {
      job: jobState,
      page: await currentPageStatus(),
      settings,
      account,
      signedIn: session !== null,
      rolling24hUsed: rolling,
      configSource,
      configVersion,
      lastResult,
      extensionVersion: api.EXTENSION_VERSION,
    };
  }

  async function broadcastSnapshot(): Promise<void> {
    if (panelPorts.size === 0) return;
    toPanels({ type: 'snapshot', snapshot: await buildSnapshot() });
  }

  async function refreshAccount(): Promise<void> {
    try {
      const me = await api.getMe();
      await storage.saveCachedMe(me);
    } catch (err) {
      if (err instanceof ApiRequestError && err.isUnauthorized) {
        await api.signOut();
        await storage.saveCachedMe(null);
      }
    }
    await broadcastSnapshot();
  }

  // ── the export ─────────────────────────────────────────────────────────────

  async function startExport(request: ExportRequest): Promise<void> {
    if (job) {
      // One job at a time (docs/03 §6).
      toPanels({ type: 'toast', level: 'error', message: 'An export is already running.' });
      return;
    }

    const tabId = await activeSupportedTabId();
    const status = tabId === null ? null : contentStatus.get(tabId);
    if (tabId === null || !status || status.kind !== 'supported') {
      toPanels({ type: 'toast', level: 'error', message: 'Open a supported search page first.' });
      return;
    }

    const profileId: ProfileId = status.profileId;
    jobTabId = tabId;
    telemetry = new TelemetryBuffer({
      profileId,
      configVersion,
      extensionVersion: api.EXTENSION_VERSION,
    });

    const deps: JobDeps = {
      reserveQuota: (body) => api.reserveQuota(body),
      commitQuota: (body) => api.commitQuota(body),
      enrichBatch: (body) => api.enrichBatch(body),
      startScrape: async (jobId, rowCap, rolling24hUsed) => {
        const port = contentPorts.get(tabId);
        if (!port) throw new Error('content script went away');
        post(port, { type: 'startScrape', jobId, rowCap, rolling24hUsed });
      },
      cancelScrape: (jobId) => {
        const port = contentPorts.get(tabId);
        if (port) post(port, { type: 'cancel', jobId });
      },
      onStateChange: (state) => {
        jobState = state;
        void broadcastSnapshot();
      },
      loadDedupeHashes: () => storage.getDedupeHashes(),
      saveDedupeHashes: (hashes) => storage.saveDedupeHashes(hashes),
      rolling24hUsed: () => storage.rolling24hTotal(),
      queuePendingCommit: async (body) => {
        const pending = await storage.getPendingCommits();
        pending.push({ ...body, queuedAt: new Date().toISOString() });
        await storage.savePendingCommits(pending);
      },
      now: () => new Date(),
      newJobId: () => `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    };

    job = new ExportJob(deps, request, profileId);

    try {
      const outcome = await job.run();

      if (outcome.records.length > 0) {
        await deliverOutput(outcome.records, request, profileId, outcome.state);
        await storage.addRolling24h(outcome.records.length);
      }

      recordJobTelemetry(outcome, request);
      await storage.appendJobHistory({
        jobId: outcome.state.jobId ?? 'unknown',
        startedAt: outcome.state.startedAt ?? new Date().toISOString(),
        finishedAt: outcome.state.finishedAt ?? new Date().toISOString(),
        rows: outcome.records.length,
        enriched: outcome.records.filter((r) => r.email).length,
        skippedDuplicates: outcome.state.progress.skippedDuplicates,
        extractionRate: outcome.telemetry.extractionRate,
        profileId,
        outcome: outcomeLabel(outcome.state),
        preset: request.presetId,
      });
    } catch (err) {
      jobState = {
        ...jobState,
        phase: 'failed',
        error: { code: 'unknown', message: errorText(err) },
        finishedAt: new Date().toISOString(),
      };
    } finally {
      job = null;
      jobTabId = null;
      await flushTelemetry(telemetry?.take() ?? []);
      telemetry = null;
      await retryPendingCommits();
      await broadcastSnapshot();
    }
  }

  function outcomeLabel(state: JobState): LastResult['outcome'] {
    if (state.phase === 'cancelled') return 'cancelled';
    if (state.phase === 'failed') return 'failed';
    return state.partialReason ? 'partial' : 'done';
  }

  function recordJobTelemetry(
    outcome: Awaited<ReturnType<ExportJob['run']>>,
    request: ExportRequest,
  ): void {
    if (!telemetry) return;

    if (outcome.telemetry.degradedPages > 0) {
      telemetry.record('extraction_degraded', {
        metrics: {
          degradedPages: outcome.telemetry.degradedPages,
          pages: outcome.telemetry.pages,
          extractionRate: outcome.telemetry.extractionRate,
        },
        fieldMisses: outcome.telemetry.fieldMisses,
      });
    }

    if (outcome.state.error?.code === 'platform_warning') {
      telemetry.record('abort_platform_warning', {
        metrics: { rows: outcome.records.length, pages: outcome.telemetry.pages },
      });
    }

    telemetry.record('job_summary', {
      metrics: {
        rows: outcome.records.length,
        pages: outcome.telemetry.pages,
        durationMs: outcome.telemetry.durationMs,
        extractionRate: outcome.telemetry.extractionRate,
        enriched: outcome.records.filter((r) => r.email).length,
        skippedDuplicates: outcome.state.progress.skippedDuplicates,
        planTier: request.enrich ? 1 : 0,
      },
    });
  }

  // ── output delivery ────────────────────────────────────────────────────────

  async function deliverOutput(
    records: Awaited<ReturnType<ExportJob['run']>>['records'],
    request: ExportRequest,
    profileId: ProfileId,
    state: JobState,
  ): Promise<void> {
    const preset = await resolvePreset(request.presetId);
    const me = await storage.getCachedMe();
    const watermark = (me?.plan ?? 'free') === 'free';

    lastCsv = buildCsv(records, preset, { watermark });
    lastRowsForSheets = buildRows(records, preset, { watermark });

    let sheetUrl: string | null = null;

    if (request.destination === 'sheets') {
      try {
        sheetUrl = await sendLastToSheets();
      } catch {
        // E7: fall back to CSV in one click — the panel offers the button.
        await downloadLastCsv(profileId);
      }
    } else {
      await downloadLastCsv(profileId);
    }

    lastResult = {
      rows: records.length,
      enriched: records.filter((r) => r.email != null).length,
      verified: records.filter((r) => r.emailStatus === 'verified').length,
      skippedDuplicates: state.progress.skippedDuplicates,
      extractionRate: state.progress.extractionRate,
      outcome: outcomeLabel(state),
      presetId: request.presetId,
      destination: request.destination,
      sheetUrl,
      finishedAt: new Date().toISOString(),
    };
  }

  async function downloadLastCsv(profileId: ProfileId = 'salesnav_people_search'): Promise<void> {
    if (!lastCsv) return;
    await chrome.downloads.download({
      url: csvDataUrl(lastCsv),
      filename: csvFilename(profileId),
      saveAs: false,
    });
  }

  async function sendLastToSheets(): Promise<string | null> {
    if (!lastRowsForSheets) return null;
    const settings = await storage.getSettings();
    try {
      const result = await pushToSheets({
        rows: lastRowsForSheets,
        existingSheetId: settings.sheetId,
        title: `RecruitExport — ${new Date().toISOString().slice(0, 10)}`,
        interactive: true,
      });
      await storage.saveSettings({ sheetId: result.spreadsheetId });
      if (lastResult) lastResult = { ...lastResult, sheetUrl: result.url };
      await broadcastSnapshot();
      return result.url;
    } catch (err) {
      const message =
        err instanceof SheetsAuthError || err instanceof SheetsApiError
          ? err.message
          : 'Google Sheets push failed.';
      jobState = { ...jobState, error: { code: 'sheets_auth', message } };
      toPanels({ type: 'toast', level: 'error', message });
      await broadcastSnapshot();
      throw err;
    }
  }

  // ── pending commit reconciliation (state E3) ───────────────────────────────

  async function retryPendingCommits(): Promise<void> {
    const pending = await storage.getPendingCommits();
    if (pending.length === 0) return;
    const remaining: typeof pending = [];
    for (const commit of pending) {
      try {
        await api.commitQuota({
          jobToken: commit.jobToken,
          actualRows: commit.actualRows,
          actualEnriched: commit.actualEnriched,
        });
      } catch {
        remaining.push(commit);
      }
    }
    await storage.savePendingCommits(remaining);
  }

  // ── dev-only fixture capture (docs/03 §7) ──────────────────────────────────

  async function saveFixture(html: string, profileId: ProfileId): Promise<void> {
    if (import.meta.env.WXT_DEV_CAPTURE !== '1') return;
    // Saved with a `raw-` prefix: gitignored, and the sanitizer must run before
    // it can be committed as a fixture.
    const filename = `recruitexport-fixtures/${profileId}/raw-${new Date()
      .toISOString()
      .replace(/[:.]/g, '-')}.html`;
    const url = `data:text/html;charset=utf-8;base64,${btoa(
      String.fromCharCode(...new TextEncoder().encode(html)),
    )}`;
    await chrome.downloads.download({ url, filename, saveAs: false });
    toPanels({ type: 'fixtureCaptured', filename });
  }

  // ── misc ───────────────────────────────────────────────────────────────────

  function errorText(err: unknown): string {
    if (err instanceof ApiRequestError) return err.message;
    if (err instanceof Error) return err.message;
    return 'Something went wrong.';
  }

  /**
   * The auth handoff page (site/auth.html) posts the JWT here. Only origins in
   * `externally_connectable` can reach this listener.
   */
  chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
    void (async () => {
      const payload = message as { type?: string; token?: string; email?: string; expiresAt?: string };
      if (payload?.type !== 'auth_token' || !payload.token || !payload.email) {
        sendResponse({ ok: false });
        return;
      }
      await api.adoptToken({
        token: payload.token,
        email: payload.email,
        expiresAt: payload.expiresAt ?? new Date(Date.now() + 30 * 864e5).toISOString(),
      });
      await refreshAccount();
      sendResponse({ ok: true });
    })();
    return true; // async response
  });

  void refreshConfig();
});
