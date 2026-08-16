<script lang="ts">
  import { PLAN_LIMITS } from '@recruitexport/shared';
  import { BUNDLED_PRESETS } from '../../../lib/presets';
  import { S } from '../../../lib/strings';
  import { store } from '../store.svelte';
  import SignIn from './SignIn.svelte';
  import UsageBar from './UsageBar.svelte';

  const snap = $derived(store.snapshot);
  const account = $derived(snap.account);
  const plan = $derived(account?.plan ?? 'free');
  const limits = $derived(PLAN_LIMITS[plan]);
</script>

<!-- S5 — account & settings (docs/06 §S5) -->
<section class="panel">
  <h1>{S.accountTitle}</h1>

  {#if !snap.signedIn}
    <SignIn />
  {:else}
    <div class="row between">
      <span>{account?.email ?? '—'}</span>
      <span class="badge {plan === 'free' ? '' : 'ok'}">
        {plan === 'free' ? S.planFree : S.planPro}
      </span>
    </div>

    {#if account?.status === 'past_due'}
      <div class="banner warn" role="alert">
        Your last payment did not go through. Update your card to keep Pro features.
      </div>
    {:else if account?.status === 'cancelled' && account.periodEnd}
      <div class="banner" role="status">
        Pro ends {new Date(account.periodEnd).toLocaleDateString()}.
      </div>
    {/if}

    <UsageBar
      label="Rows this month"
      used={account?.usage.rowsExported ?? 0}
      cap={account?.usage.monthCap ?? limits.rowsPerMonth}
    />
    <UsageBar
      label="Rows in the last 24h"
      used={snap.rolling24hUsed}
      cap={account?.usage.rolling24hCap ?? limits.rowsPerRolling24h}
    />
    {#if limits.enrichedRowsPerMonth > 0}
      <UsageBar
        label="Emails found this month"
        used={account?.usage.rowsEnriched ?? 0}
        cap={account?.usage.enrichCap ?? limits.enrichedRowsPerMonth}
      />
    {/if}

    <div class="row">
      {#if plan === 'free'}
        {#if account?.checkoutUrls?.pro_monthly}
          <a class="badge" href={account.checkoutUrls.pro_monthly} target="_blank" rel="noopener noreferrer">
            {S.upgradeMonthly}
          </a>
        {/if}
        {#if account?.checkoutUrls?.pro_annual}
          <a class="badge" href={account.checkoutUrls.pro_annual} target="_blank" rel="noopener noreferrer">
            {S.upgradeAnnual}
          </a>
        {/if}
      {:else if account?.portalUrl}
        <a class="badge" href={account.portalUrl} target="_blank" rel="noopener noreferrer">
          {S.manageBilling}
        </a>
      {/if}
      <button onclick={() => store.send({ type: 'signOut' })}>{S.signOut}</button>
    </div>
  {/if}

  <hr style="border:none;border-top:1px solid var(--border);margin:2px 0" />

  <h2>{S.settingsTitle}</h2>

  <div class="field">
    <label for="default-preset">Default format</label>
    <select
      id="default-preset"
      value={snap.settings.defaultPreset}
      onchange={(e) =>
        store.send({
          type: 'saveSettings',
          patch: { defaultPreset: (e.currentTarget as HTMLSelectElement).value },
        })}
    >
      {#each BUNDLED_PRESETS as preset (preset.id)}
        <option value={preset.id}>{preset.label}</option>
      {/each}
    </select>
  </div>

  <div class="field">
    <label for="default-cap">Default row cap</label>
    <input
      id="default-cap"
      type="number"
      min="1"
      max={limits.rowsPerMonth}
      value={snap.settings.defaultRowCap}
      onchange={(e) =>
        store.send({
          type: 'saveSettings',
          patch: { defaultRowCap: Number((e.currentTarget as HTMLInputElement).value) },
        })}
    />
  </div>

  <label class="check">
    <input
      type="checkbox"
      checked={!snap.settings.telemetryOptOut}
      onchange={(e) =>
        store.send({
          type: 'saveSettings',
          patch: { telemetryOptOut: !(e.currentTarget as HTMLInputElement).checked },
        })}
    />
    <span>
      {S.telemetryToggle}
      <span class="hint">{S.telemetryHelp}</span>
    </span>
  </label>

  <div class="field">
    <button onclick={() => store.send({ type: 'clearHistory' })}>{S.clearHistory}</button>
    <span class="hint">{S.clearHistoryHelp}</span>
  </div>

  <p class="hint">{S.dataPromise}</p>
  <p class="hint">
    v{snap.extensionVersion} · selectors {snap.configVersion} ({snap.configSource}) · {S.notAffiliated}
  </p>
</section>
