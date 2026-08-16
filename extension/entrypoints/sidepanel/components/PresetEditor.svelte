<script lang="ts">
  import { CANDIDATE_FIELD_ORDER } from '@recruitexport/shared';
  import { BUNDLED_PRESETS, bundledPreset, resolvePreset } from '../../../lib/presets';
  import type { PresetColumn } from '../../../lib/presets/types';
  import { clearPresetOverride, savePresetOverride } from '../../../lib/storage';
  import { S } from '../../../lib/strings';
  import { store } from '../store.svelte';

  let presetId = $state(store.snapshot.settings.defaultPreset);
  let columns = $state<PresetColumn[]>([]);
  let dirty = $state(false);

  $effect(() => {
    const id = presetId;
    void resolvePreset(id).then((preset) => {
      columns = structuredClone(preset.columns);
      dirty = false;
    });
  });

  function move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= columns.length) return;
    const next = [...columns];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);
    columns = next;
    dirty = true;
  }

  async function save(): Promise<void> {
    await savePresetOverride(presetId, columns);
    dirty = false;
    store.showToast('success', 'Format saved.');
  }

  async function reset(): Promise<void> {
    await clearPresetOverride(presetId);
    const base = bundledPreset(presetId);
    columns = base ? structuredClone(base.columns) : [];
    dirty = false;
    store.showToast('info', 'Reset to the default format.');
  }

  function fieldLabel(column: PresetColumn): string {
    if (column.source.kind === 'field') return column.source.field;
    if (column.source.kind === 'constant') return `constant "${column.source.value}"`;
    return `computed: ${column.source.id}`;
  }
</script>

<!-- S6 — preset editor (docs/06 §S6) -->
<section class="panel">
  <h1>{S.presetEditorTitle}</h1>

  <div class="field">
    <label for="preset-select">Format</label>
    <select id="preset-select" bind:value={presetId}>
      {#each BUNDLED_PRESETS as preset (preset.id)}
        <option value={preset.id}>{preset.label}</option>
      {/each}
    </select>
    <span class="hint">{bundledPreset(presetId)?.description ?? ''}</span>
  </div>

  {#if presetId !== 'generic'}
    <div class="banner warn" role="status">{S.presetDraftWarning}</div>
  {/if}

  <table>
    <thead>
      <tr>
        <th scope="col">{S.presetInclude}</th>
        <th scope="col">{S.presetColumn}</th>
        <th scope="col">{S.presetField}</th>
        <th scope="col"><span class="sr-only">Reorder</span></th>
      </tr>
    </thead>
    <tbody>
      {#each columns as column, i (column.header + i)}
        <tr>
          <td>
            <input
              type="checkbox"
              bind:checked={column.included}
              onchange={() => (dirty = true)}
              aria-label="Include {column.header}"
            />
          </td>
          <td>
            <input
              type="text"
              bind:value={column.header}
              oninput={() => (dirty = true)}
              aria-label="Header for {fieldLabel(column)}"
            />
          </td>
          <td class="hint">{fieldLabel(column)}</td>
          <td>
            <button
              type="button"
              onclick={() => move(i, -1)}
              disabled={i === 0}
              aria-label="Move {column.header} up">↑</button
            >
            <button
              type="button"
              onclick={() => move(i, 1)}
              disabled={i === columns.length - 1}
              aria-label="Move {column.header} down">↓</button
            >
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

  <p class="hint">
    Available fields: {CANDIDATE_FIELD_ORDER.join(', ')}
  </p>

  <div class="row">
    <button class="primary" style="width:auto" onclick={save} disabled={!dirty}>{S.presetSave}</button>
    <button onclick={reset}>{S.presetReset}</button>
    <button onclick={() => store.go('main')}>Back</button>
  </div>
</section>
