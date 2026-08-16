<script lang="ts">
  import { EXTRACTION_HEALTH } from '@recruitexport/shared';
  import { S } from '../../../lib/strings';

  let { rate }: { rate: number } = $props();

  const tone = $derived(
    rate >= EXTRACTION_HEALTH.green ? 'ok' : rate >= EXTRACTION_HEALTH.amber ? 'warn' : 'danger',
  );
  const label = $derived(
    rate >= EXTRACTION_HEALTH.green
      ? S.healthGood
      : rate >= EXTRACTION_HEALTH.amber
        ? S.healthAmber
        : S.healthRed,
  );
</script>

<!--
  Extraction health, shown live (docs/06 §S3). We tell the user when the page
  changed under us rather than silently handing them a half-empty file.
-->
<span class="badge {tone}" title="{Math.round(rate * 100)}% of expected fields found">
  {label}
</span>
