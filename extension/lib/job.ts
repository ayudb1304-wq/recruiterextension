/**
 * Export job state machine (docs/02 §2.2):
 *
 *   idle → checking_quota → scraping → enriching → building_output
 *                                        → done | failed | cancelled
 *
 * Owned by the service worker. Rows live in memory for the life of the job and
 * are never persisted (docs/04 §5) — only dedupe HASHES survive, and only
 * locally.
 *
 * Dependencies are injected so the whole flow is testable without Chrome.
 */

import {
  ENRICH_BATCH_MAX,
  EXTRACTION_DEGRADED_THRESHOLD,
  type CandidateRecord,
  type EnrichBody,
  type EnrichResponse,
  type ExtractedCard,
  type ProfileId,
  type QuotaCommitBody,
  type QuotaCommitResponse,
  type QuotaReserveBody,
  type QuotaReserveResponse,
} from '@recruitexport/shared';
import { buildCandidateRecord } from './extraction/record';
import { HashRingBuffer } from './extraction/dedupe';
import {
  IDLE_JOB,
  type ExportRequest,
  type JobError,
  type JobState,
  type ScrapeEndReason,
} from './messages';

export interface JobDeps {
  reserveQuota(body: QuotaReserveBody): Promise<QuotaReserveResponse>;
  commitQuota(body: QuotaCommitBody): Promise<QuotaCommitResponse>;
  enrichBatch(body: EnrichBody): Promise<EnrichResponse>;
  /** Tell the content script to begin. Resolves once the message is delivered. */
  startScrape(jobId: string, rowCap: number, rolling24hUsed: number): Promise<void>;
  cancelScrape(jobId: string): void;
  onStateChange(state: JobState): void;
  loadDedupeHashes(): Promise<string[]>;
  saveDedupeHashes(hashes: readonly string[]): Promise<void>;
  /** Client mirror of the rolling-24h counter. */
  rolling24hUsed(): Promise<number>;
  queuePendingCommit(body: QuotaCommitBody): Promise<void>;
  now(): Date;
  newJobId(): string;
}

export interface JobOutcome {
  state: JobState;
  records: CandidateRecord[];
  /** Set when a reservation was made — needed to reconcile usage. */
  jobToken: string | null;
  telemetry: {
    pages: number;
    degradedPages: number;
    extractionRate: number;
    fieldMisses: Record<string, number>;
    durationMs: number;
  };
}

const DEDUPE_CAPACITY = 25_000;

export class ExportJob {
  private state: JobState = { ...IDLE_JOB };
  private readonly rows: CandidateRecord[] = [];
  private readonly seenThisJob = new Set<string>();
  private history: HashRingBuffer | null = null;
  private jobToken: string | null = null;
  private allowedRows = 0;
  private enrichAllowed = false;
  private cancelled = false;

  private pages = 0;
  private degradedPages = 0;
  private rateSum = 0;
  private readonly fieldMisses: Record<string, number> = {};
  private startedAtMs = 0;

  private scrapeDone: ((reason: ScrapeEndReason) => void) | null = null;
  private scrapePromise: Promise<ScrapeEndReason> | null = null;
  private platformWarned = false;

  constructor(
    private readonly deps: JobDeps,
    private readonly request: ExportRequest,
    private readonly profileId: ProfileId,
  ) {}

  get current(): JobState {
    return this.state;
  }

  private patch(patch: Partial<JobState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onStateChange(this.state);
  }

  private fail(error: JobError): void {
    this.patch({
      phase: 'failed',
      error,
      finishedAt: this.deps.now().toISOString(),
    });
  }

  // ── the run ────────────────────────────────────────────────────────────────

  async run(): Promise<JobOutcome> {
    const jobId = this.deps.newJobId();
    this.startedAtMs = this.deps.now().getTime();
    this.patch({
      jobId,
      phase: 'checking_quota',
      startedAt: this.deps.now().toISOString(),
      error: null,
      partialReason: null,
      finishedAt: null,
      allowanceExhausted: false,
      progress: { ...IDLE_JOB.progress },
    });

    // ── 1. reserve ───────────────────────────────────────────────────────────
    let offline = false;
    try {
      const reservation = await this.deps.reserveQuota({
        estimatedRows: this.request.rowCap,
        enrich: this.request.enrich,
      });
      this.jobToken = reservation.jobToken;
      this.allowedRows = reservation.allowedRows;
      this.enrichAllowed = reservation.enrichAllowed && this.request.enrich;
    } catch (err) {
      const mapped = mapReserveError(err);
      if (mapped.code !== 'offline') {
        this.fail(mapped);
        return this.outcome();
      }
      // E3 (docs/06 §2): backend unreachable. Plain CSV export continues within
      // the cached mirror; enrichment fails CLOSED. Commit is queued for later.
      offline = true;
      this.allowedRows = Math.min(
        this.request.rowCap,
        Math.max(0, 1000 - (await this.deps.rolling24hUsed())),
      );
      this.enrichAllowed = false;
      this.patch({ error: { code: 'offline', message: 'offline_degraded' } });
    }

    if (this.allowedRows <= 0) {
      this.fail({ code: 'quota_exhausted', message: 'No rows remaining.' });
      return this.outcome();
    }

    // ── 2. scrape ────────────────────────────────────────────────────────────
    this.history = new HashRingBuffer(DEDUPE_CAPACITY, await this.deps.loadDedupeHashes());
    this.patch({ phase: 'scraping' });

    this.scrapePromise = new Promise<ScrapeEndReason>((resolve) => {
      this.scrapeDone = resolve;
    });

    await this.deps.startScrape(jobId, this.allowedRows, await this.deps.rolling24hUsed());
    const reason = await this.scrapePromise;

    if (reason === 'platform_warning') {
      this.patch({
        partialReason: 'platform_warning',
        error: { code: 'platform_warning', message: 'aborted_platform_warning' },
      });
    } else if (reason === 'cancelled') {
      this.patch({ partialReason: 'cancelled' });
    } else if (reason === 'page_cap') {
      this.patch({ partialReason: 'page_cap' });
    } else if (reason === 'navigated_away') {
      this.patch({ partialReason: 'navigated_away' });
    } else if (reason === 'error' && this.rows.length === 0) {
      this.fail({ code: 'unsupported_layout', message: 'No results could be read.' });
      return this.outcome();
    }

    if (this.rows.length === 0) {
      this.fail({ code: 'no_results', message: 'No candidates were extracted.' });
      return this.outcome();
    }

    // ── 3. enrich ────────────────────────────────────────────────────────────
    if (this.enrichAllowed && !this.cancelled) {
      this.patch({ phase: 'enriching' });
      await this.enrichAll();
    } else {
      for (const row of this.rows) row.emailStatus = 'skipped';
    }

    // ── 4. build output (caller writes the file) ─────────────────────────────
    this.patch({ phase: 'building_output' });

    // ── 5. commit ────────────────────────────────────────────────────────────
    const enrichedCount = this.rows.filter(
      (r) => r.emailStatus === 'verified' || r.emailStatus === 'risky',
    ).length;

    if (this.jobToken) {
      const body: QuotaCommitBody = {
        jobToken: this.jobToken,
        actualRows: this.rows.length,
        actualEnriched: enrichedCount,
      };
      try {
        await this.deps.commitQuota(body);
      } catch {
        // Never lose usage: queue and reconcile on the next successful call.
        await this.deps.queuePendingCommit(body);
      }
    } else if (offline) {
      // No token to reconcile against; the server counts what it sees later.
    }

    await this.persistHashes();

    this.patch({
      phase: this.cancelled ? 'cancelled' : 'done',
      finishedAt: this.deps.now().toISOString(),
    });
    return this.outcome();
  }

  // ── content-script events ──────────────────────────────────────────────────

  /** Called for each page the content script streams up. */
  async ingestCards(payload: {
    cards: ExtractedCard[];
    pageNumber: number;
    extractionRate: number;
    fieldMisses: Record<string, number>;
    cardsFound: number;
  }): Promise<void> {
    this.pages += 1;
    this.rateSum += payload.extractionRate;
    if (payload.extractionRate < EXTRACTION_DEGRADED_THRESHOLD) this.degradedPages += 1;
    for (const [field, count] of Object.entries(payload.fieldMisses)) {
      this.fieldMisses[field] = (this.fieldMisses[field] ?? 0) + count;
    }

    let skipped = 0;
    for (const card of payload.cards) {
      if (this.rows.length >= this.allowedRows) break;
      const record = await buildCandidateRecord(card);

      // Within-job dedupe always; cross-job only when the user asked for it.
      if (this.seenThisJob.has(record.dedupeHash)) {
        skipped += 1;
        continue;
      }
      if (this.request.skipDuplicates && this.history?.has(record.dedupeHash)) {
        skipped += 1;
        continue;
      }

      this.seenThisJob.add(record.dedupeHash);
      this.rows.push(record);
    }

    this.patch({
      progress: {
        page: payload.pageNumber,
        pagesTotal: this.state.progress.pagesTotal,
        rows: this.rows.length,
        enriched: this.state.progress.enriched,
        skippedDuplicates: this.state.progress.skippedDuplicates + skipped,
        extractionRate: this.pages ? this.rateSum / this.pages : 1,
      },
    });
  }

  scrapeEnded(reason: ScrapeEndReason): void {
    this.scrapeDone?.(reason);
    this.scrapeDone = null;
  }

  notePlatformWarning(): void {
    this.platformWarned = true;
  }

  cancel(): void {
    this.cancelled = true;
    if (this.state.jobId) this.deps.cancelScrape(this.state.jobId);
    this.scrapeDone?.('cancelled');
    this.scrapeDone = null;
  }

  // ── enrichment (docs/05 §5) ────────────────────────────────────────────────

  private async enrichAll(): Promise<void> {
    if (!this.jobToken) return;

    // Only rows we can plausibly resolve are worth a credit.
    const candidates = this.rows
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => record.lastName && (record.currentCompany || record.companyDomainGuess));

    // Default every row to "skipped"; successful lookups overwrite it below, so
    // a row we never asked about is honestly reported rather than left blank.
    for (const record of this.rows) {
      if (record.emailStatus == null) record.emailStatus = 'skipped';
    }

    let exhausted = false;

    for (let i = 0; i < candidates.length; i += ENRICH_BATCH_MAX) {
      if (this.cancelled || exhausted) break;
      const slice = candidates.slice(i, i + ENRICH_BATCH_MAX);

      let response: EnrichResponse;
      try {
        response = await this.deps.enrichBatch({
          jobToken: this.jobToken,
          batch: slice.map(({ record, index }) => ({
            rowId: String(index),
            firstName: record.firstName,
            lastName: record.lastName,
            companyName: record.currentCompany,
            companyDomainGuess: record.companyDomainGuess,
          })),
        });
      } catch {
        // A provider or network failure must never fail the job (docs/05 §5).
        break;
      }

      for (const result of response.results) {
        const index = Number.parseInt(result.rowId, 10);
        const record = this.rows[index];
        if (!record) continue;
        record.email = result.email;
        record.emailStatus = result.emailStatus;
        if (result.companyDomain) record.companyDomainGuess = result.companyDomain;
      }

      if (response.allowanceExhausted) {
        exhausted = true;
        this.patch({ allowanceExhausted: true });
      }

      this.patch({
        progress: {
          ...this.state.progress,
          enriched: this.rows.filter((r) => r.email != null).length,
        },
      });
    }
  }

  // ── finishing up ───────────────────────────────────────────────────────────

  private async persistHashes(): Promise<void> {
    if (!this.history) return;
    for (const record of this.rows) this.history.add(record.dedupeHash);
    await this.deps.saveDedupeHashes(this.history.toArray());
  }

  private outcome(): JobOutcome {
    return {
      state: this.state,
      records: this.rows,
      jobToken: this.jobToken,
      telemetry: {
        pages: this.pages,
        degradedPages: this.degradedPages,
        extractionRate: this.pages ? this.rateSum / this.pages : 0,
        fieldMisses: this.fieldMisses,
        durationMs: this.deps.now().getTime() - this.startedAtMs,
      },
    };
  }

  get sawPlatformWarning(): boolean {
    return this.platformWarned;
  }
}

/** Backend errors → the E-states in docs/06 §2. */
function mapReserveError(err: unknown): JobError {
  const e = err as {
    status?: number;
    code?: string;
    message?: string;
    extra?: Record<string, unknown>;
  };
  const code = e?.code ?? 'unknown';

  if (code === 'offline' || e?.status === 0) {
    return { code: 'offline', message: 'Could not reach the server.' };
  }
  if (code === 'plan_required') {
    return {
      code: 'plan_required',
      message: e.message ?? 'Verified emails are on Pro.',
      extra: e.extra,
    };
  }
  if (code === 'rolling_limit' || e?.status === 429) {
    return {
      code: 'rolling_limit',
      message: e.message ?? 'Account-safe limit reached.',
      extra: e.extra,
    };
  }
  if (code === 'quota_exhausted') {
    return { code: 'quota_exhausted', message: e.message ?? 'Monthly quota used up.', extra: e.extra };
  }
  if (e?.status === 401 || code === 'not_signed_in') {
    return { code: 'not_signed_in', message: 'Sign in to export.' };
  }
  return { code: 'unknown', message: e?.message ?? 'Something went wrong.' };
}
