<script lang="ts">
  import { S } from '../../../lib/strings';
  import { store } from '../store.svelte';
  import HealthChip from './HealthChip.svelte';

  const job = $derived(store.snapshot.job);
  const p = $derived(job.progress);
</script>

<!-- S3 — running (docs/06 §S3) -->
<section class="panel" aria-live="polite">
  <div class="row between">
    <h1>Exporting…</h1>
    <HealthChip rate={p.extractionRate} />
  </div>

  <p>{S.s3Progress(p.page, p.pagesTotal, p.rows, p.enriched)}</p>

  {#if p.skippedDuplicates > 0}
    <p class="hint">{p.skippedDuplicates} already-exported candidates skipped.</p>
  {/if}

  {#if job.phase === 'enriching'}
    <p class="hint">Finding and verifying emails…</p>
  {:else if job.phase === 'building_output'}
    <p class="hint">Building your file…</p>
  {:else if job.phase === 'checking_quota'}
    <p class="hint">Checking your remaining rows…</p>
  {/if}

  {#if job.allowanceExhausted}
    <div class="banner warn" role="status">
      Email allowance ran out partway through — the rest of the rows are exported without emails.
    </div>
  {/if}

  <button onclick={() => store.send({ type: 'cancel' })}>{S.s3Cancel}</button>

  <p class="hint">{S.safeModeExplainer}</p>
</section>
