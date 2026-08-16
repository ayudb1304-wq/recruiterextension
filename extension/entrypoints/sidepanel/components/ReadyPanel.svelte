<script lang="ts">
  import { PLAN_LIMITS } from '@recruitexport/shared';
  import { BUNDLED_PRESETS } from '../../../lib/presets';
  import { DEFAULT_SETTINGS } from '../../../lib/storage';
  import { S } from '../../../lib/strings';
  import { store } from '../store.svelte';
  import ErrorBanner from './ErrorBanner.svelte';

  const snap = $derived(store.snapshot);
  const page = $derived(snap.page);
  const account = $derived(snap.account);
  const plan = $derived(account?.plan ?? 'free');
  const isPaid = $derived(plan !== 'free');

  const monthRemaining = $derived(
    Math.max(0, (account?.usage.monthCap ?? PLAN_LIMITS[plan].rowsPerMonth) - (account?.usage.rowsExported ?? 0)),
  );
  const dayRemaining = $derived(
    Math.max(0, (account?.usage.rolling24hCap ?? PLAN_LIMITS[plan].rowsPerRolling24h) - snap.rolling24hUsed),
  );
  const maxRows = $derived(Math.max(0, Math.min(monthRemaining, dayRemaining)));

  // Seeded from the shipped defaults so the panel paints instantly; the effect
  // below adopts the user's saved settings the moment the snapshot arrives.
  let rowCap = $state(DEFAULT_SETTINGS.defaultRowCap);
  let enrich = $state(DEFAULT_SETTINGS.enrichByDefault);
  let skipDuplicates = $state(DEFAULT_SETTINGS.skipAlreadyExported);
  let presetId = $state(DEFAULT_SETTINGS.defaultPreset);
  let destination = $state<'csv' | 'sheets'>(DEFAULT_SETTINGS.destination);

  // Re-sync the form when settings arrive from storage, but never fight the
  // user mid-edit: only adopt values while they have not touched the form.
  let touched = $state(false);
  $effect(() => {
    if (touched) return;
    rowCap = snap.settings.defaultRowCap;
    enrich = snap.settings.enrichByDefault && isPaid;
    skipDuplicates = snap.settings.skipAlreadyExported;
    presetId = snap.settings.defaultPreset;
    destination = snap.settings.destination;
  });

  const effectiveRows = $derived(Math.max(0, Math.min(rowCap, maxRows)));
  const canExport = $derived(page.kind === 'supported' && effectiveRows > 0 && snap.signedIn);

  const surfaceLabel = $derived(
    page.kind === 'supported' && page.profileId === 'recruiter_search' ? S.s2Recruiter : S.s2SalesNav,
  );

  function startExport(): void {
    store.send({
      type: 'startExport',
      request: {
        rowCap: effectiveRows,
        enrich: enrich && isPaid,
        skipDuplicates,
        presetId,
        destination,
      },
    });
  }
</script>

<!-- S2 — ready (docs/06 §S2) -->
<section class="panel">
  <div class="row between">
    <h1>{surfaceLabel}</h1>
    {#if page.kind === 'supported' && page.resultCountEstimate}
      <span class="badge">{S.s2ResultsFound(page.resultCountEstimate)}</span>
    {/if}
  </div>

  {#if page.kind === 'supported' && !page.isEnglishUi}
    <!-- E5: proceed allowed, expectations set -->
    <div class="banner warn" role="status">{S.e5NonEnglish(page.uiLanguage ?? 'another language')}</div>
  {/if}

  {#if snap.job.error && snap.job.phase === 'failed'}
    <ErrorBanner error={snap.job.error} rows={snap.job.progress.rows} />
  {/if}

  <div class="field">
    <label for="rowcap">{S.s2RowsLabel}</label>
    <input
      id="rowcap"
      type="number"
      min="1"
      max={Math.max(1, maxRows)}
      bind:value={rowCap}
      oninput={() => (touched = true)}
      aria-describedby="rowcap-hint"
    />
    <span class="hint" id="rowcap-hint">{S.s2RowsHelp(maxRows)}</span>
  </div>

  <label class="check">
    <input
      type="checkbox"
      bind:checked={enrich}
      disabled={!isPaid}
      onchange={() => (touched = true)}
      aria-describedby={isPaid ? undefined : 'enrich-lock'}
    />
    <span>
      {S.s2Enrich}
      {#if !isPaid}
        <span class="hint" id="enrich-lock">
          {S.e6EnrichLocked}
          {#if account?.checkoutUrls?.pro_monthly}
            <a href={account.checkoutUrls.pro_monthly} target="_blank" rel="noopener noreferrer">Upgrade</a>
          {/if}
        </span>
      {/if}
    </span>
  </label>

  <label class="check">
    <input type="checkbox" bind:checked={skipDuplicates} onchange={() => (touched = true)} />
    <span>{S.s2SkipDupes}</span>
  </label>

  <div class="field">
    <label for="preset">{S.s2Preset}</label>
    <select id="preset" bind:value={presetId} onchange={() => (touched = true)}>
      {#each BUNDLED_PRESETS as preset (preset.id)}
        <option value={preset.id}>{preset.label}</option>
      {/each}
    </select>
    <button class="link" type="button" onclick={() => store.go('presets')}>{S.s2EditPresets}</button>
  </div>

  <div class="field">
    <label for="destination">{S.s2Destination}</label>
    <select id="destination" bind:value={destination} onchange={() => (touched = true)}>
      <option value="csv">{S.s2DestinationCsv}</option>
      <option value="sheets">{S.s2DestinationSheets}</option>
    </select>
  </div>

  <button class="primary" onclick={startExport} disabled={!canExport}>
    {S.s2Export(effectiveRows)}
  </button>

  {#if !snap.signedIn}
    <p class="hint">{S.notSignedIn}</p>
  {/if}
</section>
