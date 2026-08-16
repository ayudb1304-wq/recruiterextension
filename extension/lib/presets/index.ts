/**
 * Bundled presets (docs/04 §6).
 *
 * ⚠️ Greenhouse and Lever header lists are DRAFTS until verified against the
 * vendors' current candidate-import docs. docs/07 Phase 4 has that as a human
 * task; docs/04 §6 says the same. Do not treat them as confirmed.
 */

import { CANDIDATE_FIELD_ORDER, type CandidateRecord } from '@recruitexport/shared';
import { getPresetOverrides } from '../storage';
import type { Preset, PresetColumn } from './types';

function field(header: string, name: keyof CandidateRecord): PresetColumn {
  return { header, source: { kind: 'field', field: name }, included: true };
}
function constant(header: string, value: string): PresetColumn {
  return { header, source: { kind: 'constant', value }, included: true };
}
function computed(header: string, id: 'notes' | 'tags' | 'fullNameOrParts'): PresetColumn {
  return { header, source: { kind: 'computed', id }, included: true };
}

/** snake_case every CandidateRecord field, in interface order. */
const GENERIC: Preset = {
  id: 'generic',
  label: 'Generic',
  description: 'Every field we extract, snake_case headers. Good for a spreadsheet.',
  columns: CANDIDATE_FIELD_ORDER.map((name) =>
    field(name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), name),
  ),
};

/** DRAFT — verify against Greenhouse's candidate-import CSV docs (Phase 4). */
const GREENHOUSE: Preset = {
  id: 'greenhouse',
  label: 'Greenhouse',
  description: 'Candidate import CSV. Header names are a draft — verify before bulk import.',
  columns: [
    field('First Name', 'firstName'),
    field('Last Name', 'lastName'),
    field('Company', 'currentCompany'),
    field('Title', 'currentTitle'),
    field('Location', 'location'),
    field('Email', 'email'),
    field('LinkedIn URL', 'profileUrl'),
    constant('Source', 'RecruitExport'),
    computed('Notes', 'notes'),
  ],
};

/** DRAFT — verify against Lever's candidate-import docs (Phase 4). */
const LEVER: Preset = {
  id: 'lever',
  label: 'Lever',
  description: 'Lever candidate import. Header names are a draft — verify before bulk import.',
  columns: [
    computed('name', 'fullNameOrParts'),
    field('email', 'email'),
    field('company', 'currentCompany'),
    field('title', 'currentTitle'),
    field('location', 'location'),
    field('links', 'profileUrl'),
    constant('origin', 'sourced'),
    computed('tags', 'tags'),
  ],
};

export const BUNDLED_PRESETS: Preset[] = [GENERIC, GREENHOUSE, LEVER];

export function bundledPreset(id: string): Preset | null {
  return BUNDLED_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * The preset as the user has it: bundled definition with their saved column
 * edits applied. "Reset to default" deletes the override (storage.ts).
 */
export async function resolvePreset(id: string): Promise<Preset> {
  const base = bundledPreset(id) ?? GENERIC;
  const overrides = await getPresetOverrides();
  const saved = overrides[base.id];
  if (!Array.isArray(saved)) return base;

  const columns = saved.filter(isPresetColumn);
  if (columns.length === 0) return base;
  return { ...base, columns };
}

export async function resolveAllPresets(): Promise<Preset[]> {
  return Promise.all(BUNDLED_PRESETS.map((p) => resolvePreset(p.id)));
}

/** Storage is untrusted input like anything else — validate before use. */
function isPresetColumn(value: unknown): value is PresetColumn {
  if (!value || typeof value !== 'object') return false;
  const col = value as Record<string, unknown>;
  if (typeof col.header !== 'string' || typeof col.included !== 'boolean') return false;
  const source = col.source as Record<string, unknown> | undefined;
  if (!source) return false;
  if (source.kind === 'field') return typeof source.field === 'string';
  if (source.kind === 'constant') return typeof source.value === 'string';
  if (source.kind === 'computed') return typeof source.id === 'string';
  return false;
}

export type { Preset, PresetColumn } from './types';
