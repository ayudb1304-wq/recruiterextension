<script lang="ts">
  let {
    label,
    used,
    cap,
  }: { label: string; used: number; cap: number } = $props();

  const pct = $derived(cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0);
  const tone = $derived(pct >= 100 ? 'danger' : pct >= 85 ? 'warn' : '');
</script>

<div class="field">
  <div class="row between">
    <span>{label}</span>
    <span class="hint">{used.toLocaleString()} / {cap.toLocaleString()}</span>
  </div>
  <div
    class="meter {tone}"
    role="progressbar"
    aria-label={label}
    aria-valuenow={used}
    aria-valuemin="0"
    aria-valuemax={cap}
  >
    <div style="width: {pct}%"></div>
  </div>
</div>
