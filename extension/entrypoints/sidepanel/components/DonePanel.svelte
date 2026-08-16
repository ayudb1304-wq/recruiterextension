<script lang="ts">
  import { S } from '../../../lib/strings';
  import { store } from '../store.svelte';
  import ErrorBanner from './ErrorBanner.svelte';
  import HealthChip from './HealthChip.svelte';

  const snap = $derived(store.snapshot);
  const result = $derived(snap.lastResult);
  const job = $derived(snap.job);

  const partialText = $derived.by(() => {
    switch (job.partialReason) {
      case 'cancelled':
        return 'You stopped the export. Everything read up to that point is in your file.';
      case 'platform_warning':
        return S.e4PlatformWarning(result?.rows ?? 0);
      case 'page_cap':
        return 'Hit the 25-page-per-job limit. Run again to continue from the next page.';
      case 'navigated_away':
        return 'The search page changed mid-export, so I stopped there.';
      default:
        return null;
    }
  });

  function dismissReviewAsk(): void {
    store.send({ type: 'saveSettings', patch: { reviewAskDismissed: true } });
  }
</script>

<!-- S4 — done (docs/06 §S4) -->
<section class="panel">
  <div class="row between">
    <h1>{S.s4Title}</h1>
    {#if result}<HealthChip rate={result.extractionRate} />{/if}
  </div>

  {#if result}
    <p>{S.s4Summary(result.rows, result.skippedDuplicates)}</p>

    {#if result.enriched > 0}
      <p class="hint">{result.verified} verified · {result.enriched - result.verified} risky or unfound</p>
    {/if}

    {#if partialText}
      <div class="banner warn" role="status">
        <strong>{S.s4PartialPrefix}</strong>
        <span>{partialText}</span>
      </div>
    {/if}

    {#if job.allowanceExhausted}
      <div class="banner warn" role="status">
        Your monthly email allowance ran out partway through. Those rows are exported without emails.
      </div>
    {/if}

    <div class="row">
      <button onclick={() => store.send({ type: 'redownload' })}>{S.s4Download}</button>
      {#if result.sheetUrl}
        <a class="badge" href={result.sheetUrl} target="_blank" rel="noopener noreferrer">
          {S.s4OpenSheet}
        </a>
      {/if}
      <button class="primary" style="width:auto" onclick={() => store.send({ type: 'getState' })}>
        {S.s4RunAgain}
      </button>
    </div>

    <!-- One-time ask after a first success, dismissible forever (docs/06 §S4). -->
    {#if !snap.settings.reviewAskDismissed && result.outcome === 'done'}
      <div class="banner">
        <span>{S.reviewAsk}</span>
        <div class="row" style="margin-top:6px">
          <a
            href="https://chromewebstore.google.com/"
            target="_blank"
            rel="noopener noreferrer"
            onclick={dismissReviewAsk}>Leave a review</a
          >
          <button class="link" onclick={dismissReviewAsk}>{S.reviewAskDismiss}</button>
        </div>
      </div>
    {/if}
  {:else if job.error}
    <ErrorBanner error={job.error} rows={job.progress.rows} />
    <button class="primary" onclick={() => store.send({ type: 'getState' })}>Back</button>
  {/if}
</section>
