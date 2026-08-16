<script lang="ts">
  import { onMount } from 'svelte';
  import { S } from '../../lib/strings';
  import { store } from './store.svelte';
  import AccountPanel from './components/AccountPanel.svelte';
  import DonePanel from './components/DonePanel.svelte';
  import PresetEditor from './components/PresetEditor.svelte';
  import ReadyPanel from './components/ReadyPanel.svelte';
  import RunningPanel from './components/RunningPanel.svelte';
  import SignIn from './components/SignIn.svelte';

  onMount(() => store.connect());

  const snap = $derived(store.snapshot);
  const phase = $derived(snap.job.phase);
  const running = $derived(
    phase === 'checking_quota' ||
      phase === 'scraping' ||
      phase === 'enriching' ||
      phase === 'building_output',
  );
  const finished = $derived(phase === 'done' || phase === 'cancelled' || phase === 'failed');
</script>

<div class="topbar">
  <strong>{S.appName}</strong>
  <div class="row">
    {#if store.screen !== 'main'}
      <button class="link" onclick={() => store.go('main')}>Back</button>
    {/if}
    <button
      class="link"
      onclick={() => store.go(store.screen === 'account' ? 'main' : 'account')}
      aria-label={S.accountTitle}
    >
      {snap.account?.plan && snap.account.plan !== 'free' ? S.planPro : S.planFree}
    </button>
  </div>
</div>

{#if store.screen === 'presets'}
  <PresetEditor />
{:else if store.screen === 'account'}
  <AccountPanel />
{:else if store.hydrating}
  <!-- Skeletons, not spinners: the panel must paint immediately (docs/06 §4). -->
  <section class="panel" aria-busy="true">
    <div class="skeleton" style="width:60%"></div>
    <div class="skeleton" style="width:90%"></div>
    <div class="skeleton" style="width:75%"></div>
    <span class="sr-only">Loading</span>
  </section>
{:else if running}
  <RunningPanel />
{:else if finished && snap.lastResult}
  <DonePanel />
{:else if !snap.signedIn}
  <section class="panel">
    <h1>{S.s1Title}</h1>
    <p class="hint">{S.s1Body}</p>
    <SignIn />
  </section>
{:else if snap.page.kind === 'supported'}
  <ReadyPanel />
{:else if snap.page.kind === 'unsupported_layout'}
  <section class="panel">
    <h1>Unrecognised layout</h1>
    <div class="banner danger" role="alert">{S.unsupportedLayout}</div>
  </section>
{:else}
  <!-- S1 — not on a supported page (docs/06 §S1) -->
  <section class="panel">
    <h1>{S.s1Title}</h1>
    <p>{S.s1Body}</p>
    <p><a href="https://www.loom.com/" target="_blank" rel="noopener noreferrer">{S.s1Demo}</a></p>
    {#if snap.job.phase === 'failed' && snap.job.error}
      <p class="hint">Last export ended with: {snap.job.error.message}</p>
    {/if}
  </section>
{/if}

{#if store.toast}
  <div class="toast {store.toast.level}" role="status">{store.toast.message}</div>
{/if}

<footer class="footer">{S.safeModeFooter}</footer>
