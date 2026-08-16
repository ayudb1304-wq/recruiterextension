<script lang="ts">
  /**
   * The popup is only a launcher (docs/06 intro): "Open panel" + a status dot.
   * All real UI lives in the side panel.
   */
  import { S } from '../../lib/strings';

  let status = $state<'checking' | 'ready' | 'elsewhere'>('checking');

  async function check(): Promise<void> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tab?.url ?? '';
      status = /^https:\/\/www\.linkedin\.com\/(sales|talent)\//.test(url) ? 'ready' : 'elsewhere';
    } catch {
      status = 'elsewhere';
    }
  }

  async function openPanel(): Promise<void> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId !== undefined) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
    window.close();
  }

  void check();
</script>

<div class="panel" style="min-width:240px;gap:10px">
  <div class="row between">
    <strong>{S.appName}</strong>
    <span class="badge {status === 'ready' ? 'ok' : ''}">
      {status === 'checking' ? '…' : status === 'ready' ? 'Search detected' : 'No search open'}
    </span>
  </div>

  <button class="primary" onclick={openPanel}>Open panel</button>

  {#if status === 'elsewhere'}
    <p class="hint">{S.s1Body}</p>
  {/if}
</div>
