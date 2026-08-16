/**
 * Supabase PostgREST client.
 *
 * Deliberately hand-rolled fetch rather than @supabase/supabase-js: the Worker
 * only needs REST + RPC, and every kilobyte of bundle and every transitive
 * dependency in a service that holds a service-role key is a cost.
 *
 * The service key never leaves this Worker (docs/08 §7).
 */

import type { Env } from '../env';

export class DbError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DbError';
  }
}

export class Db {
  constructor(private readonly env: Env) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.env.SUPABASE_SERVICE_KEY,
      authorization: `Bearer ${this.env.SUPABASE_SERVICE_KEY}`,
      'content-type': 'application/json',
      ...extra,
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.env.SUPABASE_URL}/rest/v1${path}`, {
      ...init,
      headers: this.headers((init.headers ?? {}) as Record<string, string>),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new DbError(res.status, body.slice(0, 500));
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  select<T>(table: string, query: string): Promise<T[]> {
    return this.request<T[]>(`/${table}?${query}`);
  }

  async selectOne<T>(table: string, query: string): Promise<T | null> {
    const rows = await this.select<T>(table, `${query}&limit=1`);
    return rows[0] ?? null;
  }

  insert<T>(table: string, rows: unknown, returning = true): Promise<T[]> {
    return this.request<T[]>(`/${table}`, {
      method: 'POST',
      headers: { prefer: returning ? 'return=representation' : 'return=minimal' },
      body: JSON.stringify(rows),
    });
  }

  upsert<T>(table: string, rows: unknown, onConflict: string): Promise<T[]> {
    return this.request<T[]>(`/${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: { prefer: 'return=representation,resolution=merge-duplicates' },
      body: JSON.stringify(rows),
    });
  }

  update<T>(table: string, query: string, patch: unknown): Promise<T[]> {
    return this.request<T[]>(`/${table}?${query}`, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
  }

  /** Call a Postgres function (the atomic quota paths live there). */
  async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new DbError(res.status, body.slice(0, 500));
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
