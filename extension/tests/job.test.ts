import { describe, expect, it, vi } from 'vitest';
import type {
  EnrichResponse,
  ExtractedCard,
  FieldName,
  FieldResult,
  QuotaCommitBody,
  QuotaReserveResponse,
} from '@recruitexport/shared';
import { FIELD_NAMES } from '@recruitexport/shared';
import { ExportJob, type JobDeps } from '../lib/job';
import type { ExportRequest, JobState } from '../lib/messages';

// ── fixtures ─────────────────────────────────────────────────────────────────

function hit(value: string): FieldResult {
  return { value, confidence: 'high', strategyTier: 1 };
}

function card(name: string, company: string, slug: string, index = 0): ExtractedCard {
  const fields = {} as Record<FieldName, FieldResult>;
  for (const f of FIELD_NAMES) fields[f] = { value: null, confidence: 'low', strategyTier: null };
  fields.fullName = hit(name);
  fields.currentCompany = hit(company);
  fields.profileUrl = hit(`https://www.linkedin.com/in/${slug}`);
  fields.headline = hit(`Engineer at ${company}`);
  return {
    fields,
    cardIndex: index,
    pageNumber: 1,
    extractedAt: '2026-08-16T10:00:00.000Z',
    profileId: 'salesnav_people_search',
    configVersion: 'test',
  };
}

const request: ExportRequest = {
  rowCap: 100,
  enrich: false,
  skipDuplicates: true,
  presetId: 'generic',
  destination: 'csv',
};

interface Harness {
  deps: JobDeps;
  states: JobState[];
  commits: QuotaCommitBody[];
  queuedCommits: QuotaCommitBody[];
  savedHashes: string[][];
  enrichCalls: number;
  scrapeStarted: { jobId: string; rowCap: number }[];
}

function harness(overrides: Partial<JobDeps> = {}, storedHashes: string[] = []): Harness {
  const states: JobState[] = [];
  const commits: QuotaCommitBody[] = [];
  const queuedCommits: QuotaCommitBody[] = [];
  const savedHashes: string[][] = [];
  const scrapeStarted: { jobId: string; rowCap: number }[] = [];
  const h = { enrichCalls: 0 };

  const deps: JobDeps = {
    reserveQuota: async (): Promise<QuotaReserveResponse> => ({
      jobToken: 'jt_test',
      allowedRows: 100,
      enrichAllowed: true,
      expiresAt: '2026-08-16T14:00:00.000Z',
    }),
    commitQuota: async (body) => {
      commits.push(body);
      return {
        ok: true,
        usage: {
          rowsExported: body.actualRows,
          rowsEnriched: body.actualEnriched,
          monthCap: 2000,
          enrichCap: 2000,
          rolling24h: body.actualRows,
          rolling24hCap: 1000,
        },
      };
    },
    enrichBatch: async (): Promise<EnrichResponse> => {
      h.enrichCalls += 1;
      return { results: [], allowanceExhausted: false };
    },
    startScrape: async (jobId, rowCap) => {
      scrapeStarted.push({ jobId, rowCap });
    },
    cancelScrape: () => {},
    onStateChange: (state) => states.push(state),
    loadDedupeHashes: async () => storedHashes,
    saveDedupeHashes: async (hashes) => {
      savedHashes.push([...hashes]);
    },
    rolling24hUsed: async () => 0,
    queuePendingCommit: async (body) => {
      queuedCommits.push(body);
    },
    now: () => new Date('2026-08-16T12:00:00.000Z'),
    newJobId: () => 'job_test',
    ...overrides,
  };

  return {
    deps,
    states,
    commits,
    queuedCommits,
    savedHashes,
    scrapeStarted,
    get enrichCalls() {
      return h.enrichCalls;
    },
  } as Harness;
}

async function runWith(
  h: Harness,
  req: ExportRequest,
  drive: (job: ExportJob) => Promise<void>,
): Promise<Awaited<ReturnType<ExportJob['run']>>> {
  const job = new ExportJob(h.deps, req, 'salesnav_people_search');
  const promise = job.run();
  // Let run() reach the scraping phase before feeding it cards.
  await vi.waitFor(() => expect(h.scrapeStarted.length).toBe(1));
  await drive(job);
  return promise;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('ExportJob — happy path', () => {
  it('walks idle → checking_quota → scraping → building_output → done', async () => {
    const h = harness();
    const outcome = await runWith(h, request, async (job) => {
      await job.ingestCards({
        cards: [card('Jane Doe', 'Acme', 'jane'), card('Wei Chen', 'Globex', 'wei', 1)],
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 2,
      });
      job.scrapeEnded('no_more_pages');
    });

    expect(outcome.state.phase).toBe('done');
    expect(outcome.records).toHaveLength(2);
    expect(h.states.map((s) => s.phase)).toEqual(
      expect.arrayContaining(['checking_quota', 'scraping', 'building_output', 'done']),
    );
  });

  it('commits the actual row count, not the reservation', async () => {
    const h = harness();
    await runWith(h, request, async (job) => {
      await job.ingestCards({
        cards: [card('Jane Doe', 'Acme', 'jane')],
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 1,
      });
      job.scrapeEnded('no_more_pages');
    });
    expect(h.commits).toEqual([{ jobToken: 'jt_test', actualRows: 1, actualEnriched: 0 }]);
  });

  it('builds full CandidateRecords with derived fields', async () => {
    const h = harness();
    const outcome = await runWith(h, request, async (job) => {
      await job.ingestCards({
        cards: [card('Jane Doe', 'Acme GmbH', 'jane')],
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 1,
      });
      job.scrapeEnded('no_more_pages');
    });
    const record = outcome.records[0]!;
    expect(record.firstName).toBe('Jane');
    expect(record.companyDomainGuess).toBe('acme.com');
    expect(record.dedupeHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('ExportJob — dedupe (docs/04 §3)', () => {
  it('drops duplicates within the same job even when the toggle is off', async () => {
    const h = harness();
    const outcome = await runWith(h, { ...request, skipDuplicates: false }, async (job) => {
      await job.ingestCards({
        cards: [card('Jane Doe', 'Acme', 'jane'), card('Jane Doe', 'Acme', 'jane', 1)],
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 2,
      });
      job.scrapeEnded('no_more_pages');
    });
    expect(outcome.records).toHaveLength(1);
    expect(outcome.state.progress.skippedDuplicates).toBe(1);
  });

  it('skips previously exported candidates when the toggle is on', async () => {
    // sha256 of 'https://www.linkedin.com/in/jane'
    const { computeDedupeHash } = await import('../lib/extraction/dedupe');
    const known = await computeDedupeHash({
      profileUrl: 'https://www.linkedin.com/in/jane',
      fullName: 'Jane Doe',
      currentCompany: 'Acme',
      fallbackSeed: 'x',
    });

    const h = harness({}, [known]);
    const outcome = await runWith(h, request, async (job) => {
      await job.ingestCards({
        cards: [card('Jane Doe', 'Acme', 'jane'), card('Wei Chen', 'Globex', 'wei', 1)],
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 2,
      });
      job.scrapeEnded('no_more_pages');
    });
    expect(outcome.records).toHaveLength(1);
    expect(outcome.records[0]!.fullName).toBe('Wei Chen');
  });

  it('keeps previously exported candidates when the toggle is off', async () => {
    const { computeDedupeHash } = await import('../lib/extraction/dedupe');
    const known = await computeDedupeHash({
      profileUrl: 'https://www.linkedin.com/in/jane',
      fullName: 'Jane Doe',
      currentCompany: 'Acme',
      fallbackSeed: 'x',
    });
    const h = harness({}, [known]);
    const outcome = await runWith(h, { ...request, skipDuplicates: false }, async (job) => {
      await job.ingestCards({
        cards: [card('Jane Doe', 'Acme', 'jane')],
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 1,
      });
      job.scrapeEnded('no_more_pages');
    });
    expect(outcome.records).toHaveLength(1);
  });

  it('persists only hashes, never candidate data', async () => {
    const h = harness();
    await runWith(h, request, async (job) => {
      await job.ingestCards({
        cards: [card('Jane Doe', 'Acme', 'jane')],
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 1,
      });
      job.scrapeEnded('no_more_pages');
    });
    const saved = h.savedHashes.at(-1)!;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(saved)).not.toContain('Jane');
  });
});

describe('ExportJob — caps and partial outcomes', () => {
  it('never exceeds the granted row allowance', async () => {
    const h = harness({
      reserveQuota: async () => ({
        jobToken: 'jt_test',
        allowedRows: 2,
        enrichAllowed: false,
        expiresAt: '',
      }),
    });
    const outcome = await runWith(h, request, async (job) => {
      await job.ingestCards({
        cards: [
          card('A A', 'X', 'a'),
          card('B B', 'X', 'b', 1),
          card('C C', 'X', 'c', 2),
          card('D D', 'X', 'd', 3),
        ],
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 4,
      });
      job.scrapeEnded('reached_cap');
    });
    expect(outcome.records).toHaveLength(2);
    expect(h.scrapeStarted[0]!.rowCap).toBe(2);
  });

  it('keeps rows already extracted when a platform warning aborts the job (E4)', async () => {
    const h = harness();
    const outcome = await runWith(h, request, async (job) => {
      await job.ingestCards({
        cards: [card('Jane Doe', 'Acme', 'jane')],
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 1,
      });
      job.notePlatformWarning();
      job.scrapeEnded('platform_warning');
    });
    expect(outcome.records).toHaveLength(1);
    expect(outcome.state.partialReason).toBe('platform_warning');
    expect(outcome.state.error?.code).toBe('platform_warning');
    // Still committed — the user consumed that quota.
    expect(h.commits[0]!.actualRows).toBe(1);
  });

  it('keeps rows on cancel and marks the job cancelled', async () => {
    const h = harness();
    const outcome = await runWith(h, request, async (job) => {
      await job.ingestCards({
        cards: [card('Jane Doe', 'Acme', 'jane')],
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 1,
      });
      job.cancel();
    });
    expect(outcome.records).toHaveLength(1);
    expect(outcome.state.phase).toBe('cancelled');
  });

  it('fails cleanly when nothing was extracted', async () => {
    const h = harness();
    const outcome = await runWith(h, request, async (job) => {
      job.scrapeEnded('no_more_pages');
    });
    expect(outcome.state.phase).toBe('failed');
    expect(outcome.state.error?.code).toBe('no_results');
    expect(h.commits).toHaveLength(0);
  });
});

describe('ExportJob — quota errors map to UI states (docs/06 §2)', () => {
  it('surfaces plan_required with its checkout URL (E6)', async () => {
    const h = harness({
      reserveQuota: async () => {
        throw { status: 402, code: 'plan_required', message: 'Pro required', extra: { checkoutUrl: 'https://x' } };
      },
    });
    const job = new ExportJob(h.deps, { ...request, enrich: true }, 'salesnav_people_search');
    const outcome = await job.run();
    expect(outcome.state.phase).toBe('failed');
    expect(outcome.state.error?.code).toBe('plan_required');
    expect(outcome.state.error?.extra?.checkoutUrl).toBe('https://x');
  });

  it('surfaces the rolling-24h ceiling (E2)', async () => {
    const h = harness({
      reserveQuota: async () => {
        throw { status: 429, code: 'rolling_limit', message: 'later' };
      },
    });
    const outcome = await new ExportJob(h.deps, request, 'salesnav_people_search').run();
    expect(outcome.state.error?.code).toBe('rolling_limit');
  });

  it('surfaces monthly exhaustion (E1)', async () => {
    const h = harness({
      reserveQuota: async () => {
        throw { status: 402, code: 'quota_exhausted', message: 'used up' };
      },
    });
    const outcome = await new ExportJob(h.deps, request, 'salesnav_people_search').run();
    expect(outcome.state.error?.code).toBe('quota_exhausted');
  });
});

describe('ExportJob — offline degradation (E3)', () => {
  it('still exports a plain CSV but fails enrichment closed', async () => {
    const h = harness({
      reserveQuota: async () => {
        throw { status: 0, code: 'offline', message: 'offline' };
      },
      rolling24hUsed: async () => 0,
    });
    const outcome = await runWith(h, { ...request, enrich: true }, async (job) => {
      await job.ingestCards({
        cards: [card('Jane Doe', 'Acme', 'jane')],
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 1,
      });
      job.scrapeEnded('no_more_pages');
    });

    expect(outcome.records).toHaveLength(1);
    expect(outcome.state.phase).toBe('done');
    expect(h.enrichCalls).toBe(0);
    expect(outcome.records[0]!.email).toBeNull();
    expect(outcome.records[0]!.emailStatus).toBe('skipped');
  });

  it('caps an offline export by the client-side rolling mirror', async () => {
    const h = harness({
      reserveQuota: async () => {
        throw { status: 0, code: 'offline', message: 'offline' };
      },
      rolling24hUsed: async () => 995,
    });
    await runWith(h, request, async (job) => {
      job.scrapeEnded('no_more_pages');
    });
    expect(h.scrapeStarted[0]!.rowCap).toBe(5);
  });

  it('queues the commit when the backend is down at the end of a job', async () => {
    const h = harness({
      commitQuota: async () => {
        throw { status: 0, code: 'offline', message: 'offline' };
      },
    });
    await runWith(h, request, async (job) => {
      await job.ingestCards({
        cards: [card('Jane Doe', 'Acme', 'jane')],
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 1,
      });
      job.scrapeEnded('no_more_pages');
    });
    expect(h.queuedCommits).toEqual([
      { jobToken: 'jt_test', actualRows: 1, actualEnriched: 0 },
    ]);
  });
});

describe('ExportJob — enrichment (docs/05 §5)', () => {
  it('batches at 25 rows per request', async () => {
    const seen: number[] = [];
    const h = harness({
      enrichBatch: async (body) => {
        seen.push(body.batch.length);
        return { results: [], allowanceExhausted: false };
      },
    });
    const cards = Array.from({ length: 60 }, (_, i) => card(`P${i} L${i}`, 'Acme', `p${i}`, i));
    await runWith(h, { ...request, enrich: true }, async (job) => {
      await job.ingestCards({
        cards,
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 60,
      });
      job.scrapeEnded('no_more_pages');
    });
    expect(seen).toEqual([25, 25, 10]);
  });

  it('writes results back onto the right rows', async () => {
    const h = harness({
      enrichBatch: async (body) => ({
        results: body.batch.map((row) => ({
          rowId: row.rowId,
          email: `${row.firstName?.toLowerCase()}@acme.com`,
          emailStatus: 'verified' as const,
          companyDomain: 'acme.com',
        })),
        allowanceExhausted: false,
      }),
    });
    const outcome = await runWith(h, { ...request, enrich: true }, async (job) => {
      await job.ingestCards({
        cards: [card('Jane Doe', 'Acme', 'jane'), card('Wei Chen', 'Acme', 'wei', 1)],
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 2,
      });
      job.scrapeEnded('no_more_pages');
    });
    expect(outcome.records[0]!.email).toBe('jane@acme.com');
    expect(outcome.records[1]!.email).toBe('wei@acme.com');
    expect(outcome.records.every((r) => r.emailStatus === 'verified')).toBe(true);
  });

  it('stops requesting once the allowance is exhausted and flags the job', async () => {
    let calls = 0;
    const h = harness({
      enrichBatch: async (body) => {
        calls += 1;
        return {
          results: body.batch.map((row) => ({
            rowId: row.rowId,
            email: null,
            emailStatus: 'skipped' as const,
            companyDomain: null,
          })),
          allowanceExhausted: true,
        };
      },
    });
    const cards = Array.from({ length: 60 }, (_, i) => card(`P${i} L${i}`, 'Acme', `p${i}`, i));
    const outcome = await runWith(h, { ...request, enrich: true }, async (job) => {
      await job.ingestCards({
        cards,
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 60,
      });
      job.scrapeEnded('no_more_pages');
    });
    expect(calls).toBe(1);
    expect(outcome.state.allowanceExhausted).toBe(true);
    expect(outcome.state.phase).toBe('done');
  });

  it('never fails the job when the provider errors', async () => {
    const h = harness({
      enrichBatch: async () => {
        throw new Error('provider exploded');
      },
    });
    const outcome = await runWith(h, { ...request, enrich: true }, async (job) => {
      await job.ingestCards({
        cards: [card('Jane Doe', 'Acme', 'jane')],
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 1,
      });
      job.scrapeEnded('no_more_pages');
    });
    expect(outcome.state.phase).toBe('done');
    expect(outcome.records).toHaveLength(1);
  });

  it('marks every row skipped when enrichment was not requested', async () => {
    const h = harness();
    const outcome = await runWith(h, request, async (job) => {
      await job.ingestCards({
        cards: [card('Jane Doe', 'Acme', 'jane')],
        pageNumber: 1,
        extractionRate: 1,
        fieldMisses: {},
        cardsFound: 1,
      });
      job.scrapeEnded('no_more_pages');
    });
    expect(outcome.records[0]!.emailStatus).toBe('skipped');
    expect(h.enrichCalls).toBe(0);
  });
});

describe('ExportJob — telemetry payloads carry no PII (docs/03 §9)', () => {
  it('reports rates, counts and field names only', async () => {
    const h = harness();
    const outcome = await runWith(h, request, async (job) => {
      await job.ingestCards({
        cards: [card('Jane Doe', 'Acme', 'jane')],
        pageNumber: 1,
        extractionRate: 0.5,
        fieldMisses: { location: 1 },
        cardsFound: 1,
      });
      job.scrapeEnded('no_more_pages');
    });
    const serialized = JSON.stringify(outcome.telemetry);
    expect(serialized).not.toContain('Jane');
    expect(serialized).not.toContain('linkedin.com');
    expect(outcome.telemetry.degradedPages).toBe(1);
    expect(outcome.telemetry.fieldMisses).toEqual({ location: 1 });
  });
});
