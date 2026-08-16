/**
 * Google Sheets push (docs/01 F8, docs/02 §2.5).
 *
 * OAuth happens entirely in the browser via chrome.identity. The Google token
 * NEVER reaches our backend (docs/08 §5) — it goes straight from the extension
 * to Google's API. We ask for the `spreadsheets` scope only.
 */

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export class SheetsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetsAuthError';
  }
}

export class SheetsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SheetsApiError';
  }
}

/** `interactive: false` first so a returning user never sees a popup. */
export async function getGoogleToken(interactive: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError;
      if (err || !token) {
        reject(new SheetsAuthError(err?.message ?? 'Google sign-in was not completed.'));
        return;
      }
      resolve(typeof token === 'string' ? token : (token as { token: string }).token);
    });
  });
}

/** Drop a token Google rejected so the next attempt re-prompts cleanly. */
export async function invalidateGoogleToken(token: string): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

async function sheetsFetch<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${SHEETS_API}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new SheetsApiError(res.status, body.slice(0, 300) || `Sheets API error ${res.status}`);
  }

  return (await res.json()) as T;
}

export interface CreatedSheet {
  spreadsheetId: string;
  spreadsheetUrl: string;
}

export async function createSpreadsheet(token: string, title: string): Promise<CreatedSheet> {
  const res = await sheetsFetch<CreatedSheet>(token, '', {
    method: 'POST',
    body: JSON.stringify({ properties: { title } }),
  });
  return res;
}

/**
 * Append rows. `values` includes the header row only when the sheet is new —
 * appending twice must not produce two header rows (docs/07 Phase 3 DoD).
 */
export async function appendRows(
  token: string,
  spreadsheetId: string,
  values: readonly (readonly string[])[],
): Promise<void> {
  await sheetsFetch(
    token,
    `/${encodeURIComponent(spreadsheetId)}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      body: JSON.stringify({ values }),
    },
  );
}

interface ValuesResponse {
  values?: string[][];
}

/** True when row 1 already holds our header, so we should not write it again. */
export async function hasHeaderRow(
  token: string,
  spreadsheetId: string,
  expectedFirstHeader: string,
): Promise<boolean> {
  try {
    const res = await sheetsFetch<ValuesResponse>(
      token,
      `/${encodeURIComponent(spreadsheetId)}/values/A1:A1`,
    );
    const first = res.values?.[0]?.[0];
    return typeof first === 'string' && first.trim() === expectedFirstHeader.trim();
  } catch {
    return false;
  }
}

export function spreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

export interface PushResult {
  spreadsheetId: string;
  url: string;
  appended: number;
}

/**
 * Full push: reuse the user's chosen sheet if it still exists, otherwise create
 * one. Header written only when absent, so repeated pushes append cleanly.
 */
export async function pushToSheets(opts: {
  rows: string[][];
  existingSheetId: string | null;
  title: string;
  interactive: boolean;
}): Promise<PushResult> {
  const { rows, existingSheetId, title, interactive } = opts;
  if (rows.length === 0) throw new SheetsApiError(0, 'Nothing to push.');

  const header = rows[0] as string[];
  const body = rows.slice(1);

  let token = await getGoogleToken(interactive);

  const run = async (): Promise<PushResult> => {
    let sheetId = existingSheetId;
    let created = false;

    if (!sheetId) {
      const sheet = await createSpreadsheet(token, title);
      sheetId = sheet.spreadsheetId;
      created = true;
    }

    const needsHeader =
      created || !(await hasHeaderRow(token, sheetId, header[0] ?? ''));
    const values = needsHeader ? [header, ...body] : body;

    await appendRows(token, sheetId, values);
    return { spreadsheetId: sheetId, url: spreadsheetUrl(sheetId), appended: body.length };
  };

  try {
    return await run();
  } catch (err) {
    // A stale cached token is the common failure; drop it and retry once.
    if (err instanceof SheetsApiError && (err.status === 401 || err.status === 403)) {
      await invalidateGoogleToken(token);
      token = await getGoogleToken(true);
      return run();
    }
    throw err;
  }
}
