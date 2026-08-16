/**
 * Every user-facing string (docs/06 §3).
 *
 * Tone: direct, zero hype, recruiter-respectful. Say what happened and what to
 * do next. Never "AI-powered". Never promise LinkedIn immunity — "account-safe
 * mode" describes our limits, not a guarantee.
 *
 * One file so copy tweaks and future i18n are trivial.
 */

export const S = {
  appName: 'Recruiter Export',

  // ── S1: not on a supported page ────────────────────────────────────────────
  s1Title: 'Nothing to export yet',
  s1Body: "Open a Sales Navigator or Recruiter people search and I'll take it from there.",
  s1Demo: 'See a 60-sec demo',

  // ── sign in ────────────────────────────────────────────────────────────────
  signInTitle: 'Sign in',
  signInBody: 'We email you a link. No password to remember, and never your LinkedIn password.',
  signInPlaceholder: 'you@agency.com',
  signInButton: 'Email me a link',
  signInSent: 'Check your inbox — the link is good for 15 minutes.',
  signOut: 'Sign out',

  // ── S2: ready ──────────────────────────────────────────────────────────────
  s2SalesNav: 'Sales Navigator search',
  s2Recruiter: 'Recruiter search',
  s2RowsLabel: 'Rows to export',
  s2RowsHelp: (remaining: number) => `${remaining.toLocaleString()} left on your plan`,
  s2Enrich: 'Find & verify emails',
  s2EnrichLocked: 'Verified emails are on Pro',
  s2SkipDupes: 'Skip candidates I have already exported',
  s2Preset: 'Format',
  s2EditPresets: 'Edit formats…',
  s2Destination: 'Send to',
  s2DestinationCsv: 'CSV download',
  s2DestinationSheets: 'Google Sheets',
  s2Export: (n: number) => `Export ${n.toLocaleString()} candidates`,
  s2ResultsFound: (n: number) => `about ${n.toLocaleString()} results on this search`,

  // Always visible. This is positioning, not fine print (docs/06 §S2).
  safeModeFooter: 'Account-safe mode: human-speed paging, max 1,000 rows/day.',
  safeModeExplainer:
    'We page through results at reading speed with randomized pauses, cap the day, and stop the moment LinkedIn shows a check. Slower on purpose.',

  // ── S3: running ────────────────────────────────────────────────────────────
  s3Progress: (page: number, total: number | null, rows: number, enriched: number) =>
    `Page ${page}${total ? ` of ${total}` : ''} · ${rows} candidates${enriched ? ` · ${enriched} enriched` : ''}`,
  s3Cancel: 'Stop and keep what I have',
  healthGood: 'Extraction healthy',
  healthAmber: 'Some fields missing',
  healthRed: 'Layout changed — capturing what I can',

  // ── S4: done ───────────────────────────────────────────────────────────────
  s4Title: 'Export ready',
  s4Summary: (rows: number, dupes: number) =>
    `${rows.toLocaleString()} candidates${dupes ? ` · ${dupes} duplicates skipped` : ''}`,
  s4Download: 'Download CSV',
  s4OpenSheet: 'Open Sheet',
  s4RunAgain: 'Run again',
  s4PartialPrefix: 'Partial export:',
  reviewAsk: 'Saved you an hour? A Chrome Web Store review keeps this tool alive →',
  reviewAskDismiss: 'Do not ask again',

  // ── S5: account ────────────────────────────────────────────────────────────
  accountTitle: 'Account',
  planFree: 'Free',
  planPro: 'Pro',
  usageMonth: (used: number, cap: number) =>
    `${used.toLocaleString()} of ${cap.toLocaleString()} rows this month`,
  usage24h: (used: number, cap: number) =>
    `${used.toLocaleString()} of ${cap.toLocaleString()} rows in the last 24h`,
  manageBilling: 'Manage billing',
  upgradeMonthly: 'Upgrade — $39/mo',
  upgradeAnnual: 'Upgrade — $390/yr',
  settingsTitle: 'Settings',
  telemetryToggle: 'Send anonymous health stats',
  telemetryHelp:
    'Counts and success rates only — never candidate data, names, emails or your searches. Helps us notice when LinkedIn changes their page before you do.',
  clearHistory: 'Clear export history',
  clearHistoryHelp:
    'Deletes the local list of candidates you have already exported. Only hashes are stored, never candidate data.',

  // ── S6: preset editor ──────────────────────────────────────────────────────
  presetEditorTitle: 'Edit format',
  presetColumn: 'Column',
  presetField: 'Field',
  presetInclude: 'Include',
  presetSave: 'Save',
  presetReset: 'Reset to default',
  presetDraftWarning:
    'Greenhouse and Lever headers are unverified drafts — check them against a test import first.',

  // ── error & edge states (docs/06 §2) ───────────────────────────────────────
  e1QuotaMonth: (cap: number, resets: string) =>
    `You have used your ${cap.toLocaleString()} rows for this month. Resets ${resets}.`,
  e2Rolling: (time: string) =>
    `Account-safe limit reached (1,000 rows/24h). Try again after ${time}.`,
  e3Offline:
    'Cannot reach our server. You can still export a plain CSV within your cached limit — email finding is off until we reconnect.',
  e4PlatformWarning: (n: number) =>
    `LinkedIn showed an unusual-activity check, so I stopped to protect your account. Your ${n.toLocaleString()} rows so far are saved.`,
  e4NoRetry: 'I will not retry automatically. Give it a few hours before running another export.',
  e5NonEnglish: (lang: string) =>
    `Your LinkedIn is set to ${lang}. v1 extracts English UI only — switch language or expect missing fields.`,
  e6EnrichLocked: 'Verified emails are on Pro — $39/mo, cancel anytime.',
  e7SheetsAuth: 'Google sign-in did not complete.',
  e7SheetsRetry: 'Try again',
  e7SheetsFallback: 'Download CSV instead',

  unsupportedLayout:
    'This looks like a search page, but the layout is one I do not recognise yet. Nothing was exported. This is usually fixed within a day — health stats tell us automatically.',
  noResults: 'No results found on this page.',
  notSignedIn: 'Sign in to export.',
  unknownError: 'Something went wrong. Nothing was sent anywhere.',

  // ── honesty copy used in the panel footer and the store listing ────────────
  dataPromise: 'Your candidate data never touches our servers. It goes from your browser to your file.',
  notAffiliated: 'Not affiliated with LinkedIn.',
} as const;

export type Strings = typeof S;
