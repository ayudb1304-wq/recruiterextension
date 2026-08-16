/**
 * ATS export presets (docs/04 §6).
 *
 * A preset is an ordered column list mapping CandidateRecord fields to output
 * headers. Presets are DATA — user-editable in the panel (reorder / rename /
 * exclude), saved to chrome.storage.sync, resettable to the bundled JSON.
 */

import type { CandidateRecord } from '@recruitexport/shared';

export type ColumnSource =
  | { kind: 'field'; field: keyof CandidateRecord }
  | { kind: 'constant'; value: string }
  /** Small registry of derived columns — see presets/computed.ts. */
  | { kind: 'computed'; id: ComputedColumnId };

export type ComputedColumnId = 'notes' | 'tags' | 'fullNameOrParts';

export interface PresetColumn {
  /** Output header text, exactly as the ATS expects it. */
  header: string;
  source: ColumnSource;
  /** User can exclude a column without deleting it. */
  included: boolean;
}

export interface Preset {
  id: string;
  label: string;
  /** Shown under the preset picker — say what the file is for. */
  description: string;
  columns: PresetColumn[];
}
