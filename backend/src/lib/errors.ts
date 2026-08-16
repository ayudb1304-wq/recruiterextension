import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Error envelope from docs/05 §8. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function fail(
  status: ContentfulStatusCode,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new HttpError(status, code, message, extra);
}

export function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof HttpError) {
    return c.json({ error: err.code, message: err.message, ...err.extra }, err.status);
  }
  // Never leak internals to the client; the real error goes to the Worker log.
  console.error('unhandled', err instanceof Error ? err.message : err);
  return c.json({ error: 'internal', message: 'Something went wrong.' }, 500);
}
