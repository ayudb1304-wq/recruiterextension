/**
 * Dedupe hashing (docs/04 §3).
 *
 * dedupeHash = sha256(lowercase(canonicalProfileUrl || fullName + '|' + currentCompany))
 *
 * Only hashes are ever stored — never candidate data (docs/04 §5). The hash
 * never leaves the user's browser: the backend does not receive it.
 */

import { canonicalizeProfileUrl } from './normalize';

export function dedupeKey(input: {
  profileUrl: string | null;
  fullName: string | null;
  currentCompany: string | null;
}): string | null {
  const canonical = canonicalizeProfileUrl(input.profileUrl);
  if (canonical) return canonical.toLowerCase();

  const name = input.fullName?.trim();
  if (!name) return null;
  const company = input.currentCompany?.trim() ?? '';
  return `${name}|${company}`.toLowerCase();
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * A record with neither a URL nor a name cannot be deduped meaningfully; we
 * give it a random-but-stable-for-this-row hash so it is never silently
 * swallowed as a duplicate of another blank row.
 */
export async function computeDedupeHash(input: {
  profileUrl: string | null;
  fullName: string | null;
  currentCompany: string | null;
  fallbackSeed: string;
}): Promise<string> {
  const key = dedupeKey(input) ?? `unkeyed:${input.fallbackSeed}`;
  return sha256Hex(key);
}

/**
 * Fixed-size ring buffer of seen hashes for the cross-job history
 * (docs/04 §3 — last 25,000).
 */
export class HashRingBuffer {
  private readonly order: string[];
  private readonly set: Set<string>;

  constructor(
    private readonly capacity: number,
    initial: readonly string[] = [],
  ) {
    this.order = initial.slice(-capacity);
    this.set = new Set(this.order);
  }

  has(hash: string): boolean {
    return this.set.has(hash);
  }

  add(hash: string): void {
    if (this.set.has(hash)) return;
    this.set.add(hash);
    this.order.push(hash);
    while (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.set.delete(evicted);
    }
  }

  get size(): number {
    return this.order.length;
  }

  toArray(): string[] {
    return this.order.slice();
  }
}
