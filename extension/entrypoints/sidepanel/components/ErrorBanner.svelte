<script lang="ts">
  import type { JobError } from '../../../lib/messages';
  import { S } from '../../../lib/strings';
  import { store } from '../store.svelte';

  let { error, rows = 0 }: { error: JobError; rows?: number } = $props();

  const account = $derived(store.snapshot.account);

  /** E1–E7 from docs/06 §2, each with the specific reason and what to do next. */
  const view = $derived.by(() => {
    switch (error.code) {
      case 'quota_exhausted':
        return {
          tone: 'warn',
          title: 'Monthly limit reached',
          body: S.e1QuotaMonth(
            account?.usage.monthCap ?? 50,
            account?.periodEnd ? new Date(account.periodEnd).toLocaleDateString() : 'next month',
          ),
          action: account?.plan === 'free' ? { label: S.upgradeMonthly, url: account?.checkoutUrls?.pro_monthly } : null,
        };
      case 'rolling_limit':
        return {
          tone: 'warn',
          title: 'Account-safe limit reached',
          body: S.e2Rolling(
            typeof error.extra?.retryAfter === 'string'
              ? new Date(error.extra.retryAfter).toLocaleTimeString()
              : 'tomorrow',
          ),
          action: null,
        };
      case 'offline':
        return { tone: 'warn', title: 'Working offline', body: S.e3Offline, action: null };
      case 'platform_warning':
        return {
          tone: 'danger',
          title: 'Stopped to protect your account',
          body: `${S.e4PlatformWarning(rows)} ${S.e4NoRetry}`,
          action: null,
        };
      case 'plan_required':
        return {
          tone: 'warn',
          title: 'Pro feature',
          body: S.e6EnrichLocked,
          action: {
            label: S.upgradeMonthly,
            url:
              typeof error.extra?.checkoutUrl === 'string'
                ? error.extra.checkoutUrl
                : account?.checkoutUrls?.pro_monthly,
          },
        };
      case 'sheets_auth':
        return { tone: 'danger', title: S.e7SheetsAuth, body: error.message, action: null };
      case 'unsupported_layout':
        return { tone: 'danger', title: 'Unrecognised layout', body: S.unsupportedLayout, action: null };
      case 'no_results':
        return { tone: 'warn', title: S.noResults, body: '', action: null };
      case 'not_signed_in':
        return { tone: 'warn', title: S.notSignedIn, body: '', action: null };
      default:
        return { tone: 'danger', title: S.unknownError, body: error.message, action: null };
    }
  });
</script>

<div class="banner {view.tone}" role="alert">
  <strong>{view.title}</strong>
  {#if view.body}<span>{view.body}</span>{/if}
  {#if view.action?.url}
    <div style="margin-top:6px">
      <a href={view.action.url} target="_blank" rel="noopener noreferrer">{view.action.label}</a>
    </div>
  {/if}
  {#if error.code === 'sheets_auth'}
    <div class="row" style="margin-top:8px">
      <button onclick={() => store.send({ type: 'pushToSheets' })}>{S.e7SheetsRetry}</button>
      <button onclick={() => store.send({ type: 'redownload' })}>{S.e7SheetsFallback}</button>
    </div>
  {/if}
</div>
